// 견적의 약속. 문의 글에서 조건을 뽑아 맞는 상품과 총액을 내고, 문의한 언어로 답장 초안을 쓴다.
//
//   POST /api/quotes               문의 글 → 조건 뽑기(LLM) → 고르기·계산(코드) → 답장 초안(LLM) → 글 검사(코드) → 저장(201)
//   GET  /api/quotes/:id           저장된 견적 한 건
//   POST /api/quotes/:id/confirm   사람이 고친 답장으로 확정(보내기는 흉내만 낸다. 어디로도 보내지 않는다)
//
// 누가 무엇을 하는가
// - 모델(quote_extract): 글에 적힌 조건을 "읽기"만 한다. 예산은 적힌 표현과 읽은 값, 날짜는 달·일·주차 같은 조각.
// - 코드(src/tools/quote): 날짜 조각을 오늘 기준의 실제 날짜 범위로 바꾸고, 예산 표현을 본체의 금액 맞추기로 다시 읽고,
//   상품을 고르고, 옵션으로 총액을 내고, 마감을 센다. 돈 계산과 날짜 계산은 전부 여기서 한다.
// - 모델(quote_reply): 답장 글을 쓴다. 숫자와 날짜는 {total} 같은 자리표시로만 쓰고 코드가 넣는다.
// 조건 뽑기는 대신할 규칙 길이 없다. 모델을 못 부르면 접수하지 않고 까닭을 돌려준다(503, 오늘 상한이 찼으면 429).
// 답장 쓰기를 못 부르면 코드가 만든 틀 문장으로 내려간다(source 'template').
// 실제 호출은 본체와 같은 길 고르기(planLlmRoute)와 같은 하루 상한('live_llm')을 쓴다. 호출 하나가 한 건이다.
//
// 이 파일은 브라우저 코드도 읽는다. llm-types.ts 는 타입으로만 가져온다.
import { z } from 'zod';
import { LLM_SKIP_CAUSES, CONTENT_FAIL_CODES } from '../reasons';
import { PRODUCT_TYPES } from '../fields';
import { TEXT_STATUSES } from '../content';
import type { LlmTask } from '../llm-types';
import { DeadlineSchema, IsoDateSchema } from './dates';

// ── 일과 상한 ──────────────────────────────────────────────

/** 견적이 쓰는 LLM 일 둘. 장부(llm_calls.task)에 이 이름으로 남는다. */
export const QUOTE_TASKS = ['quote_extract', 'quote_reply'] as const satisfies readonly LlmTask[];
export type QuoteTask = (typeof QUOTE_TASKS)[number];

export const QUOTE_PROMPT_VERSIONS: Record<QuoteTask, string> = {
  quote_extract: 'quote-extract-v1',
  quote_reply: 'quote-reply-v1',
};

export const QUOTE_LIMITS = {
  /** 문의 글의 글자 수 */
  textMaxChars: 1000,
  /** 사람이 확정하는 답장의 글자 수 */
  replyMaxChars: 2000,
  /** 공간 하나의 견적 수 */
  quotesPerWorkspace: 50,
  /** 응답과 표에 싣는 맞는 상품 수(총액이 작은 것부터) */
  maxCandidates: 5,
  /** 빠진 상품을 까닭과 함께 싣는 수 */
  maxExcluded: 30,
  /** 일별 답의 최대 토큰 수 */
  maxTokens: { quote_extract: 1024, quote_reply: 1024 },
} as const satisfies { maxTokens: Record<QuoteTask, number> } & Record<string, unknown>;

/** 문의 글의 언어. 답장도 이 언어로 쓴다. */
export const QUOTE_LANGS = ['ko', 'en', 'zh-Hans'] as const;
export type QuoteLang = (typeof QUOTE_LANGS)[number];

export const QUOTE_LANG_LABELS: Record<QuoteLang, string> = { ko: '한국어', en: '영어', 'zh-Hans': '중국어(간체)' };

export const QUOTE_STATUSES = ['draft', 'confirmed'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

// ── 1. 조건 뽑기(quote_extract) ────────────────────────────

/**
 * 모델이 내는 답의 꼴. 이 꼴 그대로 모델에게 보낸다. 그래서 길이·범위·정규식 제약을 넣지 않았다
 * (구조화 출력이 받지 않는다). 범위는 받은 뒤 코드(resolveConditions)가 본다.
 * 글에 없는 조건은 null 이다. 짐작해서 채우지 않는다.
 */
export const QuoteExtractionSchema = z.object({
  lang: z.enum(QUOTE_LANGS),
  /** 예산을 적은 표현 그대로("300만 원", "3 million won", "300万韩元") */
  budget_raw: z.string().nullable(),
  /** 모델이 읽은 예산(원). 코드가 budget_raw 를 읽지 못했을 때만 쓴다. */
  budget_krw: z.number().nullable(),
  /** 지역을 적은 표현 그대로("홍대 근처", "near Gangnam Station") */
  region: z.string().nullable(),
  /** 날짜를 적은 표현 그대로("5월 첫 주", "May 3rd") */
  date_raw: z.string().nullable(),
  /**
   * 날짜 표현에서 읽은 조각. 계산하지 않고 적힌 것만 옮긴다. 연도가 안 적혔으면 year 는 null 이다(코드가 정한다).
   * "5월 첫 주" → { year: null, month: 5, day_from: null, day_to: null, week_of_month: 1 }
   * "5월 3일~5일" → { year: null, month: 5, day_from: 3, day_to: 5, week_of_month: null }
   */
  date: z
    .object({
      year: z.number().nullable(),
      month: z.number().nullable(),
      day_from: z.number().nullable(),
      day_to: z.number().nullable(),
      week_of_month: z.number().nullable(),
    })
    .nullable(),
  type: z.enum(PRODUCT_TYPES).nullable(),
  /** 갈래. 본체의 갈래 목록(SUBTYPES)에 있는 말로. 없거나 모르면 null. */
  subtype: z.string().nullable(),
  /** 수량(잔, 개, 장) */
  qty: z.number().nullable(),
  /** 기간(일). "2주" → 14 처럼 적힌 기간만. 날짜 범위에서 계산해 넣지 않는다. */
  days: z.number().nullable(),
});
export type QuoteExtraction = z.infer<typeof QuoteExtractionSchema>;

/** 조건 뽑기 요청의 입력. 글은 값으로만 넘긴다(글 안의 지시문은 자료다). 오늘 날짜는 넣지 않는다(넣으면 날마다 키가 달라진다). */
export interface QuoteExtractInput {
  text: string;
}

// ── 2. 조건(코드가 다듬은 것) ──────────────────────────────

/** 예산을 무엇으로 읽었나. code: 본체의 금액 맞추기가 표현을 읽었다. model: 코드가 못 읽어 모델이 읽은 값을 썼다(화면이 표시한다). */
export const BUDGET_SOURCES = ['code', 'model'] as const;

/**
 * 고르기·계산에 쓰는 조건. 없으면 null 이고, null 인 조건으로는 거르지 않는다.
 * 날짜 조각을 날짜 범위로 바꾸는 규칙(코드가 한다):
 * - 연도가 없으면 오늘 이후로 처음 오는 그 달(그 날)이다. 이미 지난 달·날이면 다음 해.
 *   2월 29일만 다음 윤년까지 찾는다. "N째 주"는 처음 오는 그 달 하나만 보고, 그 달에 그 주가 없으면(평년 2월의 다섯째 주) 날짜 문제다.
 * - 범위가 오늘을 품으면(오늘이 10월 12일인데 "10월", "10월 둘째 주") 첫날을 오늘로 당긴다. 지난 날에 시작할 수는 없기 때문이다.
 *   연도까지 적힌 범위도 같다. 범위가 통째로 지났으면 당기지 않는다(그 날짜 그대로이고, 고를 때 "마감이 지남"으로 빠진다).
 * - "N째 주"는 그 달 1일이 든 주를 첫 주로 치지 않고, 그 달의 (N−1)×7+1 일부터 7일이다(1주 = 1~7일, 2주 = 8~14일).
 * - 달만 있으면 그 달 1일부터 말일까지. 일만 있고 끝이 없으면 하루짜리 범위.
 * - 조각이 달력에 없는 날(2월 30일)을 가리키면 날짜 조건은 null 이고 dateProblem 이 참이다.
 */
export const QuoteConditionsSchema = z.object({
  lang: z.enum(QUOTE_LANGS),
  budgetKrw: z.number().int().positive().nullable(),
  budgetBy: z.enum(BUDGET_SOURCES).nullable(),
  region: z.string().nullable(),
  /** 희망 날짜 범위. 게재 시작일·행사일의 기준이 된다(시작일 = dateFrom). */
  dateFrom: IsoDateSchema.nullable(),
  dateTo: IsoDateSchema.nullable(),
  /** 날짜 표현은 있었는데 날짜로 바꾸지 못했다 */
  dateProblem: z.boolean(),
  type: z.enum(PRODUCT_TYPES).nullable(),
  subtype: z.string().nullable(),
  qty: z.number().int().positive().nullable(),
  days: z.number().int().positive().nullable(),
});
export type QuoteConditions = z.infer<typeof QuoteConditionsSchema>;

// ── 3. 고르기·계산(순수 함수) ──────────────────────────────

/** 계산이 읽는 상품. 본체의 상품 응답(ProductBody)에서 이 칸들만 본다. */
export interface QuoteProduct {
  id: number;
  type: (typeof PRODUCT_TYPES)[number];
  subtype: string;
  name: string;
  price_krw: number;
  vat_included: boolean | null;
  /** 종류별 규격 칸(위치, 출장 지역, 마감 일수, 최소 주문 수량 …) */
  spec: Record<string, unknown>;
  /** 기간 옵션(광고) 또는 수량 옵션(케이터링). 굿즈는 빈 목록. */
  options: unknown[];
}

/** 왜 맞는가. 조건이 있었고 그 조건을 채웠을 때만 붙는다. */
export const QUOTE_MATCH_REASONS = ['type', 'subtype', 'region', 'budget', 'option', 'deadline'] as const;
export type QuoteMatchReason = (typeof QUOTE_MATCH_REASONS)[number];

export const QUOTE_MATCH_LABELS: Record<QuoteMatchReason, string> = {
  type: '종류가 맞음',
  subtype: '갈래가 맞음',
  region: '지역이 맞음',
  budget: '예산 안',
  option: '바라는 기간·수량의 옵션이 있음',
  deadline: '마감 전',
};

/** 왜 빠졌는가. */
export const QUOTE_EXCLUDE_REASONS = [
  'type_mismatch',
  'subtype_mismatch',
  'region_mismatch',
  'no_option',
  'below_min_qty',
  'over_budget',
  'deadline_passed',
] as const;
export type QuoteExcludeReason = (typeof QUOTE_EXCLUDE_REASONS)[number];

export const QUOTE_EXCLUDE_LABELS: Record<QuoteExcludeReason, string> = {
  type_mismatch: '종류가 다름',
  subtype_mismatch: '갈래가 다름',
  region_mismatch: '지역이 다름',
  no_option: '바라는 기간·수량을 채우는 옵션이 없음',
  below_min_qty: '최소 주문 수량보다 적음',
  over_budget: '예산을 넘음',
  deadline_passed: '마감이 지남',
};

/**
 * 총액을 낸 법.
 * - period_option(광고): 바라는 기간(days)과 같은 옵션의 값. 같은 것이 없으면 그보다 긴 옵션 가운데 가장 짧은 것(exact 가 거짓).
 *   기간 조건이 없으면 가장 짧은 옵션. 바라는 기간보다 긴 옵션이 하나도 없으면 no_option 으로 빠진다.
 * - quantity_option(케이터링): 수량(qty)에 같은 규칙.
 * - unit_price(굿즈): 판매가 × 수량. 수량 조건이 없으면 최소 주문 수량(없으면 1). 최소 주문 수량보다 적으면 below_min_qty.
 * 금액은 상품에 적힌 그대로다. 부가세를 더하거나 빼지 않고, 들었는지만 vatIncluded 로 알린다(모르면 null).
 */
export const QUOTE_PRICING_BASES = ['period_option', 'quantity_option', 'unit_price'] as const;

export const QuotePricingSchema = z.object({
  basis: z.enum(QUOTE_PRICING_BASES),
  /** 총액의 근거가 된 기간(일). 광고만. */
  days: z.number().int().nullable(),
  /** 총액의 근거가 된 수량. 케이터링·굿즈만. */
  qty: z.number().int().nullable(),
  /** 옵션 하나의 값 또는 낱개 값(원) */
  unitKrw: z.number().int(),
  /** 총액(원) */
  totalKrw: z.number().int(),
  /** 바라는 기간·수량과 꼭 같은 옵션인가. 조건이 없었으면 참. */
  exact: z.boolean(),
  vatIncluded: z.boolean().nullable(),
});
export type QuotePricing = z.infer<typeof QuotePricingSchema>;

export const QuoteCandidateSchema = z.object({
  productId: z.number().int().positive(),
  name: z.string(),
  type: z.enum(PRODUCT_TYPES),
  subtype: z.string(),
  /** 위치(광고) 또는 출장 지역(케이터링). 없으면 null. */
  region: z.string().nullable(),
  matched: z.array(z.enum(QUOTE_MATCH_REASONS)),
  pricing: QuotePricingSchema,
  /**
   * 마감. 기준일은 희망 날짜 범위의 첫날(dateFrom)이다. 날짜 조건이 없으면 세지 않는다(startDate null, deadlines 빈 목록).
   * 상품에 그 마감 일수가 없으면 그 마감은 목록에 없다(센 것만 들어 있다). 하나라도 지났으면 이 상품은 빠진 쪽(excluded)에 있다.
   */
  schedule: z.object({ startDate: IsoDateSchema.nullable(), deadlines: z.array(DeadlineSchema) }),
});
export type QuoteCandidate = z.infer<typeof QuoteCandidateSchema>;

export const QuoteExcludedSchema = z.object({
  productId: z.number().int().positive(),
  name: z.string(),
  reasons: z.array(z.enum(QUOTE_EXCLUDE_REASONS)).min(1),
});
export type QuoteExcluded = z.infer<typeof QuoteExcludedSchema>;

export interface QuoteMatchResult {
  /** 맞는 상품. 총액이 작은 것부터, 같으면 번호가 작은 것부터. 지역 조건이 있으면 지역이 맞은 상품이 먼저다. */
  candidates: QuoteCandidate[];
  /** 빠진 상품과 까닭. 번호가 작은 것부터. */
  excluded: QuoteExcluded[];
}

/** src/tools/quote/index.ts 가 이 꼴대로 내보낸다. 전부 순수 함수다(시계·DB·네트워크 없음). */
export interface QuoteApi {
  /** 모델의 답을 계산에 쓸 조건으로 다듬는다. 오늘은 'YYYY-MM-DD'(한국 날짜). */
  resolveConditions(extraction: QuoteExtraction, today: string): QuoteConditions;
  /** 조건 + 상품 목록 + 오늘 → 맞는 상품(왜 맞는지)과 빠진 상품(왜 빠졌는지). 자르지 않은 전체를 돌려준다. */
  matchQuote(conditions: QuoteConditions, products: readonly QuoteProduct[], today: string): QuoteMatchResult;
  /** 답장의 자리표시에 넣을 값. 고른 상품이 없으면 빈 것. */
  replyValues(candidate: QuoteCandidate | null): QuoteReplyValues;
  /** 자리표시에 값을 넣는다. 금액과 날짜는 언어별 서식으로. */
  fillReply(template: string, values: QuoteReplyValues, lang: QuoteLang): string;
  /** 모델 없이 코드가 만드는 답장(자리표시인 채). 고른 상품이 없으면 "맞는 상품을 찾지 못했다"는 글. */
  templateReply(input: QuoteReplyInput): string;
}

// ── 4. 답장(quote_reply) ───────────────────────────────────

/**
 * 답장의 자리표시. 모델은 숫자와 날짜를 직접 쓰지 않는다.
 * - total: 총액(통화 표시까지 코드가 넣는다)   - days: 기간(일)   - qty: 수량
 * - start_date: 게재 시작일·행사일            - booking_deadline, material_deadline, design_deadline, order_deadline: 마감일
 * 글 안에서 찾는 꼴은 본체와 같다(content.ts 의 PLACEHOLDER_PATTERN).
 */
export const QUOTE_PLACEHOLDERS = [
  'total',
  'days',
  'qty',
  'start_date',
  'booking_deadline',
  'material_deadline',
  'design_deadline',
  'order_deadline',
] as const;
export type QuotePlaceholder = (typeof QUOTE_PLACEHOLDERS)[number];

/** 자리표시에 넣을 값. 금액·일수·수량은 수, 날짜는 'YYYY-MM-DD'. 없는 자리표시는 글에 쓰지 못한다. */
export type QuoteReplyValues = Partial<Record<QuotePlaceholder, number | string>>;

/**
 * 답장 요청의 입력. 글자 정보만 넣는다. 숫자(총액, 날짜, 남은 날)는 넣지 않는다.
 * 그래야 값이 달라져도 같은 요청이 되고(장부 키가 같다), 모델이 숫자를 옮기다 틀릴 길이 없다.
 */
export interface QuoteReplyInput {
  lang: QuoteLang;
  /** 문의 글(정리한 것). 말투를 맞추는 데만 쓴다. */
  inquiry: string;
  /** 고른 상품. 맞는 상품이 없으면 null. */
  product: { name: string; type: (typeof PRODUCT_TYPES)[number]; subtype: string; region: string | null } | null;
  /** 이 답장에 써도 되는 자리표시 */
  placeholders: QuotePlaceholder[];
  /** 고른 상품 말고도 맞는 상품이 더 있는가(글에서 "다른 후보도 있다"고 말할 수 있게) */
  hasAlternatives: boolean;
  /** 승인된 용어 가운데 이 상품에 해당하는 줄(본체의 pickGlossary 로 고른다). 한국어 답장이면 빈 목록. */
  glossary: { ko: string; en: string; 'zh-Hans': string }[];
  /** (있을 때만) 지난번 글이 검사에서 걸린 까닭 */
  retryHint?: string;
}

/** 모델이 내는 답장. 이 꼴 그대로 보낸다. */
export const QuoteReplyDraftSchema = z.object({ reply: z.string() });
export type QuoteReplyDraft = z.infer<typeof QuoteReplyDraftSchema>;

// ── 5. 경로의 꼴 ───────────────────────────────────────────

/** 견적이 살피는 상품의 자리. own: 요청한 공간, public: 본보기 공간(읽기만). */
export const QUOTE_CATALOGS = ['own', 'public'] as const;
export type QuoteCatalog = (typeof QUOTE_CATALOGS)[number];

/**
 * POST /api/quotes 의 요청.
 * - productId: 맞는 상품 가운데 이것을 골라 답장을 쓴다. 비우면 첫 후보(총액이 가장 작은 것. 지역 조건이 있으면 지역이 맞은 것 가운데). 맞는 상품에 없는 번호면 400.
 *   비웠고 조건에 종류·갈래·지역이 하나도 없으면 상품을 고르지 않는다(selectedProductId null). 답장은 무엇을 찾는지 되묻는 틀 문장이다.
 * - today: 계산에 쓸 오늘. 비우면 서버의 한국 날짜. 시연과 시험에서 날짜를 고정할 때 쓴다.
 * - catalog: 어느 공간의 상품을 살피나. 비우면 'own'(요청한 공간). 'public' 이면 본보기 공간의 상품을 읽어 계산한다.
 *   어느 쪽이든 견적은 요청한 공간에 저장된다. 본보기 공간에는 쓰지 않는다.
 * 오류: 글이 비었거나 김 400 · 본보기 공간 403 · 공간의 견적 수 상한 429
 *       · 조건 뽑기 모델을 못 부름 503(skipCause) · 오늘 실제 호출 상한이 참 429(skipCause: daily_cap).
 */
export const QuoteCreateRequestSchema = z.strictObject({
  text: z.string(),
  productId: z.number().int().positive().optional(),
  today: IsoDateSchema.optional(),
  catalog: z.enum(QUOTE_CATALOGS).optional(),
});
export type QuoteCreateRequest = z.infer<typeof QuoteCreateRequestSchema>;

/** 호출 한 번의 기록. 꼴은 본체의 초안 llm 칸과 같은 뜻이다. */
export const QuoteCallSchema = z.object({
  recorded: z.boolean(),
  live: z.boolean(),
  model: z.string(),
  promptVersion: z.string(),
  latencyMs: z.number(),
  costUsd: z.number(),
});
export type QuoteCall = z.infer<typeof QuoteCallSchema>;

export const QUOTE_REPLY_SOURCES = ['llm', 'template'] as const;

export const QuoteReplySchema = z.object({
  /** 자리표시인 채의 글 */
  template: z.string(),
  /** 숫자와 날짜를 넣은 끝 글 */
  text: z.string(),
  source: z.enum(QUOTE_REPLY_SOURCES),
  /** 본체와 같은 글 검사의 결과. 영어·중국어 답장에만 한글 섞임을 본다. 걸린 것이 있으면 needs_review. */
  status: z.enum(TEXT_STATUSES),
  failCodes: z.array(z.enum(CONTENT_FAIL_CODES)),
});
export type QuoteReply = z.infer<typeof QuoteReplySchema>;

/** POST /api/quotes(201)·GET /api/quotes/:id·confirm(200)의 응답. 한 건의 전부다. */
export const QuoteResponseSchema = z.object({
  workspace: z.string().uuid(),
  id: z.number().int().positive(),
  status: z.enum(QUOTE_STATUSES),
  /** 정리한 문의 글 */
  text: z.string(),
  /** 계산에 쓴 오늘 */
  today: IsoDateSchema,
  /** 모델이 뽑은 그대로 */
  extraction: QuoteExtractionSchema,
  conditions: QuoteConditionsSchema,
  /** 맞는 상품(QUOTE_LIMITS.maxCandidates 까지)과 전체 수 */
  candidates: z.array(QuoteCandidateSchema),
  candidateCount: z.number().int().min(0),
  excluded: z.array(QuoteExcludedSchema),
  /** 살핀 상품의 자리 */
  catalog: z.enum(QUOTE_CATALOGS),
  /** 살핀 상품 수(그 자리에 등록된 상품 전체) */
  productCount: z.number().int().min(0),
  /** 답장을 쓴 상품. 맞는 상품이 없거나, 종류·갈래·지역이 하나도 없어 고르지 않았으면 null. */
  selectedProductId: z.number().int().positive().nullable(),
  reply: QuoteReplySchema,
  llm: z.object({
    extract: QuoteCallSchema,
    /** 답장을 모델이 쓰지 못했으면 null 이고 replySkipCause 에 까닭. 되묻는 틀 문장(상품을 고르지 않음)이면 둘 다 null. */
    reply: QuoteCallSchema.nullable(),
    replySkipCause: z.enum(LLM_SKIP_CAUSES).nullable(),
  }),
  /** 확정된 답장. 확정 전이면 null. */
  confirmedReply: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  createdAt: z.string().min(1),
});
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

/**
 * POST /api/quotes/:id/confirm 의 요청. 사람이 본(고친) 답장 글이다.
 * 자리표시({total} 같은 것)가 남아 있으면 400. 이미 확정된 견적이면 422 BAD_TRANSITION. 다른 공간의 견적이면 404.
 * 확정은 표에 적는 것까지다. 메신저로 보내지 않는다.
 */
export const QuoteConfirmRequestSchema = z.strictObject({
  reply: z.string().trim().min(1).max(QUOTE_LIMITS.replyMaxChars),
});
export type QuoteConfirmRequest = z.infer<typeof QuoteConfirmRequestSchema>;
