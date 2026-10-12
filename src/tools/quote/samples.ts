// 보기 문의(data/seed/quote-samples.json)와 그 채점. 순수 함수다.
// 문의 20건(한국어 8, 영어 6, 중국어 6)은 직접 지은 것이고, 조건의 정답도 지은 쪽이 먼저 정했다. 사람이 확인하기 전이다.
// 중국어 글은 뜻이 통하게 썼을 뿐이고 자연스러운지는 판단하지 않았다.
import { z } from 'zod';
import { PRODUCT_TYPES } from '@/contract/fields';
import { IsoDateSchema } from '@/contract/tools/dates';
import { QUOTE_LANGS, QUOTE_LIMITS, type QuoteConditions } from '@/contract/tools/quote';
import samplesJson from '../../../data/seed/quote-samples.json';
import { regionCore } from './match';

/** 정답의 날짜는 이 날을 오늘로 놓고 정했다. 채점할 때도 이 날을 오늘로 넣는다. */
export const SAMPLE_TODAY = '2026-10-12';

export const QuoteSampleSchema = z.strictObject({
  id: z.string().min(1),
  lang: z.enum(QUOTE_LANGS),
  label: z.string().min(1),
  text: z.string().min(1).max(QUOTE_LIMITS.textMaxChars),
  /** 조건의 정답. 글에 없는 조건은 null. 예산은 원이 아닌 돈이면 null(환율로 바꾸지 않는다). */
  expected: z.strictObject({
    budgetKrw: z.number().int().positive().nullable(),
    region: z.string().nullable(),
    dateFrom: IsoDateSchema.nullable(),
    dateTo: IsoDateSchema.nullable(),
    type: z.enum(PRODUCT_TYPES).nullable(),
    subtype: z.string().nullable(),
    qty: z.number().int().positive().nullable(),
    days: z.number().int().positive().nullable(),
  }),
});
export type QuoteSample = z.infer<typeof QuoteSampleSchema>;

/** 보기 문의 전부. 꼴이 틀리면 여기서 멈춘다. */
export function quoteSamples(): QuoteSample[] {
  return z.array(QuoteSampleSchema).parse(samplesJson);
}

/** 채점하는 칸 여덟. 날짜는 범위의 첫날과 끝날이 모두 같아야 맞다. */
export const SAMPLE_FIELDS = ['lang', 'budget', 'region', 'date', 'type', 'subtype', 'qty', 'days'] as const;
export type SampleField = (typeof SAMPLE_FIELDS)[number];

export const SAMPLE_FIELD_LABELS: Record<SampleField, string> = {
  lang: '언어',
  budget: '예산',
  region: '지역',
  date: '날짜',
  type: '종류',
  subtype: '갈래',
  qty: '수량',
  days: '기간',
};

/**
 * 뽑힌 조건(코드가 다듬은 것)을 정답과 견준다. 칸마다 맞았는가.
 * 지역은 "근처" 같은 말과 공백을 떼고 견준다("홍대 근처" 와 "홍대"는 같다). 나머지는 값이 꼭 같아야 한다.
 */
export function scoreSample(sample: QuoteSample, got: QuoteConditions): Record<SampleField, boolean> {
  const want = sample.expected;
  const core = (region: string | null) => (region === null ? null : regionCore(region));
  return {
    lang: got.lang === sample.lang,
    budget: got.budgetKrw === want.budgetKrw,
    region: core(got.region) === core(want.region),
    date: got.dateFrom === want.dateFrom && got.dateTo === want.dateTo,
    type: got.type === want.type,
    subtype: got.subtype === want.subtype,
    qty: got.qty === want.qty,
    days: got.days === want.days,
  };
}
