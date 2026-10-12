// 평가의 약속. 일치 기준과 지표의 뜻은 docs/EVAL-SPEC.md 에 있다. 이 파일은 그 꼴이다.
import { z } from 'zod';
import { DOC_TYPES, FIELDS_BY_TYPE, isSubtypeOf, parseFieldValue, type DocType, type FieldKey, type FieldValue } from './fields';

// ── 정답 세트 ──────────────────────────────────────────────

/** 네 묶음. 점수를 합치지 않는다. real(실제 자료)과 hand(손글)는 파이프라인을 얼린 뒤에 모은다. */
export const GOLD_SPLITS = ['dev', 'test', 'real', 'hand'] as const;
export type GoldSplit = (typeof GOLD_SPLITS)[number];

export const SPLIT_LABELS: Record<GoldSplit, string> = {
  dev: '연습',
  test: '안 여는 세트',
  real: '실제 자료',
  hand: '손글',
};

/** 묶음별 건수. */
export const SPLIT_SIZES: Record<GoldSplit, number> = { dev: 40, test: 60, real: 20, hand: 10 };

export const GOLD_AUTHORS = ['ai', 'human'] as const;
export type GoldAuthor = (typeof GOLD_AUTHORS)[number];

/**
 * 일부러 넣은 함정.
 * - missing_field: 값이 아예 없는 칸      - unit: 단위("05시~25시", 월 유동인구, m·mm 혼용, "150")
 * - price: 값(정가와 판매가, 부가세 별도, 기간별 값표)
 * - not_product: 등록 대상이 아닌 글      - instruction: 글 안의 지시문
 * - type_confusion: 종류와 갈래가 헷갈리는 글
 */
export const GOLD_TRAPS = ['missing_field', 'unit', 'price', 'not_product', 'instruction', 'type_confusion'] as const;
export type GoldTrap = (typeof GOLD_TRAPS)[number];

/** 원문의 꼴 다섯. */
export const GOLD_STYLES = ['notice', 'messenger', 'table', 'mixed_lang', 'long_mixed'] as const;
export type GoldStyle = (typeof GOLD_STYLES)[number];

export const STYLE_LABELS: Record<GoldStyle, string> = {
  notice: '자유 글 공지',
  messenger: '메신저 말투',
  table: '표 붙여 넣기',
  mixed_lang: '중국어·영어가 섞인 글',
  long_mixed: '여러 정보가 뒤섞인 긴 글',
};

export interface GoldTruth {
  type: DocType;
  /** not_product 면 null */
  subtype: string | null;
  /** 그 종류의 칸 전부. 원문에 없는 칸은 null("없음"). */
  fields: Partial<Record<FieldKey, FieldValue | null>>;
}

export interface GoldDoc {
  /** 'dev-001' 처럼 */
  id: string;
  split: GoldSplit;
  goldVersion: number;
  /** 원문 */
  content: string;
  truth: GoldTruth;
  author: GoldAuthor;
  traps: GoldTrap[];
  /** 파일에만 둔다. DB 표에는 넣지 않는다. */
  style?: GoldStyle;
}

/**
 * 정답 문서의 스키마(jsonl 한 줄).
 * - truth.fields 의 키는 그 종류의 칸과 정확히 같아야 한다(빠진 칸도 남는 칸도 없이).
 * - 값은 표준 꼴이거나 null. 빈 목록([])과 빈 글은 쓰지 않는다. 없으면 null 이다.
 */
export const GoldDocSchema: z.ZodType<GoldDoc> = z
  .object({
    id: z.string().regex(/^(dev|test|real|hand)-\d{3}$/),
    split: z.enum(GOLD_SPLITS),
    goldVersion: z.number().int().min(1),
    content: z.string().min(1),
    truth: z.object({
      type: z.enum(DOC_TYPES),
      subtype: z.string().nullable(),
      fields: z.record(z.string(), z.unknown()),
    }),
    author: z.enum(GOLD_AUTHORS),
    traps: z.array(z.enum(GOLD_TRAPS)),
    style: z.enum(GOLD_STYLES).optional(),
  })
  .superRefine((doc, ctx) => {
    if (!doc.id.startsWith(`${doc.split}-`)) {
      ctx.addIssue({ code: 'custom', path: ['id'], message: '번호의 앞머리가 묶음 이름과 다르다' });
    }
    const { type, subtype, fields } = doc.truth;
    if (!isSubtypeOf(type, subtype)) {
      ctx.addIssue({ code: 'custom', path: ['truth', 'subtype'], message: '갈래가 그 종류의 목록에 없다' });
    }
    const want = FIELDS_BY_TYPE[type];
    for (const key of want) {
      if (!(key in fields)) {
        ctx.addIssue({ code: 'custom', path: ['truth', 'fields', key], message: '칸이 빠졌다(없으면 null 로 적는다)' });
        continue;
      }
      const value = fields[key];
      if (!parseFieldValue(key, value).ok) {
        ctx.addIssue({ code: 'custom', path: ['truth', 'fields', key], message: '값의 꼴이 다르다' });
      }
      if (Array.isArray(value) && value.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['truth', 'fields', key], message: '빈 목록 대신 null 을 쓴다' });
      }
    }
    for (const key of Object.keys(fields)) {
      if (!(want as readonly string[]).includes(key)) {
        ctx.addIssue({ code: 'custom', path: ['truth', 'fields', key], message: '그 종류에 없는 칸이다' });
      }
    }
  }) as unknown as z.ZodType<GoldDoc>;

/** 사람 확인의 판정. ok: 맞음, fixed: 정답을 고침, dropped: 이 건 버림. */
export const REVIEW_VERDICTS = ['ok', 'fixed', 'dropped'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

// ── 일치 판정 ──────────────────────────────────────────────

/**
 * 칸 하나의 판정.
 * - correct: 정답에 값이 있고 일치        - wrong: 정답에 값이 있고 다른 값을 냄
 * - missed: 정답에 값이 있는데 못 냄      - fabricated: 정답이 "없음"인데 값을 냄
 * - true_none: 정답도 "없음", 낸 것도 "없음"
 */
export const VERDICTS = ['correct', 'wrong', 'missed', 'fabricated', 'true_none'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** 틀린 칸으로 세는 판정. */
export const ERROR_VERDICTS: readonly Verdict[] = ['wrong', 'missed', 'fabricated'];

/** 비교 방식 셋. 같은 문서, 같은 호출에서 나온다. */
export const EVAL_METHODS = ['rules', 'llm_only', 'llm_code'] as const;
export type EvalMethod = (typeof EVAL_METHODS)[number];

export const METHOD_LABELS: Record<EvalMethod, string> = {
  rules: '규칙만',
  llm_only: 'LLM만(모델이 읽은 값 그대로)',
  llm_code: 'LLM 뽑기 + 코드 맞추기',
};

/** 종류와 갈래도 결과 표에 한 줄씩 남긴다. 칸 지표에는 넣지 않는다. */
export const CLASS_FIELDS = ['type', 'subtype'] as const;
export type ClassField = (typeof CLASS_FIELDS)[number];

/** 결과 한 줄(eval_results). */
export interface EvalCell {
  goldDocId: string;
  field: FieldKey | ClassField;
  expected: unknown;
  actual: unknown;
  /** type·subtype 줄은 correct 또는 wrong 만 쓴다. */
  verdict: Verdict;
  /**
   * 칸 줄: 그 칸에 표시(막는 사유)가 붙었는가.
   * type 줄: 그 문서가 "확인 필요"로 갔는가(칸이든 초안이든 막는 사유가 하나라도 있었는가).
   * llm_only 방식은 표시가 없으므로 언제나 false.
   */
  flagged: boolean;
}

// ── 지표 ───────────────────────────────────────────────────

/** 모든 비율은 분자/분모로 들고 다닌다. 분모가 0 이면 비율을 내지 않는다. */
export interface Ratio {
  num: number;
  den: number;
}

/** 앞에 내세우는 지표 여섯 + 따로 싣는 것. 한 묶음, 한 방식의 값이다. */
export interface EvalMetrics {
  /** 채점한 문서 수(사람이 확인한 것만) */
  docs: number;

  /** 1. 칸 정확도: 일치한 칸 / 정답에 값이 있는 칸 */
  fieldAccuracy: { overall: Ratio; byField: Partial<Record<FieldKey, Ratio>> };
  /** 2. 지어낸 값: 정답이 "없음"인데 값을 낸 칸 / 정답이 "없음"인 칸 */
  fabricated: { overall: Ratio; byField: Partial<Record<FieldKey, Ratio>> };
  /** 3. 전부 맞은 문서 / 전체 문서 */
  docsAllCorrect: Ratio;
  /** 4. 바로 승인 줄과 그 안의 틀린 것. 표시가 없는 방식(llm_only)은 null. */
  autoApprove: {
    /** 표시 0개인 문서 / 전체 문서 */
    ready: Ratio;
    /** 표시 0개인 문서 가운데 틀린 칸이 있는 문서 / 표시 0개인 문서 */
    readyWithError: Ratio;
  } | null;
  /** 5. 검사기 포착과 헛경보. 표시가 없는 방식은 null. */
  checker: {
    /** 표시가 붙은 틀린 칸 / 틀린 칸 */
    caught: Ratio;
    /** 표시가 붙은 맞은 칸 / 맞은 칸 */
    falseAlarm: Ratio;
    /** 참고: 표시가 붙은 true_none 칸 / true_none 칸 */
    flaggedTrueNone: Ratio;
  } | null;
  /** 6. 건당 비용과 시간. 호출이 없는 방식(rules)은 null. */
  costTime: {
    costUsdTotal: number;
    /** costUsdTotal / docs */
    costUsdPerDoc: number;
    latencyMsP50: number;
    latencyMsP95: number;
    /** 녹화본에서 읽은 값인가 */
    fromRecording: boolean;
  } | null;

  // 따로 싣는 것
  /** 종류를 맞힌 문서 / 전체 문서 */
  typeAccuracy: Ratio;
  /** 갈래를 맞힌 문서 / 정답이 상품인 문서 */
  subtypeAccuracy: Ratio;
  /** 놓친 값: 정답에 값이 있는데 못 낸 칸 / 정답에 값이 있는 칸 */
  missed: Ratio;
}

/** 실행 한 번(eval_runs 한 줄). */
export interface EvalRun {
  id: number;
  split: GoldSplit;
  method: EvalMethod;
  model: string | null;
  promptVersion: string | null;
  goldVersion: number;
  gitCommit: string;
  metrics: EvalMetrics;
  costUsd: number;
  startedAt: string;
}

/** 견준 두 실행에서 판정이 달라진 칸 하나. 무엇이 나아지고 나빠졌는지 건별로 읽을 때 쓴다. */
export interface CellChange {
  goldDocId: string;
  field: FieldKey | ClassField;
  base: Verdict;
  other: Verdict;
}

/**
 * 두 실행을 같은 문서끼리 견준 것. 문서가 "전부 맞음"이 됐는가를 기준으로 센다.
 * 같은 묶음, 같은 정답 버전, 같은 방식의 실행끼리만 견준다(다르면 견주지 않고 오류).
 * 양쪽에 다 있는 문서만 센다. 한쪽에만 있는 문서는 onlyIn… 에 따로 적는다.
 */
export interface RunComparison {
  baseRunId: number;
  otherRunId: number;
  /** base 에서 틀렸고 other 에서 전부 맞은 문서 */
  improved: string[];
  /** base 에서 전부 맞았고 other 에서 틀린 문서 */
  regressed: string[];
  /** 둘 다 같은 문서 수(둘 다 전부 맞음 + 둘 다 틀림) */
  unchanged: number;
  onlyInBase: string[];
  onlyInOther: string[];
  /** 판정이 달라진 칸들. 문서 번호, 칸 순서로 적는다. API 응답에는 싣지 않아도 된다(기록 파일용). */
  cellChanges?: CellChange[];
}

/** 문서 하나가 전부 맞았는가: 종류·갈래 줄을 포함해 틀린 판정(ERROR_VERDICTS)이 하나도 없다. */
export function isDocAllCorrect(cells: readonly Pick<EvalCell, 'verdict'>[]): boolean {
  return cells.every((cell) => !ERROR_VERDICTS.includes(cell.verdict));
}

// ── 실행 기록 ──────────────────────────────────────────────

/**
 * 돌리기 전의 어림(--dry-run). 키 없이 낸다.
 * 비용은 어림이다. 건당 토큰은 지금까지의 장부 평균으로, 장부가 비었으면 정해 둔 어림값으로 낸다(basis 에 적는다).
 */
export interface EvalEstimate {
  split: GoldSplit;
  /** 채점할 문서 수(사람이 확인한 것만) */
  docs: number;
  /** 장부에 답이 있어 부르지 않아도 되는 문서 수 */
  cached: number;
  /** 실제로 불러야 하는 문서 수 */
  toCall: number;
  estCostUsd: number;
  basis: 'ledger_average' | 'default_guess';
}

/**
 * 평가를 한 번 돌린 기록(eval/results/ 의 JSON 파일 하나). DB 의 eval_runs 세 줄과 같은 내용이다.
 * 한 번 돌리면 방식 셋(rules / llm_only / llm_code)이 같은 호출에서 나온다.
 * 실제 자료 묶음(real)의 기록에는 원문도 값도 싣지 않는다(지표와 판정만).
 */
export interface EvalRunRecord {
  split: GoldSplit;
  goldVersion: number;
  model: string | null;
  promptVersion: string | null;
  gitCommit: string;
  startedAt: string;
  /** 녹화본만으로 돌렸는가(eval:replay) */
  replayOnly: boolean;
  /** 상한(--max-usd)에 걸려 중간에 멈췄는가. 멈췄으면 끝난 데까지만 들어 있다. */
  stoppedByBudget: boolean;
  /** 방식별 실행 번호와 지표 */
  runs: Record<EvalMethod, { runId: number; metrics: EvalMetrics }>;
  /** 실제로 쓴 돈(녹화본에서 읽은 것은 0) */
  costUsd: number;
}

/**
 * 회귀 문지기의 기준(eval/baseline.json). 연습 세트를 녹화본으로 다시 채점한 값이다.
 * eval:replay 의 "전부 맞은 문서 수"(llm_code 방식)가 docsAllCorrect 아래로 내려가면 verify 가 실패한다.
 * 프롬프트·모델·정답 버전이 기준과 다르면 견주지 않고 "다시 녹화 필요"로 실패한다.
 * 녹화본이 없는 문서가 있어도 실패한다(조용히 빼고 채점하지 않는다).
 */
export interface EvalBaseline {
  split: 'dev';
  method: 'llm_code';
  model: string;
  promptVersion: string;
  goldVersion: number;
  docs: number;
  docsAllCorrect: number;
  /** 이 기준을 적은 커밋과 날짜 */
  gitCommit: string;
  recordedOn: string;
}

// ── 주입 시험 ──────────────────────────────────────────────

/**
 * 일부러 망가뜨리는 종류 여덟. 앞의 넷은 값, 뒤의 넷은 글.
 * - zero_added: 금액에 0 하나 더              - unit_swap: m 와 mm 뒤바꿈
 * - fake_evidence: 원문에 없는 근거            - cheaper_longer: 기간이 길수록 총액이 작아지는 값
 * - monologue: 혼잣말 넣기                    - glossary_swap: 용어 바꾸기
 * - placeholder_removed: 자리표시 지우기       - hangul_mixed: 한글 섞기
 */
export const INJECTION_KINDS = [
  'zero_added',
  'unit_swap',
  'fake_evidence',
  'cheaper_longer',
  'monologue',
  'glossary_swap',
  'placeholder_removed',
  'hangul_mixed',
] as const;
export type InjectionKind = (typeof INJECTION_KINDS)[number];

/** 종류별 결과: 검사기가 잡은 수 / 넣은 수. */
export type InjectionReport = Record<InjectionKind, Ratio>;
