// 평가 실행의 몸통. 문서마다 뽑기 1회 → 같은 호출에서 세 방식을 채점한다.
// DB 와 파일을 모른다. 장부(LlmCallStore)와 공급자를 넘겨받는다. 시험에서는 메모리 장부와 가짜 공급자를 넘긴다.
import type { DraftEvaluation } from '@/contract/core-api';
import {
  EVAL_METHODS,
  type EvalCell,
  type EvalEstimate,
  type EvalMethod,
  type EvalMetrics,
  type GoldDoc,
  type GoldSplit,
  type ReviewVerdict,
} from '@/contract/eval-types';
import type { Extraction, FieldKey } from '@/contract/fields';
import { isLlmUnavailable, type LlmCallStore, type LlmProvider, type LlmRequest, type LlmUnavailableCode, type LlmUsage } from '@/contract/llm-types';
import { hasBlocking } from '@/contract/reasons';
import { evaluateDraft, rulesExtract } from '@/core';
import { cacheKeyFor, createProvider } from '@/llm';
import { cleanText } from '@/server/limits';
import { computeMetrics, gradeDoc, type CallStat, type MethodOutput } from './metrics';

// ── 채점할 문서 고르기 ─────────────────────────────────────

export interface ReviewLine {
  goldDocId: string;
  pass: 1 | 2;
  verdict: ReviewVerdict;
}

export interface Selection {
  docs: GoldDoc[];
  /** 확인 기록이 없어 뺀 문서 수 */
  excludedUnreviewed: number;
  /** 버림 판정이라 뺀 문서 수 */
  excludedDropped: number;
  /** 확인 전 문서가 채점에 들어갔는가 */
  includesUnreviewed: boolean;
}

/**
 * 사람이 확인한 문서만 고른다: 가장 최근 첫 확인(pass = 1)의 판정이 ok 또는 fixed.
 * 확인 기록은 적힌 순서대로 넘긴다(뒤에 나온 줄이 더 최근이다).
 * includeUnreviewed 면 확인 기록이 없는 문서도 넣는다. 버림 판정 문서는 그래도 뺀다.
 */
export function selectDocs(docs: readonly GoldDoc[], reviews: readonly ReviewLine[], options: { includeUnreviewed?: boolean } = {}): Selection {
  const latest = new Map<string, ReviewVerdict>();
  for (const r of reviews) if (r.pass === 1) latest.set(r.goldDocId, r.verdict);

  const out: Selection = { docs: [], excludedUnreviewed: 0, excludedDropped: 0, includesUnreviewed: false };
  for (const doc of [...docs].sort((a, b) => a.id.localeCompare(b.id))) {
    const verdict = latest.get(doc.id);
    if (verdict === 'dropped') out.excludedDropped += 1;
    else if (verdict === undefined && !options.includeUnreviewed) out.excludedUnreviewed += 1;
    else {
      if (verdict === undefined) out.includesUnreviewed = true;
      out.docs.push(doc);
    }
  }
  return out;
}

// ── 세 방식의 답 만들기 ────────────────────────────────────

function fromEvaluation(ev: DraftEvaluation): MethodOutput {
  const values: MethodOutput['values'] = {};
  const fieldFlags: MethodOutput['fieldFlags'] = {};
  for (const f of ev.fields) {
    values[f.field] = f.finalValue;
    fieldFlags[f.field] = hasBlocking(f.reasons);
  }
  return {
    type: ev.type,
    subtype: ev.subtype,
    values,
    fieldFlags,
    // 문서의 표시: 칸이든 초안 전체든 막는 사유가 하나라도 있다.
    docFlagged: hasBlocking(ev.draftReasons) || ev.fields.some((f) => hasBlocking(f.reasons)),
  };
}

/** 답을 못 받았을 때의 빈 답. 종류가 틀린 것으로, 칸은 모두 "없음"으로 채점된다. */
const noAnswer = (docFlagged: boolean): MethodOutput => ({ type: null, subtype: null, values: {}, fieldFlags: {}, docFlagged });

/**
 * 같은 원문, 같은 뽑기 답에서 세 방식의 답을 만든다.
 * - rules: 정규식으로 찾은 원문 표현을 코드가 맞춘 값. "규칙만으로 뽑음" 사유는 여기서 붙지 않으므로 표시로 세지 않는다.
 * - llm_only: 모델이 읽은 값 그대로. 표시 없음.
 * - llm_code: 초안에 실리는 값(코드가 맞춘 값, 없으면 모델 값)과 그 표시.
 * extraction 이 null 이면(호출 실패) llm 두 방식은 빈 답이다. llm_code 는 표시가 붙은 것으로 친다(사람에게 간다).
 */
export function methodOutputs(sourceText: string, extraction: Extraction | null): Record<EvalMethod, MethodOutput> {
  const rules = fromEvaluation(evaluateDraft({ sourceText, extraction: rulesExtract(sourceText), extractedBy: 'rules' }));
  if (!extraction) return { rules, llm_only: noAnswer(false), llm_code: noAnswer(true) };

  const modelValues: Partial<Record<FieldKey, unknown>> = {};
  for (const f of extraction.fields) modelValues[f.field] = f.value;
  return {
    rules,
    llm_only: { type: extraction.type, subtype: extraction.subtype, values: modelValues, fieldFlags: {}, docFlagged: false },
    llm_code: fromEvaluation(evaluateDraft({ sourceText, extraction, extractedBy: 'llm' })),
  };
}

// ── 돌리기 ─────────────────────────────────────────────────

export interface CallDetail extends CallStat {
  inputTokens: number;
  outputTokens: number;
}

export interface CallFailure {
  goldDocId: string;
  code: LlmUnavailableCode;
}

export interface RunnerDeps {
  model: string;
  /** 프롬프트 판마다 다르다. 정리한 원문을 받아 뽑기 요청을 만든다. */
  buildRequest: (cleanText: string) => LlmRequest<Extraction>;
  /** 장부. 여기 답이 있으면 부르지 않는다. */
  store: LlmCallStore;
  /** 실제로 부르는 공급자. null 이면 장부에 있는 것만 쓴다(없으면 CACHE_MISS 로 적는다). 답은 공급자가 장부에 적는다. */
  live: LlmProvider | null;
  /** 이번 실행에서 실제로 쓸 수 있는 돈(달러). null 이면 상한 없음. */
  maxUsd: number | null;
  /** 토큰 수로 비용을 낸다. */
  priceUsd: (usage: LlmUsage) => number;
  onDoc?: (line: string) => void;
}

export interface RunOutcome {
  /** 채점을 끝낸 문서 번호(순서대로) */
  docIds: string[];
  cells: Record<EvalMethod, EvalCell[]>;
  calls: CallDetail[];
  failures: CallFailure[];
  /** 이번 실행에서 실제로 쓴 돈. 장부에서 읽은 답은 0. 답을 못 쓴 호출의 토큰도 센다. */
  spentUsd: number;
  stoppedByBudget: boolean;
  /** 상한에 걸려 손대지 못한 문서 번호 */
  notRun: string[];
}

/**
 * 문서를 차례로 돌린다.
 * 상한(maxUsd): 실제 호출을 하기 전에 본다. 이미 쓴 돈이 상한 이상이거나,
 * 지금까지 가장 비쌌던 한 건만큼 더 쓰면 상한을 넘을 때 멈춘다. 끝난 데까지는 그대로 돌려준다.
 * 실패한 호출은 다시 부르지 않는다. 다시 돌리면 장부에 있는 건은 그냥 읽으므로 실패한 건만 다시 부르게 된다.
 */
export async function runDocs(docs: readonly GoldDoc[], deps: RunnerDeps): Promise<RunOutcome> {
  const replay = createProvider({ kind: 'replay', model: deps.model, store: deps.store });
  const out: RunOutcome = {
    docIds: [],
    cells: { rules: [], llm_only: [], llm_code: [] },
    calls: [],
    failures: [],
    spentUsd: 0,
    stoppedByBudget: false,
    notRun: [],
  };
  let dearest = 0;

  for (let i = 0; i < docs.length; i += 1) {
    const doc = docs[i]!;
    const sourceText = cleanText(doc.content);
    const req = deps.buildRequest(sourceText);
    const cached = await deps.store.find(cacheKeyFor(req as LlmRequest<unknown>, deps.model));
    const inLedger = cached !== null && cached.provider !== 'fake';

    if (!inLedger && deps.live && deps.maxUsd !== null) {
      const over = out.spentUsd >= deps.maxUsd || (dearest > 0 && out.spentUsd + dearest > deps.maxUsd);
      if (over) {
        out.stoppedByBudget = true;
        out.notRun = docs.slice(i).map((d) => d.id);
        break;
      }
    }

    let extraction: Extraction | null = null;
    let note: string;
    try {
      const provider = inLedger ? replay : deps.live;
      if (!provider) {
        out.failures.push({ goldDocId: doc.id, code: 'CACHE_MISS' });
        note = '녹화 없음';
      } else {
        const result = await provider.complete(req);
        extraction = result.output;
        const cost = deps.priceUsd(result.usage);
        if (!result.recorded) {
          out.spentUsd += cost;
          dearest = Math.max(dearest, cost);
        }
        out.calls.push({
          goldDocId: doc.id,
          costUsd: cost,
          latencyMs: result.latencyMs,
          recorded: result.recorded,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        });
        note = result.recorded ? '장부에서 읽음' : `실제 호출 ${result.usage.inputTokens}+${result.usage.outputTokens}토큰 ${result.latencyMs}ms`;
      }
    } catch (err) {
      if (!isLlmUnavailable(err)) throw err;
      // 답은 못 썼어도 토큰이 나갔으면 돈이다.
      if (err.usage) {
        const cost = deps.priceUsd(err.usage);
        out.spentUsd += cost;
        dearest = Math.max(dearest, cost);
      }
      out.failures.push({ goldDocId: doc.id, code: err.code });
      note = `답을 못 받음(${err.code})`;
    }

    const outputs = methodOutputs(sourceText, extraction);
    for (const method of EVAL_METHODS) out.cells[method].push(...gradeDoc(doc, outputs[method]));
    out.docIds.push(doc.id);
    deps.onDoc?.(`  ${doc.id}  ${note}`);
  }
  out.spentUsd = Math.round(out.spentUsd * 1e9) / 1e9;
  return out;
}

/** 방식별 지표. rules 는 6번(비용·시간)을, llm_only 는 4번·5번(표시)을 내지 않는다. */
export function metricsByMethod(outcome: Pick<RunOutcome, 'cells' | 'calls'>): Record<EvalMethod, EvalMetrics> {
  return {
    rules: computeMetrics(outcome.cells.rules, { hasFlags: true }),
    llm_only: computeMetrics(outcome.cells.llm_only, { hasFlags: false, calls: outcome.calls }),
    llm_code: computeMetrics(outcome.cells.llm_code, { hasFlags: true, calls: outcome.calls }),
  };
}

// ── 돌리기 전의 어림 ───────────────────────────────────────

/**
 * 장부가 비었을 때 쓰는 건당 어림 토큰.
 * 연습 세트 3건을 프롬프트 v1 로 실제로 불러 잰 값(건당 입력 약 4,600, 출력 85~1,723)을 넉넉히 잡은 것이다.
 * 어림일 뿐이다. 돌린 뒤의 숫자는 실행 기록에서 읽는다. 프롬프트가 길어지면 다시 잰다.
 */
export const GUESS_USAGE: LlmUsage = { inputTokens: 4700, outputTokens: 1200 };

/** 돌리기 전에 대상 건수, 장부에 있는 건수, 어림 비용을 낸다. 키가 필요 없다. */
export async function estimateRun(
  split: GoldSplit,
  docs: readonly GoldDoc[],
  deps: Pick<RunnerDeps, 'model' | 'buildRequest' | 'store' | 'priceUsd'>,
): Promise<EvalEstimate> {
  let cached = 0;
  let ledgerCost = 0;
  for (const doc of docs) {
    const req = deps.buildRequest(cleanText(doc.content));
    const hit = await deps.store.find(cacheKeyFor(req as LlmRequest<unknown>, deps.model));
    if (hit && hit.provider !== 'fake') {
      cached += 1;
      ledgerCost += deps.priceUsd({ inputTokens: hit.inputTokens, outputTokens: hit.outputTokens });
    }
  }
  const toCall = docs.length - cached;
  const basis: EvalEstimate['basis'] = cached > 0 ? 'ledger_average' : 'default_guess';
  const perDoc = cached > 0 ? ledgerCost / cached : deps.priceUsd(GUESS_USAGE);
  return { split, docs: docs.length, cached, toCall, estCostUsd: Math.round(perDoc * toCall * 1e6) / 1e6, basis };
}
