import { describe, expect, it } from 'vitest';
import { QuoteCandidateSchema, QuoteExcludedSchema, type QuoteConditions, type QuoteProduct } from '@/contract/tools/quote';
import { resolveConditions } from './conditions';
import { hasSearchCondition, matchQuote, pickOption, priceProduct, regionCore, regionMatches } from './match';

const TODAY = '2026-10-12';
const ANY: QuoteConditions = {
  lang: 'ko', budgetKrw: null, budgetBy: null, region: null, dateFrom: null, dateTo: null, dateProblem: false, type: null, subtype: null, qty: null, days: null,
};

// 지어낸 상품 넷. 값과 이름은 모두 꾸민 것이다.
const BILLBOARD: QuoteProduct = {
  id: 1, type: 'ad', subtype: '전광판', name: '합정역 7번출구 루미온 스퀘어 전광판', price_krw: 1_500_000, vat_included: false,
  spec: { region: '합정역 7번출구', booking_deadline_days: 7, material_deadline_days: 14 },
  options: [{ days: 7, price_krw: 1_500_000 }, { days: 14, price_krw: 2_800_000 }],
};
const SUBWAY: QuoteProduct = {
  id: 2, type: 'ad', subtype: '지하철', name: '강남역 스크린도어 조명광고', price_krw: 3_200_000, vat_included: null,
  spec: { region: '강남역' },
  options: [{ days: 30, price_krw: 3_200_000 }],
};
const TRUCK: QuoteProduct = {
  id: 3, type: 'catering', subtype: '커피차', name: '달보드레 커피차', price_krw: 800_000, vat_included: true,
  spec: { service_region: '서울, 경기 남부', design_deadline_days: 5 },
  options: [{ qty: 100, price_krw: 800_000 }, { qty: 200, price_krw: 1_500_000 }, { qty: 300, price_krw: 2_100_000 }],
};
const CARDS: QuoteProduct = {
  id: 4, type: 'goods', subtype: '인쇄물', name: '별무리 포토카드 세트', price_krw: 900, vat_included: true,
  spec: { min_order_qty: 100, lead_time_days: 10 },
  options: [],
};
const ALL = [BILLBOARD, SUBWAY, TRUCK, CARDS];

const ids = (list: { productId: number }[]) => list.map((c) => c.productId);
const reasonsOf = (result: ReturnType<typeof matchQuote>, id: number) => result.excluded.find((e) => e.productId === id)?.reasons;

describe('옵션 고르기', () => {
  const options = [{ size: 14, price_krw: 280 }, { size: 7, price_krw: 150 }, { size: 30, price_krw: 500 }];
  it('바라는 것이 없으면 가장 작은 옵션', () => {
    expect(pickOption(options, null)).toEqual({ option: { size: 7, price_krw: 150 }, exact: true });
  });
  it('같은 옵션이 있으면 그것', () => {
    expect(pickOption(options, 14)).toEqual({ option: { size: 14, price_krw: 280 }, exact: true });
  });
  it('같은 것이 없으면 그보다 큰 것 가운데 가장 작은 것이고 exact 가 거짓이다(나눠서 지어내지 않는다)', () => {
    expect(pickOption(options, 10)).toEqual({ option: { size: 14, price_krw: 280 }, exact: false });
    expect(pickOption(options, 1)).toEqual({ option: { size: 7, price_krw: 150 }, exact: false });
  });
  it('가장 큰 옵션보다 크면 없다', () => {
    expect(pickOption(options, 31)).toBeNull();
    expect(pickOption([], null)).toBeNull();
  });
});

describe('총액', () => {
  it('광고: 기간 옵션의 값이 총액이다. 부가세 별도여도 더하지 않고 표시만 한다', () => {
    expect(priceProduct(BILLBOARD, { days: 14, qty: null })).toEqual({
      ok: true,
      pricing: { basis: 'period_option', days: 14, qty: null, unitKrw: 2_800_000, totalKrw: 2_800_000, exact: true, vatIncluded: false },
    });
  });
  it('광고: 옵션에 없는 기간(10일)은 14일 옵션의 값 그대로이고 exact 가 거짓이다. 10일치로 나누지 않는다', () => {
    const got = priceProduct(BILLBOARD, { days: 10, qty: null });
    expect(got).toMatchObject({ ok: true, pricing: { days: 14, totalKrw: 2_800_000, exact: false } });
  });
  it('광고: 가장 긴 옵션보다 긴 기간이면 옵션에 없음', () => {
    expect(priceProduct(BILLBOARD, { days: 30, qty: null })).toEqual({ ok: false, reason: 'no_option' });
  });
  it('광고: 기간 조건이 없으면 가장 짧은 옵션. 수량 조건은 보지 않는다', () => {
    expect(priceProduct(BILLBOARD, { days: null, qty: 999 })).toMatchObject({ ok: true, pricing: { days: 7, totalKrw: 1_500_000, exact: true } });
  });
  it('케이터링: 수량 옵션에 같은 규칙', () => {
    expect(priceProduct(TRUCK, { days: null, qty: 200 })).toMatchObject({ ok: true, pricing: { basis: 'quantity_option', qty: 200, totalKrw: 1_500_000, exact: true, vatIncluded: true } });
    expect(priceProduct(TRUCK, { days: null, qty: 150 })).toMatchObject({ ok: true, pricing: { qty: 200, totalKrw: 1_500_000, exact: false } });
    expect(priceProduct(TRUCK, { days: null, qty: 301 })).toEqual({ ok: false, reason: 'no_option' });
    expect(priceProduct(TRUCK, { days: 3, qty: null })).toMatchObject({ ok: true, pricing: { qty: 100, totalKrw: 800_000 } });
  });
  it('굿즈: 판매가 × 수량. 수량 조건이 없으면 최소 주문 수량, 그것도 없으면 1', () => {
    expect(priceProduct(CARDS, { days: null, qty: 500 })).toMatchObject({ ok: true, pricing: { basis: 'unit_price', qty: 500, unitKrw: 900, totalKrw: 450_000, exact: true } });
    expect(priceProduct(CARDS, { days: null, qty: null })).toMatchObject({ ok: true, pricing: { qty: 100, totalKrw: 90_000 } });
    expect(priceProduct({ ...CARDS, spec: {} }, { days: null, qty: null })).toMatchObject({ ok: true, pricing: { qty: 1, totalKrw: 900 } });
  });
  it('굿즈: 최소 주문 수량보다 적으면 빠진다. 딱 그 수량이면 된다', () => {
    expect(priceProduct(CARDS, { days: null, qty: 99 })).toEqual({ ok: false, reason: 'below_min_qty' });
    expect(priceProduct(CARDS, { days: null, qty: 100 })).toMatchObject({ ok: true });
  });
  it('옵션이 비었거나 꼴이 틀린 상품은 값을 내지 못한다', () => {
    expect(priceProduct({ ...BILLBOARD, options: [] }, { days: null, qty: null })).toEqual({ ok: false, reason: 'no_option' });
    expect(priceProduct({ ...BILLBOARD, options: [{ days: 0, price_krw: 5 }, { qty: 3, price_krw: 5 }, 'x'] }, { days: null, qty: null })).toEqual({ ok: false, reason: 'no_option' });
  });
});

describe('지역', () => {
  it('"근처" 같은 말과 공백을 떼고 지명만 남긴다', () => {
    expect(regionCore('홍대 근처')).toBe('홍대');
    expect(regionCore('강남역 인근')).toBe('강남역');
    expect(regionCore(' 성수동 쪽 ')).toBe('성수동');
  });
  it('상품의 지역 글에 조건의 지명이 들어 있으면 맞다', () => {
    expect(regionMatches('합정역', '합정역 7번출구')).toBe(true);
    expect(regionMatches('합정', '합정역 7번출구')).toBe(true);
    expect(regionMatches('홍대 근처', '홍대입구역 9번 출구')).toBe(true);
    expect(regionMatches('서울', '서울, 경기 남부')).toBe(true);
  });
  it('조건의 지명에 상품 지역의 낱말이 들어 있어도 맞다', () => {
    expect(regionMatches('서울역', '서울, 경기 남부')).toBe(true);
    expect(regionMatches('강남역 11번 출구 앞', '강남역')).toBe(true);
    expect(regionMatches('강남', '강남역')).toBe(true);
  });
  it('글자가 겹치지 않으면 다르다. 지도를 모른다(합정이 서울인 줄 모른다)', () => {
    expect(regionMatches('홍대', '합정역 7번출구')).toBe(false);
    expect(regionMatches('서울', '합정역 7번출구')).toBe(false);
    expect(regionMatches('상암동', '서울, 경기 남부')).toBe(false);
  });
  it('숫자가 든 낱말과 한 글자 낱말로는 맞추지 않는다', () => {
    expect(regionMatches('7번출구', '강남역 7번출구')).toBe(true); // 1번 규칙(상품 글에 통째로 들어 있다)
    expect(regionMatches('신촌역 7번출구', '합정역 7번출구')).toBe(false);
    expect(regionMatches('부산 서구', '서 울')).toBe(false);
  });
  it('알려진 헛맞음: 조건 "경기장"은 "경기 남부"의 "경기"와 맞는다', () => {
    expect(regionMatches('경기장', '서울, 경기 남부')).toBe(true);
  });
});

describe('고르기', () => {
  it('조건이 하나도 없으면 값을 낼 수 있는 상품이 모두 맞고, 총액이 작은 것부터 온다', () => {
    const got = matchQuote(ANY, ALL, TODAY);
    expect(ids(got.candidates)).toEqual([4, 3, 1, 2]);
    expect(got.excluded).toEqual([]);
    for (const c of got.candidates) {
      expect(c.matched).toEqual([]);
      expect(c.schedule).toEqual({ startDate: null, deadlines: [] });
      expect(QuoteCandidateSchema.safeParse(c).success).toBe(true);
    }
  });
  it('총액이 같으면 번호가 작은 것부터', () => {
    const twin = { ...BILLBOARD, id: 9 };
    expect(ids(matchQuote(ANY, [twin, BILLBOARD], TODAY).candidates)).toEqual([1, 9]);
  });
  it('상품이 0개면 둘 다 빈 목록', () => {
    expect(matchQuote({ ...ANY, type: 'ad' }, [], TODAY)).toEqual({ candidates: [], excluded: [] });
  });
  it('종류와 갈래로 거른다. 빠진 까닭이 남는다', () => {
    const got = matchQuote({ ...ANY, type: 'ad', subtype: '전광판' }, ALL, TODAY);
    expect(ids(got.candidates)).toEqual([1]);
    expect(got.candidates[0]?.matched).toEqual(['type', 'subtype']);
    expect(reasonsOf(got, 2)).toEqual(['subtype_mismatch']);
    expect(reasonsOf(got, 3)).toEqual(['type_mismatch', 'subtype_mismatch']);
    for (const e of got.excluded) expect(QuoteExcludedSchema.safeParse(e).success).toBe(true);
  });
  it('예산 경계: 총액이 예산과 딱 같으면 예산 안이고, 1원 모자라면 빠진다', () => {
    const exact = matchQuote({ ...ANY, type: 'ad', subtype: '전광판', budgetKrw: 1_500_000 }, ALL, TODAY);
    expect(ids(exact.candidates)).toEqual([1]);
    expect(exact.candidates[0]?.matched).toContain('budget');
    const short = matchQuote({ ...ANY, type: 'ad', subtype: '전광판', budgetKrw: 1_499_999 }, ALL, TODAY);
    expect(short.candidates).toEqual([]);
    expect(reasonsOf(short, 1)).toEqual(['over_budget']);
  });
  it('부가세 별도 상품도 적힌 총액으로 예산과 견준다(세금을 더해 보지 않는다)', () => {
    // 세금 10%를 더하면 165만 원이지만, 더하지 않으므로 예산 150만 원 안이다. 표시는 vatIncluded 가 한다.
    const got = matchQuote({ ...ANY, budgetKrw: 1_500_000 }, [BILLBOARD], TODAY);
    expect(got.candidates[0]?.pricing).toMatchObject({ totalKrw: 1_500_000, vatIncluded: false });
  });
  it('바라는 기간으로 총액이 달라지고, 그 총액으로 예산을 본다', () => {
    const got = matchQuote({ ...ANY, type: 'ad', days: 14, budgetKrw: 2_000_000 }, ALL, TODAY);
    expect(reasonsOf(got, 1)).toEqual(['over_budget']);
    expect(reasonsOf(got, 2)).toEqual(['over_budget']); // 14일과 같은 옵션이 없어 30일 옵션의 값(320만 원)으로 본다
    const roomy = matchQuote({ ...ANY, type: 'ad', days: 14, budgetKrw: 3_200_000 }, ALL, TODAY);
    expect(roomy.candidates.map((c) => [c.productId, c.pricing.exact, c.matched.includes('option')])).toEqual([[1, true, true], [2, false, false]]);
  });
  it('"옵션이 있음"은 그 상품이 쓰는 조건으로만 붙는다: 케이터링은 수량, 광고는 기간', () => {
    // 케이터링에 기간 조건만 있으면 수량은 가장 작은 옵션일 뿐이다. 바라는 옵션이 있었다고 하지 않는다.
    expect(matchQuote({ ...ANY, days: 3 }, [TRUCK], TODAY).candidates[0]?.matched).toEqual([]);
    expect(matchQuote({ ...ANY, qty: 200 }, [TRUCK], TODAY).candidates[0]?.matched).toEqual(['option']);
    expect(matchQuote({ ...ANY, qty: 200 }, [BILLBOARD], TODAY).candidates[0]?.matched).toEqual([]);
    expect(matchQuote({ ...ANY, days: 7 }, [BILLBOARD], TODAY).candidates[0]?.matched).toEqual(['option']);
  });
  it('옵션에 없는 기간·수량이면 "옵션 없음"으로 빠지고 예산은 따지지 않는다', () => {
    const got = matchQuote({ ...ANY, days: 60, qty: 1000, budgetKrw: 1 }, [BILLBOARD, TRUCK], TODAY);
    expect(reasonsOf(got, 1)).toEqual(['no_option']);
    expect(reasonsOf(got, 3)).toEqual(['no_option']);
  });
  it('굿즈의 최소 주문 수량', () => {
    const got = matchQuote({ ...ANY, type: 'goods', qty: 50 }, ALL, TODAY);
    expect(reasonsOf(got, 4)).toEqual(['below_min_qty']);
  });
  it('지역 조건: 굿즈는 지역으로 거르지 않고, 지역이 안 적힌 지면은 빠진다', () => {
    const got = matchQuote({ ...ANY, region: '합정역 근처' }, [...ALL, { ...SUBWAY, id: 5, spec: {} }], TODAY);
    // 지역이 맞은 지면(150만 원)이 지역을 보지 않는 굿즈(9만 원)보다 앞에 온다.
    expect(ids(got.candidates)).toEqual([1, 4]);
    expect(got.candidates.find((c) => c.productId === 1)?.matched).toEqual(['region']);
    expect(got.candidates.find((c) => c.productId === 4)?.matched).toEqual([]);
    expect(reasonsOf(got, 2)).toEqual(['region_mismatch']);
    expect(reasonsOf(got, 3)).toEqual(['region_mismatch']);
    expect(reasonsOf(got, 5)).toEqual(['region_mismatch']);
  });
  it('맞는 상품의 지역 칸: 광고는 위치, 케이터링은 출장 지역, 굿즈는 null', () => {
    const got = matchQuote(ANY, ALL, TODAY);
    expect(Object.fromEntries(got.candidates.map((c) => [c.productId, c.region]))).toEqual({ 1: '합정역 7번출구', 2: '강남역', 3: '서울, 경기 남부', 4: null });
  });

  describe('마감', () => {
    // 전광판: 예약 7일 전, 소재 14일 전. 가장 이른 마감은 소재(기준일 − 14일)다.
    const starting = (dateFrom: string) => ({ ...ANY, subtype: '전광판', dateFrom, dateTo: dateFrom });
    it('오늘이 소재 마감 당일이면 아직 된다(남은 날 0, 곧 마감)', () => {
      const got = matchQuote(starting('2026-10-26'), [BILLBOARD], TODAY);
      expect(ids(got.candidates)).toEqual([1]);
      const { schedule, matched } = got.candidates[0]!;
      expect(matched).toContain('deadline');
      expect(schedule.startDate).toBe('2026-10-26');
      expect(schedule.deadlines).toEqual([
        { kind: 'material', field: 'material_deadline_days', days: 14, date: '2026-10-12', daysLeft: 0, status: 'closing' },
        { kind: 'booking', field: 'booking_deadline_days', days: 7, date: '2026-10-19', daysLeft: 7, status: 'open' },
      ]);
    });
    it('하루 지났으면 빠진다', () => {
      const got = matchQuote(starting('2026-10-25'), [BILLBOARD], TODAY);
      expect(got.candidates).toEqual([]);
      expect(reasonsOf(got, 1)).toEqual(['deadline_passed']);
    });
    it('마감 일수가 안 적힌 상품은 그 마감을 세지 않는다. 지어내지 않는다', () => {
      const got = matchQuote({ ...ANY, subtype: '지하철', dateFrom: '2026-10-13', dateTo: '2026-10-13' }, [SUBWAY], TODAY);
      expect(got.candidates[0]?.schedule).toEqual({ startDate: '2026-10-13', deadlines: [] });
      expect(got.candidates[0]?.matched).not.toContain('deadline');
    });
    it('기준일 자체가 오늘보다 앞이면 마감 일수가 없어도 빠진다. 오늘이 기준일이면 된다', () => {
      expect(reasonsOf(matchQuote({ ...ANY, dateFrom: '2026-10-11', dateTo: '2026-10-11' }, [SUBWAY], TODAY), 2)).toEqual(['deadline_passed']);
      expect(ids(matchQuote({ ...ANY, dateFrom: TODAY, dateTo: TODAY }, [SUBWAY], TODAY).candidates)).toEqual([2]);
    });
    it('범위 문의의 기준일은 첫날이다. 끝날이 아니다', () => {
      // 5월 첫 주(1일~7일): 소재 마감은 5월 1일 − 14일 = 4월 17일. 끝날로 세면 4월 23일이 된다.
      const got = matchQuote({ ...ANY, subtype: '전광판', dateFrom: '2027-05-01', dateTo: '2027-05-07' }, [BILLBOARD], TODAY);
      expect(got.candidates[0]?.schedule.startDate).toBe('2027-05-01');
      expect(got.candidates[0]?.schedule.deadlines.map((d) => [d.kind, d.date])).toEqual([['material', '2027-04-17'], ['booking', '2027-04-24']]);
      // 첫날 기준으로는 마감이 지났고 끝날 기준으로는 아직인 범위는 빠진다.
      const late = matchQuote({ ...ANY, subtype: '전광판', dateFrom: '2026-10-25', dateTo: '2026-10-31' }, [BILLBOARD], TODAY);
      expect(reasonsOf(late, 1)).toEqual(['deadline_passed']);
    });
    it('범위가 오늘을 품은 문의("10월", "10월 둘째 주")는 첫날이 오늘로 당겨져 와서, 마감이 남은 상품은 맞는 쪽에 남는다', () => {
      const month = (date: object) => resolveConditions({ lang: 'ko', budget_raw: null, budget_krw: null, region: null, date_raw: null, type: null, subtype: null, qty: null, days: null,
        date: { year: null, month: 10, day_from: null, day_to: null, week_of_month: null, ...date } }, TODAY);
      for (const conditions of [month({}), month({ week_of_month: 2 })]) {
        expect(conditions.dateFrom).toBe(TODAY);
        const got = matchQuote(conditions, ALL, TODAY);
        // 마감 일수가 없는 지하철 광고는 남는다. 14일·5일·10일 전 마감이 있는 셋은 오늘 시작으로는 늦었다.
        expect(ids(got.candidates)).toEqual([2]);
        expect(got.excluded.map((e) => e.productId)).toEqual([1, 3, 4]);
      }
    });
    it('1900년 날짜가 적힌 문의에도 오류 없이 "마감이 지남"으로 빠진다(마감일이 다룰 수 있는 날짜 앞으로 나가도)', () => {
      const got = matchQuote({ ...ANY, dateFrom: '1900-01-01', dateTo: '1900-01-01' }, ALL, TODAY);
      expect(got.candidates).toEqual([]);
      for (const e of got.excluded) expect(e.reasons).toEqual(['deadline_passed']);
    });
    it('케이터링은 시안 마감, 굿즈는 제작 기간만큼 앞선 주문 마감을 센다', () => {
      const got = matchQuote({ ...ANY, dateFrom: '2026-12-24', dateTo: '2026-12-24' }, [TRUCK, CARDS], TODAY);
      expect(got.candidates.find((c) => c.productId === 3)?.schedule.deadlines).toMatchObject([{ kind: 'design', date: '2026-12-19' }]);
      expect(got.candidates.find((c) => c.productId === 4)?.schedule.deadlines).toMatchObject([{ kind: 'order', date: '2026-12-14' }]);
    });
    it('달과 해가 바뀌는 마감: 1월 5일 시작, 소재 14일 전 = 지난해 12월 22일', () => {
      const got = matchQuote(starting('2027-01-05'), [BILLBOARD], TODAY);
      expect(got.candidates[0]?.schedule.deadlines[0]).toMatchObject({ kind: 'material', date: '2026-12-22' });
    });
  });

  it('여러 까닭으로 빠지면 약속한 순서로 모두 남는다', () => {
    const got = matchQuote({ ...ANY, type: 'catering', subtype: '도시락', region: '부산', qty: 500, budgetKrw: 1, dateFrom: '2026-10-13', dateTo: '2026-10-13' }, [BILLBOARD, TRUCK], TODAY);
    expect(reasonsOf(got, 1)).toEqual(['type_mismatch', 'subtype_mismatch', 'region_mismatch', 'over_budget', 'deadline_passed']);
    expect(reasonsOf(got, 3)).toEqual(['subtype_mismatch', 'region_mismatch', 'no_option', 'deadline_passed']);
  });
  it('문의 한 줄 "예산 300만 원, 홍대 근처, 5월 첫 주 생일 광고"에 맞는 지면이 없으면 0개이고 까닭이 남는다', () => {
    const got = matchQuote({ ...ANY, type: 'ad', budgetKrw: 3_000_000, region: '홍대 근처', dateFrom: '2027-05-01', dateTo: '2027-05-07' }, ALL, TODAY);
    expect(got.candidates).toEqual([]);
    expect(reasonsOf(got, 1)).toEqual(['region_mismatch']);
    expect(reasonsOf(got, 2)).toEqual(['region_mismatch', 'over_budget']);
  });
});

describe('무엇을 찾는지 알 수 있는 조건', () => {
  it('종류·갈래·지역 가운데 하나라도 있으면 있다. 예산·날짜·수량·기간만으로는 없다', () => {
    expect(hasSearchCondition(ANY)).toBe(false);
    expect(hasSearchCondition({ ...ANY, budgetKrw: 1_000_000, dateFrom: TODAY, dateTo: TODAY, qty: 3, days: 7 })).toBe(false);
    expect(hasSearchCondition({ ...ANY, type: 'goods' })).toBe(true);
    expect(hasSearchCondition({ ...ANY, subtype: '커피차' })).toBe(true);
    expect(hasSearchCondition({ ...ANY, region: '홍대' })).toBe(true);
  });
});
