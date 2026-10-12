// 승인된 상품에 붙는 다른 언어 글(제목·요약)의 약속.
import { z } from 'zod';
import type { ProductType } from './fields';
import type { ContentFailCode } from './reasons';

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
