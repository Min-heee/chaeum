// 종류와 갈래를 낱말로 가른다. 점수가 모자라거나 비기면 "등록 대상 아님"으로 둔다.
import type { ProductType } from '@/contract/fields';

type Weighted = [RegExp, number];

const TYPE_WORDS: Record<ProductType, Weighted[]> = {
  ad: [
    [/전광판|빌보드|사이니지|LED|billboard|大屏|广告牌|电子屏/i, 3],
    [/지하철|스크린\s?도어|와이드\s?컬러|조명\s?광고|subway|地铁/i, 3],
    [/버스|정류장|쉘터|(?<![a-z])bus(?![a-z])|公交/i, 3],
    [/광고|广告|(?<![a-z])ads?(?![a-z])/i, 2],
    [/송출|게재|구좌/, 1],
    [/유동\s?인구|人流/, 1],
    [/해상도|分辨率/, 1],
  ],
  catering: [
    [/커피차|간식차|분식차|푸드\s?트럭|coffee\s?truck|咖啡车|餐车/i, 3],
    [/도시락|lunch\s?box|便当|盒饭/i, 3],
    [/케이터링|catering|서포트/i, 2],
    [/\d\s?(?:잔|인분)/, 1],
    [/메뉴|출장|촬영장/, 1],
  ],
  goods: [
    [/굿즈|goods|周边/i, 3],
    [/포토\s?카드|포카|슬로건|엽서|스티커|전단|리플렛|현수막/, 3],
    [/키링|아크릴|부채|머그|텀블러|에코백|뱃지|배지|응원봉|파우치|티셔츠|그립톡/, 3],
    [/컵\s?홀더|포스터|배너/, 2],
    [/제작\s?(?:기간|소요)|최소\s?(?:주문|수량)|MOQ/i, 1],
    [/재질|용지|평량|코팅|인쇄/, 1],
  ],
};

const SUBTYPE_WORDS: Record<ProductType, [string, RegExp][]> = {
  ad: [
    ['전광판', /전광판|빌보드|사이니지|LED|스크린(?!\s?도어)|billboard|大屏|电子屏/gi],
    ['지하철', /지하철|스크린\s?도어|역사|호선|subway|地铁/gi],
    ['버스', /버스|정류장|쉘터|(?<![a-z])bus(?![a-z])|公交/gi],
  ],
  catering: [
    ['커피차', /커피차|간식차|분식차|푸드\s?트럭|coffee\s?truck|咖啡车|餐车/gi],
    ['도시락', /도시락|lunch\s?box|便当|盒饭/gi],
  ],
  goods: [
    ['인쇄물', /포토\s?카드|포카|슬로건|엽서|스티커|포스터|컵\s?홀더|전단|리플렛|현수막|배너|인쇄|용지/g],
    ['잡화', /키링|아크릴|부채|머그|텀블러|에코백|뱃지|배지|응원봉|파우치|티셔츠|그립톡/g],
  ],
};

/** 종류를 정하는 데 필요한 가장 낮은 점수. 뚜렷한 낱말 하나(3점)는 있어야 한다. */
const MIN_TYPE_SCORE = 3;

/** 낱말 점수가 가장 높은 종류. 점수가 모자라거나 1등이 둘이면 null. */
export function guessType(text: string): ProductType | null {
  const scored = (Object.keys(TYPE_WORDS) as ProductType[])
    .map((type) => ({ type, score: TYPE_WORDS[type].reduce((sum, [re, w]) => sum + (re.test(text) ? w : 0), 0) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored as [(typeof scored)[number], (typeof scored)[number]];
  if (best.score < MIN_TYPE_SCORE || best.score === second.score) return null;
  return best.type;
}

/** 그 종류의 갈래 가운데 낱말이 가장 많이 나온 것. 같으면 먼저 나온 것. 하나도 없으면 null. */
export function guessSubtype(type: ProductType, text: string): string | null {
  let best: { name: string; count: number; first: number } | null = null;
  for (const [name, re] of SUBTYPE_WORDS[type]) {
    const hits = [...text.matchAll(re)];
    if (hits.length === 0) continue;
    const cand = { name, count: hits.length, first: hits[0]!.index };
    if (!best || cand.count > best.count || (cand.count === best.count && cand.first < best.first)) best = cand;
  }
  return best?.name ?? null;
}
