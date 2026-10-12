// 일치 판정과 지표 여섯. 기준은 docs/EVAL-SPEC.md, 꼴은 src/contract/eval-types.ts.
// 전부 순수 함수다. DB, 네트워크, 시각, 난수를 쓰지 않는다.
// 검사기의 견주기(src/core/checks/mismatch.ts)를 쓰지 않는다. 채점의 허용 오차는 여기서 따로 정한다.
import {
  CLASS_FIELDS,
  ERROR_VERDICTS,
  isDocAllCorrect,
  type ClassField,
  type EvalCell,
  type EvalMetrics,
  type GoldDoc,
  type Ratio,
  type Verdict,
} from '@/contract/eval-types';
import { fieldDef, FIELDS_BY_TYPE, isFieldKey, type DocType, type FieldKey } from '@/contract/fields';

// ── 글자 정리 ──────────────────────────────────────────────

const BRACKETS = /[()[\]{}<>「」『』【】]/g;

/** 이름 칸의 글자 정리: NFKC → 소문자 → 괄호 글자 지움(안의 글은 남김) → 공백 지움. */
export function cleanName(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(BRACKETS, '').replace(/\s+/g, '');
}

// ── "없음" ─────────────────────────────────────────────────

/** 낸 값이 "없음"인가: null·빠진 칸, 빈 목록, 정리한 뒤 빈 글. 꼴이 틀린 값은 "없음"이 아니라 다른 값이다. */
export function isNone(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return cleanName(value) === '';
  return false;
}

// ── 칸별 일치 ──────────────────────────────────────────────

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 허용 오차 안인가. 경계는 포함한다(정확히 1%, 정확히 5%는 맞음).
 * 소수 계산의 잔 오차(7.07 − 7 이 0.07 을 아주 조금 넘는 것) 때문에 경계가 틀림이 되지 않게 아주 작은 여유를 둔다.
 */
export function within(actual: number, expected: number, rate: number): boolean {
  const slack = 1e-9 * Math.max(1, Math.abs(expected));
  return Math.abs(actual - expected) <= Math.abs(expected) * rate + slack;
}

function pairMatch(expected: unknown, actual: unknown, rate: number | null): boolean {
  if (!isObj(expected) || !isObj(actual)) return false;
  const [ew, eh, aw, ah] = [expected.width, expected.height, actual.width, actual.height];
  if (!isNum(ew) || !isNum(eh) || !isNum(aw) || !isNum(ah)) return false;
  // 가로끼리, 세로끼리 본다. 뒤바뀐 것은 틀림이다.
  if (rate === null) return ew === aw && eh === ah;
  return within(aw, ew, rate) && within(ah, eh, rate);
}

/** (키, 원) 쌍의 집합. 순서를 보지 않고 같은 쌍은 한 번으로 친다. 꼴이 틀리면 null. */
function pairSet(value: unknown, keyName: 'days' | 'qty'): Set<string> | null {
  if (!Array.isArray(value)) return null;
  const out = new Set<string>();
  for (const item of value) {
    if (!isObj(item)) return null;
    const key = item[keyName];
    const price = item.price_krw;
    if (!isInt(key) || !isInt(price)) return null;
    out.add(`${key}:${price}`);
  }
  return out;
}

/** 같은 형식의 다른 이름은 하나로 합친다. */
const FORMAT_ALIASES: Record<string, string> = { jpeg: 'jpg', tiff: 'tif' };

function formatSet(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) return null;
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const ext = item.normalize('NFKC').trim().toLowerCase().replace(/^\.+/, '');
    out.add(FORMAT_ALIASES[ext] ?? ext);
  }
  return out;
}

const sameSet = (a: Set<string> | null, b: Set<string> | null) => a !== null && b !== null && a.size === b.size && [...a].every((x) => b.has(x));

/** 유동인구의 허용 오차 5%, 크기의 허용 오차 1%. */
export const TOLERANCE = { size: 0.01, footfall: 0.05 } as const;

/**
 * 값이 있는 두 값이 일치하는가(EVAL-SPEC 5절). 둘 다 "없음"이 아닐 때만 부른다.
 * 낸 값의 꼴이 표준 꼴이 아니면 일치하지 않는다.
 */
export function valuesMatch(field: FieldKey, expected: unknown, actual: unknown): boolean {
  switch (fieldDef(field).kind) {
    case 'money':
    case 'count':
    case 'days':
      return isInt(expected) && isInt(actual) && expected === actual;
    case 'bool':
      return typeof expected === 'boolean' && typeof actual === 'boolean' && expected === actual;
    case 'text':
      // 완전히 같아야 한다. 한쪽이 다른 쪽을 품는 것은 틀림이다.
      return typeof expected === 'string' && typeof actual === 'string' && cleanName(expected) === cleanName(actual);
    case 'size_m':
    case 'size_mm':
      return pairMatch(expected, actual, TOLERANCE.size);
    case 'resolution':
      return pairMatch(expected, actual, null);
    case 'hours':
      return (
        isObj(expected) && isObj(actual) &&
        typeof actual.open === 'string' && typeof actual.close === 'string' && typeof actual.nextDay === 'boolean' &&
        expected.open === actual.open && expected.close === actual.close && expected.nextDay === actual.nextDay
      );
    case 'footfall':
      return isNum(expected) && isNum(actual) && within(actual, expected, TOLERANCE.footfall);
    case 'period_options':
      return sameSet(pairSet(expected, 'days'), pairSet(actual, 'days'));
    case 'quantity_options':
      return sameSet(pairSet(expected, 'qty'), pairSet(actual, 'qty'));
    case 'formats':
      return sameSet(formatSet(expected), formatSet(actual));
  }
}

/** 칸 하나의 판정(EVAL-SPEC 4절). */
export function judgeField(field: FieldKey, expected: unknown, actual: unknown): Verdict {
  const wantNone = isNone(expected);
  const gotNone = isNone(actual);
  if (wantNone) return gotNone ? 'true_none' : 'fabricated';
  if (gotNone) return 'missed';
  return valuesMatch(field, expected, actual) ? 'correct' : 'wrong';
}

// ── 문서 하나 채점 ─────────────────────────────────────────

/** 한 방식이 문서 하나에 낸 것. 방식마다 이 꼴로 만들어 채점기에 넘긴다. */
export interface MethodOutput {
  /** 답을 못 냈으면 null(호출 실패). 종류가 틀린 것으로 채점된다. */
  type: DocType | null;
  subtype: string | null;
  /** 칸별로 낸 값. 없는 칸은 "없음"으로 친다. */
  values: Partial<Record<FieldKey, unknown>>;
  /** 칸별 표시(막는 사유가 붙었는가). 표시가 없는 방식은 비워 둔다. */
  fieldFlags: Partial<Record<FieldKey, boolean>>;
  /** 문서의 표시: 칸이든 초안 전체든 막는 사유가 하나라도 있는가. */
  docFlagged: boolean;
}

/**
 * 문서 하나를 채점해 결과 줄들을 낸다.
 * - type 줄은 언제나 있다. flagged 에 문서의 표시를 싣는다.
 * - subtype 줄은 정답이 상품일 때만 있다.
 * - 칸 줄은 정답의 종류에 딸린 칸만. 낸 결과에 없는 칸은 "없음"을 낸 것으로 친다.
 */
export function gradeDoc(doc: Pick<GoldDoc, 'id' | 'truth'>, out: MethodOutput): EvalCell[] {
  const { truth } = doc;
  const cells: EvalCell[] = [
    {
      goldDocId: doc.id,
      field: 'type',
      expected: truth.type,
      actual: out.type,
      verdict: out.type === truth.type ? 'correct' : 'wrong',
      flagged: out.docFlagged,
    },
  ];
  if (truth.type !== 'not_product') {
    cells.push({
      goldDocId: doc.id,
      field: 'subtype',
      expected: truth.subtype,
      actual: out.subtype,
      verdict: out.subtype === truth.subtype ? 'correct' : 'wrong',
      flagged: false,
    });
  }
  for (const field of FIELDS_BY_TYPE[truth.type]) {
    const expected = truth.fields[field] ?? null;
    const actual = out.values[field] ?? null;
    cells.push({
      goldDocId: doc.id,
      field,
      expected,
      actual,
      verdict: judgeField(field, expected, actual),
      flagged: out.fieldFlags[field] === true,
    });
  }
  return cells;
}

// ── 지표 ───────────────────────────────────────────────────

const isClassField = (field: string): field is ClassField => (CLASS_FIELDS as readonly string[]).includes(field);
const isError = (v: Verdict) => ERROR_VERDICTS.includes(v);

/** 비율을 글로. 분모가 0 이면 비율을 적지 않는다. "0건 중 0건"을 0% 라고 쓰지 않는다. */
export function formatRatio(r: Ratio): string {
  if (r.den === 0) return '해당 없음(0건)';
  // 분자가 0 이면 "0%"라고 쓰지 않는다. 건수가 작은 묶음에서 0%는 "없다"로 읽힌다. 분자/분모만 적는다.
  if (r.num === 0) return `0/${r.den}`;
  return `${r.num}/${r.den} (${((r.num / r.den) * 100).toFixed(1)}%)`;
}

/** 가장 가까운 순위 방식의 백분위: 작은 것부터 줄 세워 ⌈n × p⌉번째. 빈 목록이면 0. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length * p)));
  return sorted[rank - 1]!;
}

/** 문서별 호출 기록. 6번 지표의 재료다. */
export interface CallStat {
  goldDocId: string;
  /** 그 답을 실제로 받을 때의 비용(녹화본이면 녹화할 때의 토큰으로 낸 값) */
  costUsd: number;
  latencyMs: number;
  recorded: boolean;
}

export function costTimeOf(calls: readonly CallStat[], docs: number): NonNullable<EvalMetrics['costTime']> {
  const total = calls.reduce((sum, c) => sum + c.costUsd, 0);
  const latencies = calls.map((c) => c.latencyMs);
  return {
    costUsdTotal: round9(total),
    costUsdPerDoc: docs === 0 ? 0 : round9(total / docs),
    latencyMsP50: percentile(latencies, 0.5),
    latencyMsP95: percentile(latencies, 0.95),
    // 하나라도 녹화본에서 읽었으면 "녹화 때 잰 값"이 섞인 것이다.
    fromRecording: calls.some((c) => c.recorded),
  };
}

const round9 = (n: number) => Math.round(n * 1e9) / 1e9;

export interface MetricsOptions {
  /** false 면 4번·5번 지표를 내지 않는다(llm_only). */
  hasFlags: boolean;
  /** 없으면 6번 지표를 내지 않는다(rules). */
  calls?: readonly CallStat[];
}

/** 결과 줄을 문서별로 묶는다. 처음 나온 순서를 지킨다. */
export function groupByDoc<T extends { goldDocId: string }>(cells: readonly T[]): Map<string, T[]> {
  const byDoc = new Map<string, T[]>();
  for (const cell of cells) {
    const list = byDoc.get(cell.goldDocId);
    if (list) list.push(cell);
    else byDoc.set(cell.goldDocId, [cell]);
  }
  return byDoc;
}

/**
 * 한 묶음, 한 방식의 결과 줄에서 지표를 낸다. 분자와 분모를 그대로 들고 다닌다.
 * 문서 수는 type 줄의 수다(문서마다 하나씩 꼭 있다).
 */
export function computeMetrics(cells: readonly EvalCell[], options: MetricsOptions): EvalMetrics {
  const byDoc = groupByDoc(cells);
  const docs = byDoc.size;

  const accuracyBy: Partial<Record<FieldKey, Ratio>> = {};
  const fabricatedBy: Partial<Record<FieldKey, Ratio>> = {};
  const accuracy: Ratio = { num: 0, den: 0 };
  const fabricated: Ratio = { num: 0, den: 0 };
  const missed: Ratio = { num: 0, den: 0 };
  const caught: Ratio = { num: 0, den: 0 };
  const falseAlarm: Ratio = { num: 0, den: 0 };
  const flaggedTrueNone: Ratio = { num: 0, den: 0 };

  for (const cell of cells) {
    if (isClassField(cell.field) || !isFieldKey(cell.field)) continue;
    const field = cell.field;
    const acc = (accuracyBy[field] ??= { num: 0, den: 0 });
    const fab = (fabricatedBy[field] ??= { num: 0, den: 0 });
    const v = cell.verdict;
    if (v === 'correct' || v === 'wrong' || v === 'missed') {
      acc.den += 1;
      accuracy.den += 1;
      missed.den += 1;
      if (v === 'correct') {
        acc.num += 1;
        accuracy.num += 1;
      }
      if (v === 'missed') missed.num += 1;
    } else {
      fab.den += 1;
      fabricated.den += 1;
      if (v === 'fabricated') {
        fab.num += 1;
        fabricated.num += 1;
      }
    }
    if (isError(v)) {
      caught.den += 1;
      if (cell.flagged) caught.num += 1;
    } else if (v === 'correct') {
      falseAlarm.den += 1;
      if (cell.flagged) falseAlarm.num += 1;
    } else {
      flaggedTrueNone.den += 1;
      if (cell.flagged) flaggedTrueNone.num += 1;
    }
  }

  const docsAllCorrect: Ratio = { num: 0, den: docs };
  const typeAccuracy: Ratio = { num: 0, den: docs };
  const subtypeAccuracy: Ratio = { num: 0, den: 0 };
  const ready: Ratio = { num: 0, den: docs };
  const readyWithError: Ratio = { num: 0, den: 0 };

  for (const docCells of byDoc.values()) {
    const allCorrect = isDocAllCorrect(docCells);
    if (allCorrect) docsAllCorrect.num += 1;
    const typeCell = docCells.find((c) => c.field === 'type');
    if (typeCell?.verdict === 'correct') typeAccuracy.num += 1;
    const subtypeCell = docCells.find((c) => c.field === 'subtype');
    if (subtypeCell) {
      subtypeAccuracy.den += 1;
      if (subtypeCell.verdict === 'correct') subtypeAccuracy.num += 1;
    }
    // 문서의 표시는 type 줄에 실려 있다.
    if (typeCell && !typeCell.flagged) {
      ready.num += 1;
      readyWithError.den += 1;
      if (!allCorrect) readyWithError.num += 1;
    }
  }

  return {
    docs,
    fieldAccuracy: { overall: accuracy, byField: accuracyBy },
    fabricated: { overall: fabricated, byField: fabricatedBy },
    docsAllCorrect,
    autoApprove: options.hasFlags ? { ready, readyWithError } : null,
    checker: options.hasFlags ? { caught, falseAlarm, flaggedTrueNone } : null,
    costTime: options.calls ? costTimeOf(options.calls, docs) : null,
    typeAccuracy,
    subtypeAccuracy,
    missed,
  };
}

/** 전부 맞은 문서가 아닌 문서와 그 틀린 줄들. 사람이 읽는 요약에 쓴다. */
export function wrongDocs(cells: readonly EvalCell[]): { goldDocId: string; errors: EvalCell[] }[] {
  const out: { goldDocId: string; errors: EvalCell[] }[] = [];
  for (const [goldDocId, docCells] of groupByDoc(cells)) {
    const errors = docCells.filter((c) => isError(c.verdict));
    if (errors.length > 0) out.push({ goldDocId, errors });
  }
  return out;
}
