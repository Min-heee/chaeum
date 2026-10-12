// 회귀 문지기. npm run verify 의 마지막 단계다.
// 녹화본(data/recordings)으로 연습 세트를 다시 채점해, "전부 맞은 문서 수"가 기준(eval/baseline.json) 아래면 실패한다.
// 모델을 부르지 않는다. DB 에 적지 않는다. 돈이 들지 않는다.
//
//   npm run eval:replay                       기준과 견준다
//   npm run eval:replay -- --write-baseline   지금 결과를 기준으로 적는다(녹화본이 다 있어야 한다)
//   npm run eval:replay -- --ledger           녹화 파일에 더해 DB 장부도 본다
//
// 끝나는 꼴
// - 기준 파일이 없다: "기준 없음"을 크게 찍고 통과(exit 0). 아무것도 지키지 않았다는 뜻이다.
// - 프롬프트·모델·정답 버전·문서 수가 기준과 다르거나 녹화본이 없는 문서가 있다: "다시 녹화 필요"로 실패(exit 1).
// - 전부 맞은 문서 수가 기준보다 적다: 실패(exit 1).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { EvalBaseline, GoldDoc } from '@/contract/eval-types';
import { DEFAULT_LLM_MODEL, type LlmCallStore } from '@/contract/llm-types';
import { buildExtractRequest, costUsd, JsonlCallStore } from '@/llm';
import { BASELINE_FILE, ChainStore, gitCommit, goldVersionOf, loadReviews, loadSplit, parseArgs, RECORDINGS_DIR } from './io';
import { formatRatio, wrongDocs } from './metrics';
import type { ExtractBuilder } from './prompts';
import { metricsByMethod, runDocs, selectDocs, type RunOutcome } from './runner';

export type GateStatus =
  | 'no_baseline' // 기준 없음. 통과하지만 아무것도 지키지 않았다
  | 'no_docs' // 채점할 문서가 없다(확인 기록 없음)
  | 'needs_rerecord' // 프롬프트·모델·정답 버전·문서 수가 다르거나 녹화본이 없다
  | 'regressed' // 기준 아래
  | 'ok';

export interface GateResult {
  status: GateStatus;
  exitCode: 0 | 1;
  lines: string[];
  outcome: RunOutcome | null;
  /** 지금 결과로 만든 기준. 녹화본이 다 있을 때만 */
  nextBaseline: Omit<EvalBaseline, 'gitCommit' | 'recordedOn'> | null;
}

export interface GateInput {
  docs: readonly GoldDoc[];
  excludedUnreviewed: number;
  baseline: EvalBaseline | null;
  /** 기준이 없을 때 쓰는 모델 이름 */
  model: string;
  build: ExtractBuilder;
  store: LlmCallStore;
}

/** 문지기의 판단. 파일도 DB 도 모른다(시험에서 메모리 장부로 돌린다). */
export async function checkGate(input: GateInput): Promise<GateResult> {
  const { baseline, docs } = input;
  const lines: string[] = [];
  const model = baseline?.model ?? input.model;
  const promptVersion = input.build('').promptVersion;
  const fail = (status: GateStatus, outcome: RunOutcome | null = null): GateResult => ({ status, exitCode: 1, lines, outcome, nextBaseline: null });

  if (baseline && baseline.promptVersion !== promptVersion) {
    lines.push(`다시 녹화 필요: 프롬프트 버전이 기준과 다르다(기준 ${baseline.promptVersion}, 지금 ${promptVersion}). npm run eval 로 다시 돌리고 기준을 새로 적는다.`);
    return fail('needs_rerecord');
  }
  if (docs.length === 0) {
    lines.push(`채점할 문서 0건: 사람이 확인한 문서가 없다(확인 기록 없어 뺌 ${input.excludedUnreviewed}건).`);
    if (baseline) {
      lines.push(`기준은 ${baseline.docs}건을 채점한 것이다. 확인 기록 파일이 사라졌는지 본다.`);
      return fail('no_docs');
    }
    lines.push('기준 없음 — 첫 실행 뒤 만든다. 재채점 0건. 이 단계는 지금 아무것도 지키지 않는다.');
    return { status: 'no_baseline', exitCode: 0, lines, outcome: null, nextBaseline: null };
  }

  const goldVersion = goldVersionOf(docs);
  if (baseline && baseline.goldVersion !== goldVersion) {
    lines.push(`다시 녹화 필요: 정답 버전이 기준과 다르다(기준 v${baseline.goldVersion}, 지금 v${goldVersion}). 다시 채점하고 기준을 새로 적는다.`);
    return fail('needs_rerecord');
  }
  if (baseline && baseline.docs !== docs.length) {
    lines.push(`다시 녹화 필요: 채점할 문서 수가 기준과 다르다(기준 ${baseline.docs}건, 지금 ${docs.length}건). 기준을 새로 적는다.`);
    return fail('needs_rerecord');
  }

  const outcome = await runDocs(docs, {
    model,
    buildRequest: input.build,
    store: input.store,
    live: null,
    maxUsd: null,
    priceUsd: (usage) => costUsd(model, usage),
  });
  const missing = outcome.failures.filter((f) => f.code === 'CACHE_MISS').map((f) => f.goldDocId);
  const broken = outcome.failures.filter((f) => f.code !== 'CACHE_MISS');
  lines.push(`녹화본으로 다시 채점: ${docs.length}건 가운데 녹화본 있음 ${docs.length - outcome.failures.length}건 (모델 ${model}, 프롬프트 ${promptVersion}, 정답 v${goldVersion})`);

  if (outcome.failures.length > 0) {
    if (missing.length > 0) lines.push(`녹화본이 없는 문서 ${missing.length}건: ${missing.join(', ')}`);
    if (broken.length > 0) lines.push(`녹화본을 못 읽은 문서 ${broken.length}건: ${broken.map((f) => `${f.goldDocId}(${f.code})`).join(', ')}`);
    if (baseline) {
      lines.push('다시 녹화 필요: 프롬프트·스키마·모델이 바뀌면 장부의 키가 달라진다. npm run eval -- --split dev 로 다시 녹화한다. 조용히 빼고 채점하지 않는다.');
      return fail('needs_rerecord', outcome);
    }
    lines.push('기준 없음 — 첫 실행 뒤 만든다. 녹화본이 다 모이지 않아 기준을 적을 수도 없다. 이 단계는 지금 아무것도 지키지 않는다.');
    return { status: 'no_baseline', exitCode: 0, lines, outcome, nextBaseline: null };
  }

  const metrics = metricsByMethod(outcome).llm_code;
  const allCorrect = metrics.docsAllCorrect.num;
  lines.push(`전부 맞은 문서(llm_code): ${formatRatio(metrics.docsAllCorrect)} — 연습 세트의 숫자다. 바깥에 내세우지 않는다.`);
  const nextBaseline = { split: 'dev', method: 'llm_code', model, promptVersion, goldVersion, docs: docs.length, docsAllCorrect: allCorrect } as const;

  if (!baseline) {
    lines.push('기준 없음 — 첫 실행 뒤 만든다. 지금 결과를 기준으로 적으려면: npm run eval:replay -- --write-baseline');
    return { status: 'no_baseline', exitCode: 0, lines, outcome, nextBaseline };
  }
  if (allCorrect < baseline.docsAllCorrect) {
    lines.push(`기준 아래: 전부 맞은 문서가 ${baseline.docsAllCorrect}건에서 ${allCorrect}건으로 줄었다(기준 커밋 ${baseline.gitCommit}).`);
    for (const doc of wrongDocs(outcome.cells.llm_code)) {
      lines.push(`  ${doc.goldDocId}: ${doc.errors.map((c) => `${c.field} ${c.verdict}`).join(', ')}`);
    }
    return fail('regressed', outcome);
  }
  lines.push(`기준 통과: 기준 ${baseline.docsAllCorrect}건 이상(지금 ${allCorrect}건).`);
  if (allCorrect > baseline.docsAllCorrect) lines.push('기준보다 나아졌다. 기준을 올리려면 --write-baseline 으로 다시 적는다.');
  return { status: 'ok', exitCode: 0, lines, outcome, nextBaseline };
}

function readBaseline(file: string): EvalBaseline | null {
  if (!existsSync(file)) return null;
  const b = JSON.parse(readFileSync(file, 'utf8')) as Partial<EvalBaseline>;
  const ok =
    b.split === 'dev' && b.method === 'llm_code' && typeof b.model === 'string' && typeof b.promptVersion === 'string' &&
    Number.isInteger(b.goldVersion) && Number.isInteger(b.docs) && Number.isInteger(b.docsAllCorrect);
  if (!ok) throw new Error(`${file} 의 꼴이 다르다(EvalBaseline)`);
  return b as EvalBaseline;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, ['--model'], ['--write-baseline', '--include-unreviewed', '--ledger']);
  const all = await loadSplit('dev', { sealedPath: null, sealedFlag: false });
  const selection = selectDocs(all, await loadReviews(), { includeUnreviewed: args.flags.has('--include-unreviewed') });
  if (selection.includesUnreviewed) console.log('[eval:replay] ※ 확인 전 포함: 사람이 확인하지 않은 문서가 채점에 들어간다.');

  const readers: LlmCallStore[] = [new JsonlCallStore(RECORDINGS_DIR)];
  let closeDb: (() => Promise<void>) | null = null;
  if (args.flags.has('--ledger')) {
    const { closePool, getPool } = await import('@/server/db');
    const { PgLlmCallStore } = await import('@/server/repos/llm-calls');
    readers.push(new PgLlmCallStore({ db: getPool() }));
    closeDb = closePool;
  }

  try {
    const baseline = readBaseline(BASELINE_FILE);
    const result = await checkGate({
      docs: selection.docs,
      excludedUnreviewed: selection.excludedUnreviewed,
      baseline: args.flags.has('--write-baseline') ? null : baseline,
      model: args.values.get('--model') ?? (process.env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL),
      build: buildExtractRequest,
      store: new ChainStore(readers, []),
    });
    for (const line of result.lines) (result.exitCode === 0 && result.status === 'ok' ? console.log : console.warn)(`[eval:replay] ${line}`);

    if (args.flags.has('--write-baseline')) {
      if (!result.nextBaseline) {
        console.error('[eval:replay] 기준을 적지 못했다: 채점할 문서가 없거나 녹화본이 모자란다.');
        return 1;
      }
      if (selection.includesUnreviewed) {
        console.error('[eval:replay] 기준을 적지 않았다: 확인 전 문서가 들어 있는 결과는 기준으로 쓰지 않는다.');
        return 1;
      }
      const next: EvalBaseline = { ...result.nextBaseline, gitCommit: gitCommit(), recordedOn: new Date().toISOString().slice(0, 10) };
      writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      console.log(`[eval:replay] 기준을 적었다: ${BASELINE_FILE} (전부 맞은 문서 ${next.docsAllCorrect}/${next.docs})`);
      return 0;
    }
    return result.exitCode;
  } finally {
    await closeDb?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`[eval:replay] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
