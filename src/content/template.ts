// 틀 문장. 모델을 못 불렀거나 모델 글이 두 번 다 검사에 걸렸을 때 코드가 만드는 기본 글이다.
// 같은 입력이면 늘 같은 글이 나온다. 한글 이름은 옮길 수 없으므로 넣지 않는다.
// 그래서 글이 밋밋하고, 언제나 "확인 필요"(needs_review)로 나간다. 사람이 고쳐 쓰라는 뜻이다.
import {
  LANGS,
  TEXT_FIELDS,
  type ContentApi,
  type ContentInput,
  type GeneratedText,
  type Lang,
  type Placeholder,
} from '@/contract/content';
import type { ProductType, Subtype } from '@/contract/fields';
import { fillPlaceholders } from './format';
import { includesTerm, termsIn } from './glossary';
import { lineRules } from './line-check';

/** 갈래의 기본 표기. 갈래는 닫힌 목록이라 여기 다 적을 수 있다. 용어집에 같은 낱말이 있으면 그 표기가 뒤에 덧붙는다. */
const SUBTYPE_WORDS = {
  전광판: { en: 'Digital billboard', 'zh-Hans': '电子屏广告' },
  지하철: { en: 'Subway ad', 'zh-Hans': '地铁广告' },
  버스: { en: 'Bus ad', 'zh-Hans': '公交广告' },
  커피차: { en: 'Coffee truck', 'zh-Hans': '咖啡车' },
  도시락: { en: 'Lunch box', 'zh-Hans': '便当' },
  인쇄물: { en: 'Printed goods', 'zh-Hans': '印刷品' },
  잡화: { en: 'Merchandise', 'zh-Hans': '周边商品' },
} as const satisfies Record<Subtype, Record<Lang, string>>;

/** 갈래가 목록에 없을 때 쓰는 종류의 표기. */
const TYPE_WORDS: Record<ProductType, Record<Lang, string>> = {
  ad: { en: 'Ad space', 'zh-Hans': '广告位' },
  catering: { en: 'Catering', 'zh-Hans': '餐饮服务' },
  goods: { en: 'Goods', 'zh-Hans': '商品' },
};

/** 자리표시마다의 한 문장. 단수·복수를 가리지 않아도 되는 꼴로 적었다. */
const SENTENCES: Record<Lang, { end: string } & Record<Placeholder, string>> = {
  en: { end: '. ', price: 'Price from {price}.', days: 'Minimum period: {days} day(s).', qty: 'Minimum quantity: {qty}.' },
  'zh-Hans': { end: '。', price: '价格{price}起。', days: '最短{days}天。', qty: '最少数量{qty}。' },
};

const JOIN = ' · ';

function headOf(content: ContentInput, lang: Lang): string {
  const known: Record<string, Record<Lang, string>> = SUBTYPE_WORDS;
  return Object.hasOwn(known, content.subtype) ? known[content.subtype]![lang] : TYPE_WORDS[content.type][lang];
}

/**
 * 제목: 갈래의 표기 뒤에 갈래·이름·지역에서 찾은 용어집 표기를 잇는다. "Digital billboard · Gangnam Station"
 * 이미 들어 있는 표기는 또 적지 않는다.
 */
function titleOf(content: ContentInput, lang: Lang): string {
  let title = headOf(content, lang);
  for (const text of [content.subtype, content.name, content.region]) {
    for (const term of termsIn(text, content.glossary, lang)) {
      if (!includesTerm(title, term)) title += JOIN + term;
    }
  }
  return title;
}

/** 요약: 제목 한 줄 + 쓸 수 있는 자리표시마다 한 문장. 값이 없는 자리표시의 문장은 넣지 않는다. */
function summaryOf(title: string, placeholders: readonly Placeholder[], lang: Lang): string {
  const s = SENTENCES[lang];
  // 표기가 마침표로 끝나면("Univ.") 마침표를 또 찍지 않는다.
  const first = title.replace(/[.。]$/, '') + s.end;
  return (first + placeholders.map((p) => s[p]).join(lang === 'en' ? ' ' : '')).trim();
}

/**
 * 코드가 만든 기본 글 4줄(LANGS × TEXT_FIELDS 순서). failCodes 는 비워 둔다.
 * 모델 글이 걸려서 내려온 줄이면 부르는 쪽(generateContent)이 그 코드를 채운다.
 */
export const templateTexts: ContentApi['templateTexts'] = (input) => {
  const rules = lineRules(input);
  return LANGS.flatMap((lang) => {
    const title = titleOf(input.content, lang);
    return TEXT_FIELDS.map((field): GeneratedText => {
      const rule = rules.find((r) => r.lang === lang && r.field === field)!;
      const withPlaceholders = field === 'title' ? title : summaryOf(title, rule.requiredPlaceholders, lang);
      return {
        field,
        lang,
        text: fillPlaceholders(withPlaceholders, rule.values, lang),
        source: 'template',
        status: 'needs_review',
        failCodes: [],
        withPlaceholders,
      };
    });
  });
};
