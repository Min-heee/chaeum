// 승인된 상품에 붙는 다른 언어 글(제목·요약)의 약속.
import { z } from 'zod';
import type { ProductType } from './fields';
import type { LlmProvider, LlmUsage } from './llm-types';
import { CONTENT_CHECKS, CONTENT_FAIL_CODES, type ContentCheck, type ContentFailCode, type LlmSkipCause } from './reasons';

export const LANGS = ['en', 'zh-Hans'] as const;
export type Lang = (typeof LANGS)[number];

export const LANG_LABELS: Record<Lang, string> = { en: '영어', 'zh-Hans': '중국어(간체)' };

export const TEXT_FIELDS = ['title', 'summary'] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

/** 글의 출처. llm: 모델이 씀, template: 코드가 만든 틀 문장, human: 사람이 고침. */
export const TEXT_SOURCES = ['llm', 'template', 'human'] as const;
export type TextSource = (typeof TEXT_SOURCES)[number];

export const TEXT_STATUSES = ['ok', 'needs_review'] as const;
export type TextStatus = (typeof TEXT_STATUSES)[number];

/**
 * 자리표시. 모델은 숫자를 쓰지 않고 {price} 처럼만 쓴다. 숫자는 코드가 넣는다.
 * - price: 대표 판매가   - days: 가장 짧은 기간의 일수   - qty: 가장 적은 수량
 */
export const PLACEHOLDERS = ['price', 'days', 'qty'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/** 글 안에서 자리표시를 찾는 꼴. {price} */
export const PLACEHOLDER_PATTERN = /\{([a-z_]+)\}/g;

/** 용어집 한 줄. 한국어 낱말을 각 언어에서 어떻게 적는지. 사람이 확인한 표기만 넣는다. */
export const GlossaryEntrySchema = z.object({
  ko: z.string().min(1),
  en: z.string().min(1),
  'zh-Hans': z.string().min(1),
});
export type GlossaryEntry = z.infer<typeof GlossaryEntrySchema>;
export const GlossarySchema = z.array(GlossaryEntrySchema);

/**
 * 글 만들기에 넘기는 자료. 글자 정보만 넣는다. 숫자(값, 일수, 수량)는 넣지 않는다.
 * 그래야 값을 고쳐 승인해도 같은 요청이 된다.
 */
export interface ContentInput {
  type: ProductType;
  subtype: string;
  name: string;
  /** 광고 지면의 위치 또는 케이터링의 출장 지역. 없으면 null. */
  region: string | null;
  /** 이 상품에 해당하는 용어집 줄. */
  glossary: GlossaryEntry[];
  /** 글에 써도 되는 자리표시. */
  placeholders: Placeholder[];
}

const TextPairSchema = z.object({ title: z.string(), summary: z.string() });

/** 모델이 한 번에 내는 두 언어 글. 숫자 자리는 자리표시다. */
export const ContentDraftSchema = z.object({
  en: TextPairSchema,
  'zh-Hans': TextPairSchema,
});
export type ContentDraft = z.infer<typeof ContentDraftSchema>;

/** 저장되는 글 한 줄(product_texts). */
export interface ProductText {
  field: TextField;
  lang: Lang;
  text: string;
  source: TextSource;
  status: TextStatus;
  failCodes: ContentFailCode[];
}

// ── src/content 가 내보낼 함수 ──────────────────────────────

/** 자리표시에 넣을 숫자. 없는 자리표시는 글에 쓰지 못한다(ContentInput.placeholders 와 같은 이름만). */
export type PlaceholderValues = Partial<Record<Placeholder, number>>;

/** 글 만들기 한 번에 넘기는 것. */
export interface GenerateContentInput {
  /** 모델에게 가는 글자 정보. 숫자는 없다. */
  content: ContentInput;
  /** 코드가 자리표시에 넣을 숫자. 모델에게는 가지 않는다. */
  values: PlaceholderValues;
}

/**
 * 글 한 줄의 결과. ProductText 와 같은 꼴에 "자리표시인 채의 글"이 붙는다.
 * - source 'llm': 모델 글이 검사를 통과했다. status 는 'ok', failCodes 는 [].
 * - source 'template': 틀 문장으로 내려왔다. status 는 언제나 'needs_review'.
 *   failCodes 는 모델의 마지막 글이 걸린 코드다(모델을 못 불렀으면 []). 왜 내려왔는지를 화면이 이것으로 적는다.
 */
export interface GeneratedText extends ProductText {
  /** 숫자를 넣기 전의 글({price} 가 그대로 있다). */
  withPlaceholders: string;
}

/** 모델을 한 번 부른 기록. 비용과 시간을 셀 때 쓴다. */
export interface ContentCall {
  /** 1 = 첫 요청, 2 = 걸린 검사를 알려 준 다시 하기 */
  attempt: 1 | 2;
  recorded: boolean;
  latencyMs: number;
  usage: LlmUsage;
}

export interface ContentGeneration {
  /** 언어 2 × 칸 2 = 4줄. LANGS × TEXT_FIELDS 순서. 숫자가 들어간 끝 글이다. */
  texts: GeneratedText[];
  /** 모델을 부른 기록(0~2줄). */
  calls: ContentCall[];
  /** 모델을 못 불러 전부 틀 문장이 됐을 때의 까닭. 불렀으면 null. */
  skipCause: LlmSkipCause | null;
}

/**
 * src/content/index.ts 가 이 꼴대로 내보낸다. DB 를 모른다(저장은 부르는 쪽이 한다).
 *
 * generateContent 의 순서:
 *  1. 모델을 한 번 부른다(두 언어를 함께). 글 4줄을 각각 검사한다(core.checkContent).
 *  2. 걸린 줄이 있으면 무엇이 걸렸는지 retryHint 에 적어 한 번만 다시 부른다.
 *  3. 그래도 걸린 줄만 틀 문장으로 바꾼다(줄 단위다. 통과한 줄은 모델 글을 그대로 쓴다).
 *  4. 통과한 글의 자리표시에 숫자를 넣는다.
 * 모델이 답을 못 주면(LlmUnavailable):
 *  - retryable(잠깐의 오류)이면 그대로 던진다. 작업 줄이 다시 한다.
 *  - 아니면 4줄 모두 틀 문장으로 채우고 skipCause 를 적는다. 던지지 않는다.
 * provider 가 null 이면 부르지 않고 바로 틀 문장이다(skipCause 는 부르는 쪽이 준 값).
 */
export interface ContentApi {
  generateContent(
    input: GenerateContentInput,
    provider: LlmProvider | null,
    skipCause?: LlmSkipCause,
  ): Promise<ContentGeneration>;
  /** 코드가 만든 기본 글 4줄. 모델 없이도 늘 같은 글이 나온다. 용어집 표기를 쓴다. */
  templateTexts(input: GenerateContentInput): GeneratedText[];
  /** 자리표시에 숫자를 넣는다. 금액은 언어별 서식(en: "KRW 1,500,000", zh-Hans: "1,500,000韩元"). */
  fillPlaceholders(text: string, values: PlaceholderValues, lang: Lang): string;
  /** 상품에 해당하는 용어집 줄만 고른다(종류·갈래·이름·지역에 한국어 낱말이 들어 있는 줄). */
  pickGlossary(glossary: readonly GlossaryEntry[], facts: Pick<ContentInput, 'type' | 'subtype' | 'name' | 'region'>): GlossaryEntry[];
}

// ── 번역 검사 API (POST /api/content-checks) ────────────────

/** 한 번에 검사하는 글의 수와 글 하나의 길이. */
export const CONTENT_CHECK_LIMITS = { maxItems: 50, textMaxChars: 2000 } as const;

/**
 * 이미 번역된 글 한 줄. 숫자가 들어간 끝 글을 넣는다(자리표시가 남아 있으면 그것도 걸린다).
 * 모델을 부르지 않고 DB 에 쓰지 않는다.
 */
export const ContentCheckItemSchema = z.object({
  /** (선택) 부르는 쪽의 번호. 응답에 그대로 돌아온다. */
  id: z.string().max(100).optional(),
  lang: z.enum(LANGS),
  field: z.enum(TEXT_FIELDS),
  text: z.string().max(CONTENT_CHECK_LIMITS.textMaxChars),
  /** (선택) 한국어 원문. 주면 용어집에서 그 안의 낱말을 찾아 이 언어의 표기가 글에 있는지 본다. */
  sourceKo: z.string().max(CONTENT_CHECK_LIMITS.textMaxChars).optional(),
  /** (선택) 글에 꼭 있어야 하는 표기를 직접 준다. sourceKo 로 찾은 것에 더해진다. */
  requiredTerms: z.array(z.string().min(1).max(100)).max(20).optional(),
  /**
   * (선택) 글에 나와도 되는 숫자("1500000", "7"). 주면 그 밖의 숫자를 잡는다.
   * 안 주면 무엇이 맞는 숫자인지 알 수 없으므로 숫자 검사를 건너뛴다(skipped).
   */
  allowedNumbers: z.array(z.string().min(1).max(30)).max(50).optional(),
});
export type ContentCheckItem = z.infer<typeof ContentCheckItemSchema>;

export const ContentCheckRequestSchema = z.object({
  items: z.array(ContentCheckItemSchema).min(1).max(CONTENT_CHECK_LIMITS.maxItems),
});
export type ContentCheckRequest = z.infer<typeof ContentCheckRequestSchema>;

export const CHECK_OUTCOMES = ['pass', 'fail', 'skipped'] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

export const ContentCheckResultSchema = z.object({
  /** 요청에 준 번호. 안 줬으면 null. */
  id: z.string().nullable(),
  /** 요청의 몇 번째 글인가(0부터). */
  index: z.number().int().min(0),
  lang: z.enum(LANGS),
  field: z.enum(TEXT_FIELDS),
  status: z.enum(TEXT_STATUSES),
  failCodes: z.array(z.enum(CONTENT_FAIL_CODES)),
  /** 검사 5종 각각의 결과. */
  checks: z.record(z.enum(CONTENT_CHECKS), z.enum(CHECK_OUTCOMES)),
});
export type ContentCheckResult = z.infer<typeof ContentCheckResultSchema>;

export const ContentCheckResponseSchema = z.object({
  results: z.array(ContentCheckResultSchema),
  /**
   * ok: 돌린 검사에 하나도 걸리지 않은 글의 수. 건너뛴 검사가 있어도 ok 다.
   * withSkipped: 건너뛴 검사가 하나라도 있는 글의 수. "ok" 가 다섯 가지를 다 봤다는 뜻이 아님을 이것으로 안다
   * (맞는 숫자를 안 주면 숫자 검사를, 찾아볼 표기가 없으면 용어 검사를 건너뛴다).
   */
  summary: z.object({ total: z.number().int(), ok: z.number().int(), needsReview: z.number().int(), withSkipped: z.number().int() }),
});
export type ContentCheckResponse = z.infer<typeof ContentCheckResponseSchema>;

/** 검사 5종의 결과 표를 만들 때 쓰는 타입. */
export type CheckOutcomes = Record<ContentCheck, CheckOutcome>;
