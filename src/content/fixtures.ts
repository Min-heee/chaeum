// 시험에서만 쓰는 재료: 작은 용어집, 상품 셋, 정해 둔 답을 차례로 내주는 공급자.
// 이름과 값은 모두 지어낸 것이다.
import {
  PLACEHOLDERS,
  type ContentDraft,
  type ContentInput,
  type GenerateContentInput,
  type GlossaryEntry,
  type PlaceholderValues,
} from '@/contract/content';
import type { LlmProvider, LlmRequest, LlmResult } from '@/contract/llm-types';
import { pickGlossary } from './glossary';

export const GLOSSARY: GlossaryEntry[] = [
  { ko: '전광판', en: 'digital billboard', 'zh-Hans': '电子屏' },
  { ko: '강남역', en: 'Gangnam Station', 'zh-Hans': '江南站' },
  { ko: '커피', en: 'coffee', 'zh-Hans': '咖啡' },
  { ko: '커피차', en: 'coffee truck', 'zh-Hans': '咖啡车' },
  { ko: '합정역', en: 'Hapjeong Station', 'zh-Hans': '合井站' },
  { ko: '포토카드', en: 'photocard', 'zh-Hans': '小卡' },
  { ko: '광고 지면', en: 'ad space', 'zh-Hans': '广告位' },
  { ko: '2호선', en: 'Line 2', 'zh-Hans': '2号线' },
];

export type Facts = Pick<ContentInput, 'type' | 'subtype' | 'name' | 'region'>;

export const AD: Facts = { type: 'ad', subtype: '전광판', name: '하늘빛 전광판', region: '강남역 11번 출구' };
export const CATERING: Facts = { type: 'catering', subtype: '커피차', name: '달보드레 커피차', region: '합정역' };
export const GOODS: Facts = { type: 'goods', subtype: '인쇄물', name: '별무리 포토카드 세트', region: null };

export const AD_VALUES: PlaceholderValues = { price: 1_500_000, days: 7 };
export const CATERING_VALUES: PlaceholderValues = { price: 800_000, qty: 100 };
/** 기간도 수량도 없는 상품. 쓸 수 있는 자리표시는 {price} 뿐이다. */
export const GOODS_VALUES: PlaceholderValues = { price: 12_000 };

/** 처리기가 하는 것과 같은 방식으로 입력을 만든다: 용어집 줄을 고르고, 값이 있는 자리표시만 알려 준다. */
export function inputOf(facts: Facts, values: PlaceholderValues, glossary: readonly GlossaryEntry[] = GLOSSARY): GenerateContentInput {
  return {
    content: { ...facts, glossary: pickGlossary(glossary, facts), placeholders: PLACEHOLDERS.filter((p) => values[p] !== undefined) },
    values,
  };
}

/** 검사를 모두 통과하는 답. */
export const GOOD_AD: ContentDraft = {
  en: { title: 'Haneulbit Digital Billboard', summary: 'A digital billboard at Gangnam Station Exit 11, from {price} for {days} days.' },
  'zh-Hans': { title: 'Haneulbit 电子屏', summary: '江南站11号出口的电子屏广告位，{days}天{price}起。' },
};
export const GOOD_CATERING: ContentDraft = {
  en: { title: 'Dalbodeure Coffee Truck', summary: 'A coffee truck serving the Hapjeong Station area, from {price} for {qty} cups.' },
  'zh-Hans': { title: 'Dalbodeure 咖啡车', summary: '可前往合井站一带的咖啡车，{qty}杯{price}起。' },
};
export const GOOD_GOODS: ContentDraft = {
  en: { title: 'Byeolmuri Photocard Set', summary: 'A set of printed photocards, from {price}.' },
  'zh-Hans': { title: 'Byeolmuri 小卡套装', summary: '印刷小卡套装，{price}起。' },
};

/** 답의 한 줄만 바꾼 것을 만든다. */
export function withLine(draft: ContentDraft, lang: 'en' | 'zh-Hans', field: 'title' | 'summary', text: string): ContentDraft {
  return { ...draft, [lang]: { ...draft[lang], [field]: text } };
}

export const TEST_MODEL = 'test-model';

/** 정해 둔 답(또는 던질 오류)을 부른 순서대로 내주는 공급자. 받은 요청을 적어 둔다. */
export function scripted(steps: readonly (ContentDraft | Error)[]): { provider: LlmProvider; requests: LlmRequest<unknown>[] } {
  const requests: LlmRequest<unknown>[] = [];
  const provider: LlmProvider = {
    name: 'fake',
    model: TEST_MODEL,
    async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      requests.push(req as LlmRequest<unknown>);
      const step = steps[requests.length - 1];
      if (step === undefined) throw new Error('정해 둔 답보다 많이 불렀다');
      if (step instanceof Error) throw step;
      return { output: req.schema.parse(step), stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50 }, latencyMs: 12, recorded: false };
    },
  };
  return { provider, requests };
}
