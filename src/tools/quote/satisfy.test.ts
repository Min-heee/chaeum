// 고른 상품이 조건을 정말 채우는지 다른 길로 다시 본다. 보기 문의 20건의 정답 조건 × 지어낸 상품 8개.
// matchQuote 가 쓰는 함수(regionMatches, priceProduct, countDeadlines)를 부르지 않고 따로 센다:
//  - 종류·갈래: 값이 같은가      - 예산: 상품의 옵션 표에서 직접 찾은 값이 예산 이하인가
//  - 지역: 사람이 미리 적어 둔 표(이 지명이면 이 상품들이 맞다)에 드는가
//  - 마감: 기준일에서 일수를 뺀 날이 오늘 이후인가(날 번호를 따로 센다)
// 여기서 나온 수(맞는 상품 27개가 모두 조건을 채움, 지역 글자 견주기가 놓친 상품 1개)를 docs/EVALUATION-TOOLS.md 에 적었다.
import { describe, expect, it } from 'vitest';
import type { QuoteCandidate, QuoteConditions, QuoteProduct } from '@/contract/tools/quote';
import { FIXTURE_PRODUCTS } from '../../../tests/tools/quote-fixtures';
import { matchQuote } from './match';
import { quoteSamples, SAMPLE_TODAY, type QuoteSample } from './samples';

/** 사람이 적은 표: 이 지명을 말한 손님에게 보여 줘도 되는 상품(번호). 굿즈(7, 8)는 지역이 없어 늘 된다. */
const REGION_OK: Record<string, number[]> = {
  홍대: [1, 4, 5, 7, 8],
  합정역: [2, 4, 5, 7, 8],
  강남역: [3, 4, 5, 7, 8],
  상암동: [4, 5, 6, 7, 8],
  성수동: [4, 5, 6, 7, 8],
  서울: [1, 2, 3, 4, 5, 6, 7, 8],
};

const conditionsOf = (s: QuoteSample): QuoteConditions => ({
  lang: s.lang, budgetKrw: s.expected.budgetKrw, budgetBy: s.expected.budgetKrw === null ? null : 'code', region: s.expected.region,
  dateFrom: s.expected.dateFrom, dateTo: s.expected.dateTo, dateProblem: false, type: s.expected.type, subtype: s.expected.subtype,
  qty: s.expected.qty, days: s.expected.days,
});

const dayOf = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/** 옵션 표에서 직접 찾은 값. 바라는 크기가 없으면 가장 작은 옵션, 있으면 그 크기 이상에서 가장 작은 옵션. */
function priceByHand(product: QuoteProduct, c: QuoteConditions): number | null {
  if (product.type === 'goods') {
    const min = (product.spec.min_order_qty as number | undefined) ?? 1;
    if (c.qty !== null && c.qty < min) return null;
    return product.price_krw * (c.qty ?? min);
  }
  const key = product.type === 'ad' ? 'days' : 'qty';
  const want = product.type === 'ad' ? c.days : c.qty;
  const options = (product.options as Record<string, number>[]).filter((o) => want === null || (o[key] as number) >= want).sort((a, b) => (a[key] as number) - (b[key] as number));
  return options[0]?.price_krw ?? null;
}

function problemsOf(c: QuoteConditions, candidate: QuoteCandidate): string[] {
  const product = FIXTURE_PRODUCTS.find((p) => p.id === candidate.productId) as QuoteProduct;
  const out: string[] = [];
  if (c.type !== null && product.type !== c.type) out.push('종류');
  if (c.subtype !== null && product.subtype !== c.subtype) out.push('갈래');
  if (c.region !== null && !(REGION_OK[c.region] ?? []).includes(product.id)) out.push('지역');
  const total = priceByHand(product, c);
  if (total === null || total !== candidate.pricing.totalKrw) out.push('총액');
  if (c.budgetKrw !== null && (total === null || total > c.budgetKrw)) out.push('예산');
  if (c.dateFrom !== null) {
    const start = dayOf(c.dateFrom);
    const daysBefore = ['booking_deadline_days', 'material_deadline_days', 'design_deadline_days', 'lead_time_days'].map((k) => product.spec[k]).filter((v): v is number => typeof v === 'number');
    if (start < dayOf(SAMPLE_TODAY) || daysBefore.some((d) => start - d < dayOf(SAMPLE_TODAY))) out.push('마감');
  }
  return out;
}

describe('고른 상품이 조건을 채우는가(다른 길로 다시 세기)', () => {
  const samples = quoteSamples();
  const runs = samples.map((s) => ({ s, c: conditionsOf(s), result: matchQuote(conditionsOf(s), FIXTURE_PRODUCTS, SAMPLE_TODAY) }));

  it('보기 문의 20건에서 고른 상품은 모두 조건을 채운다', () => {
    const all = runs.flatMap(({ s, c, result }) => result.candidates.map((cand) => ({ id: s.id, product: cand.name, problems: problemsOf(c, cand) })));
    expect(all.filter((x) => x.problems.length > 0)).toEqual([]);
    expect(all).toHaveLength(27);
    // 맞는 상품이 하나도 없는 문의도 있다(숨기지 않는다).
    expect(runs.filter((r) => r.result.candidates.length === 0).map((r) => r.s.id)).toEqual(['q-zh-06']);
  });

  it('지역을 글자로만 견줘서 놓치는 상품이 있다: 사람은 맞다고 볼 상품이 "지역이 다름"만으로 빠진 경우', () => {
    const missed = runs.flatMap(({ s, c, result }) =>
      result.excluded
        .filter((e) => e.reasons.length === 1 && e.reasons[0] === 'region_mismatch' && c.region !== null && (REGION_OK[c.region] ?? []).includes(e.productId))
        .map((e) => `${s.id}:${e.name}`),
    );
    // "홍대"가 서울인 줄 모른다. 그래서 위치가 "서울"로만 적힌 버스 광고가 홍대 문의에서 빠진다.
    expect(missed).toEqual(['q-ko-01:서울 시내버스 외부 광고']);
  });
});
