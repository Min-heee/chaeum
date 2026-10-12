// src/core 가 내보낼 함수의 꼴. 저장·작업 줄·평가기는 이 꼴만 보고 붙는다.
// src/core 는 순수 함수다. DB, 네트워크, 지금 시각, 난수를 쓰지 않는다.
import type { Lang, Placeholder, TextField } from './content';
import type {
  DocType,
  ExtractedBy,
  Extraction,
  FieldKey,
  FieldValue,
  FieldValues,
  Hours,
  PeriodOption,
  SizeM,
  SizeMm,
} from './fields';
import type { ContentFailCode, ReasonCode } from './reasons';
import type { Route } from './transitions';

// ── 맞추기 ─────────────────────────────────────────────────

/**
 * 맞춘 결과.
 * - 읽었으면 value 에 표준 값. 단위를 바꿨으면 reasons 에 UNIT_CONVERTED.
 * - 못 읽었으면 value 는 null, reasons 는 ['PARSE_FAILED'].
 */
export interface NormalizeResult<T> {
  value: T | null;
  reasons: ReasonCode[];
}

/** 칸별 사유. 사유가 없는 칸은 빠져 있다. */
export type FieldReasons = Partial<Record<FieldKey, ReasonCode[]>>;

// ── 따지기 ─────────────────────────────────────────────────

export interface StructureInput {
  sourceText: string;
  type: DocType;
  subtype: string | null;
  /** 칸별 원문 표현(자리 채움 글자를 본다) */
  raws: Partial<Record<FieldKey, string | null>>;
  /** 칸별 최종 값(옵션 0개를 본다) */
  values: FieldValues;
}

export interface StructureResult {
  fieldReasons: FieldReasons;
  /** TYPE_SUBTYPE_MISMATCH, INSTRUCTION_LIKE */
  draftReasons: ReasonCode[];
}

// ── 한 번에 돌기 ───────────────────────────────────────────

/** 따지고 난 칸 하나. draft_fields 한 줄과 같은 꼴이다. */
export interface EvaluatedField {
  field: FieldKey;
  /** 원문 표현 그대로 */
  raw: string | null;
  /** 모델이 읽은 값. 규칙만으로 뽑았으면 null. */
  modelValue: FieldValue | null;
  /** 코드가 raw 를 읽어 맞춘 값. raw 가 없거나 못 읽었으면 null. */
  codeValue: FieldValue | null;
  /**
   * 초안에 실리는 값.
   * 사람이 고친 칸은 고친 값. 아니면 codeValue, 그것이 null 이면 modelValue.
   */
  finalValue: FieldValue | null;
  evidence: string | null;
  reasons: ReasonCode[];
  editedByHuman: boolean;
}

export interface EvaluateInput {
  /** 정리된 원문 */
  sourceText: string;
  extraction: Extraction;
  extractedBy: ExtractedBy;
}

export interface DraftEvaluation {
  type: DocType;
  subtype: string | null;
  /** 그 종류의 칸 전부(FIELDS_BY_TYPE 순서). 뽑히지 않은 칸은 값이 null 인 채로 들어 있다. */
  fields: EvaluatedField[];
  /** 초안 전체에 붙는 사유. LLM_SKIPPED 는 여기 넣지 않는다(부르는 쪽이 붙인다). */
  draftReasons: ReasonCode[];
  /** 칸 사유와 초안 사유로 낸 갈래. 부르는 쪽이 사유를 더했으면 routeDraft 를 다시 부른다. */
  route: Route;
}

export interface RecheckInput {
  sourceText: string;
  type: DocType;
  subtype: string | null;
  extractedBy: ExtractedBy;
  /** 지금 저장된 칸들 */
  fields: EvaluatedField[];
  /** 사람이 이번에 고친 칸과 값(표준 꼴). null 은 "없음"으로 비운다는 뜻. */
  edits: Partial<Record<FieldKey, FieldValue | null>>;
}

// ── 글 검사 ────────────────────────────────────────────────

export interface ContentCheckInput {
  lang: Lang;
  field: TextField;
  /** 모델이 쓴 글. 숫자 자리는 {price} 같은 자리표시인 채로. */
  text: string;
  /** 이 글에 꼭 있어야 하는 자리표시 */
  requiredPlaceholders: Placeholder[];
  /** 이 언어 표기로 글에 그대로 있어야 하는 용어 */
  requiredTerms: string[];
  /** 이름·지역에 원래 들어 있어 글에 나와도 되는 숫자("4번출구"의 "4") */
  allowedNumbers: string[];
}

// ── 내보낼 함수 ────────────────────────────────────────────

/** src/core/index.ts 가 이 꼴대로 내보낸다. */
export interface CoreApi {
  // 맞추기 6종 (src/core/normalize)
  /**
   * "150만원", "1,500,000원", "150"(만원 생략) → 원. 단위를 짐작했으면 UNIT_CONVERTED.
   * moneyUnits 는 글에 선언된 금액 단위(declaredMoneyUnits 의 결과)다. raw 에 단위가 없을 때만 쓴다:
   * 하나(원·천원·만원)면 1만 미만의 수를 그 단위로 읽고 UNIT_CONVERTED. raw 에 단위가 있으면 raw 가 이긴다.
   * 서로 다른 선언이 둘 이상, 만원보다 큰 선언, 천원·만원 선언 아래의 1만 이상인 수는 PARSE_FAILED.
   */
  normalizeMoney(raw: string, moneyUnits?: readonly number[]): NormalizeResult<number>;
  /**
   * 글에 선언된 금액 단위를 찾는다. "(단위: 천원)" → [1000]. 1단위가 몇 원인지로 낸다.
   * 선언이 없으면 빈 목록. 서로 다른 선언이 있으면 둘 이상이 나온다. 애매한 꼴("주문 단위: 100개")은 선언이 아니다.
   * near(근거 구절, 원문 표현)를 주면 그 자리에 걸리는 선언만 낸다: 같은 줄, 같은 단락의 아래 줄, 표 머리 바로 다음 단락.
   */
  declaredMoneyUnits(sourceText: string, near?: readonly (string | null)[]): number[];
  /** "7*12(m)", "7000x12000mm" → 바라는 단위의 가로·세로. 단위를 바꿨으면 UNIT_CONVERTED. */
  normalizeSize(raw: string, unit: 'm'): NormalizeResult<SizeM>;
  normalizeSize(raw: string, unit: 'mm'): NormalizeResult<SizeMm>;
  /** "05시~25시" → { open: "05:00", close: "01:00", nextDay: true } */
  normalizeHours(raw: string): NormalizeResult<Hours>;
  /** "월 300만명" → 하루 유동인구. 월·주·연 단위를 바꿨으면 UNIT_CONVERTED. */
  normalizeFootfall(raw: string): NormalizeResult<number>;
  /** "1주 150 2주 280" → [{ days: 7, price_krw: 1500000 }, …] */
  normalizePeriodOptions(raw: string, moneyUnits?: readonly number[]): NormalizeResult<PeriodOption[]>;
  /** "2주 전", "10일" → 일수 */
  normalizeDays(raw: string): NormalizeResult<number>;
  /** 칸 이름으로 알맞은 맞추기를 골라 돈다. 위 여섯으로 안 되는 칸(글자, 참·거짓, 횟수, 형식, 수량 옵션)도 여기서 맞춘다. */
  normalizeField(field: FieldKey, raw: string, moneyUnits?: readonly number[]): NormalizeResult<FieldValue>;

  // 따지기 5종 (src/core/checks)
  /** 값이 있는데 근거 구절이 없거나 원문에 없으면 NO_EVIDENCE. 공백·줄바꿈 차이는 봐준다. */
  checkEvidence(sourceText: string, evidence: string | null, hasValue: boolean): ReasonCode[];
  /** 모델 값과 코드 값이 둘 다 있고 다르면 VALUE_MISMATCH. 한쪽이 null 이면 따지지 않는다. */
  checkMismatch(field: FieldKey, modelValue: FieldValue | null, codeValue: FieldValue | null): ReasonCode[];
  /** 0 이하, 판매가 > 정가, 기간이 길수록 총액이 작아짐, 운영 24시간 초과 → 그 칸에 OUT_OF_RANGE. */
  checkRange(type: DocType, values: FieldValues): FieldReasons;
  /** 종류별 필수 칸이 null 이면 그 칸에 REQUIRED_MISSING. */
  checkRequired(type: DocType, values: FieldValues): FieldReasons;
  /** 옵션 0개, 종류·갈래 불일치, 자리 채움 글자, 지시문 같은 문장. */
  checkStructure(input: StructureInput): StructureResult;

  // 규칙만으로 뽑기 (src/core/rules-extract)
  /** 정규식만으로 뽑는다. value 는 전부 null 이고 raw 와 evidence 만 채운다. 종류를 못 정하면 not_product. */
  rulesExtract(sourceText: string): Extraction;

  // 갈래 (src/core/route.ts)
  /** 막는 사유가 하나도 없으면 READY, 아니면 NEEDS_REVIEW. */
  routeDraft(fieldReasons: readonly ReasonCode[][], draftReasons: readonly ReasonCode[]): Route;

  // 글 검사 5종 (src/core/content-check.ts)
  /** 걸린 코드들. 빈 배열이면 통과. */
  checkContent(input: ContentCheckInput): ContentFailCode[];

  // 한 번에 돌기
  /**
   * 뽑기 결과를 맞추고 따져 칸별 결과와 갈래를 낸다. 실패하지 않는다(걸린 것이 결과다).
   * type 이 not_product 면 칸은 비고 draftReasons 에 NOT_A_PRODUCT 가 들어간다.
   * 따지기 5종에 더해 여기서만 붙는 사유가 둘 있다:
   * 원문 표현(raw)이 원문에 없으면 NO_EVIDENCE, raw 없이 값만 왔으면 PARSE_FAILED(코드가 다시 읽어 볼 것이 없다).
   * LLM_SKIPPED 는 붙이지 않는다. 규칙만 길로 내려온 쪽(파이프라인)이 draftReasons 에 더하고 routeDraft 를 다시 부른다.
   */
  evaluateDraft(input: EvaluateInput): DraftEvaluation;
  /**
   * 사람이 칸을 고친 뒤 다시 따진다.
   * 고친 칸은 finalValue 가 고친 값이 되고 editedByHuman 이 true 가 된다.
   * 고친 칸에는 근거·불일치·읽기 실패 사유를 붙이지 않는다. 범위·필수·구조는 전부 다시 본다.
   */
  recheckDraft(input: RecheckInput): DraftEvaluation;
}
