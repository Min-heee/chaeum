// 묶음을 다루는 판단: 거르기, 차례, 경고, 나란히 놓기.
import { describe, expect, it } from 'vitest';
import { CompareQuerySchema, CompareResponseSchema, type CompareProduct } from '@/contract/tools/compare';
import { ad, catering, goods } from './fixtures';
import { buildCompare, defaultOrder, filterProducts, groupWarnings, rankRows, sideBySide, vatMixed } from './group';
import { compareRow } from './metrics';

const rowsOf = (products: readonly CompareProduct[]) => products.map(compareRow);
const withDays = (id: number, days: number, price: number, over: Partial<CompareProduct> = {}) => ad({ id, options: [{ days, price_krw: price }], ...over });

describe('거르기', () => {
  const hapjeong = ad({ subtype: '전광판', spec: { region: '합정역 7번출구' } });
  const gangnam = ad({ subtype: '지하철', spec: { region: '강남역' } });
  const coffee = catering({ spec: { service_region: '서울이랑 경기 남부' } });
  const slogan = goods();
  const all = [hapjeong, gangnam, coffee, slogan];

  it('안 준 조건으로는 거르지 않는다', () => {
    expect(filterProducts(all, {})).toEqual(all);
  });
  it('종류와 갈래', () => {
    expect(filterProducts(all, { type: 'ad' })).toEqual([hapjeong, gangnam]);
    expect(filterProducts(all, { type: 'ad', subtype: '지하철' })).toEqual([gangnam]);
    expect(filterProducts(all, { subtype: '커피차' })).toEqual([coffee]);
  });
  it('지역은 위치 글에 그 글자가 들어 있는지만 본다(빈칸 무시). 굿즈는 지역이 없어 빠진다', () => {
    expect(filterProducts(all, { region: '합정' })).toEqual([hapjeong]);
    expect(filterProducts(all, { region: '합정역7번' })).toEqual([hapjeong]);
    expect(filterProducts(all, { region: '서울' })).toEqual([coffee]);
    expect(filterProducts(all, { region: '부산' })).toEqual([]);
  });
});

describe('차례 매기기', () => {
  it('작을수록 좋은 잣대는 작은 것부터, 클수록 좋은 잣대는 큰 것부터가 기본이다', () => {
    expect(defaultOrder('per_day_krw')).toBe('asc');
    expect(defaultOrder('footfall_per_day')).toBe('desc');
    expect(defaultOrder('area_m2')).toBe('asc');
  });

  it('값이 없는 것은 맨 뒤이고 차례가 없다. 내림차순이어도 맨 뒤다', () => {
    const rows = rowsOf([
      ad({ id: 1, options: [] }),
      withDays(2, 10, 3_000_000), // 하루 300,000
      withDays(3, 10, 1_000_000), // 하루 100,000
      ad({ id: 4, options: [] }),
    ]);
    const asc = rankRows(rows, 'per_day_krw', 'asc');
    expect(asc.rows.map((r) => [r.productId, r.rank])).toEqual([[3, 1], [2, 2], [1, null], [4, null]]);
    const desc = rankRows(rows, 'per_day_krw', 'desc');
    expect(desc.rows.map((r) => [r.productId, r.rank])).toEqual([[2, 1], [3, 2], [1, null], [4, null]]);
    expect(asc.split).toBe(false);
  });

  it('같은 값은 번호가 작은 것이 앞이다(오름·내림 모두)', () => {
    const rows = rowsOf([withDays(9, 10, 1_000_000), withDays(3, 20, 2_000_000), withDays(5, 5, 500_000), withDays(1, 10, 2_000_000)]);
    // 9·3·5 는 모두 하루 100,000, 1 은 200,000
    expect(rankRows(rows, 'per_day_krw', 'asc').rows.map((r) => r.productId)).toEqual([3, 5, 9, 1]);
    expect(rankRows(rows, 'per_day_krw', 'desc').rows.map((r) => r.productId)).toEqual([1, 3, 5, 9]);
  });

  it('부가세가 섞인 묶음을 돈 잣대로 차례 매기면 같은 것끼리만 매긴다. 부가세를 더하거나 빼지 않는다', () => {
    const rows = rowsOf([
      withDays(1, 10, 1_100_000, { vat_included: true }), // 하루 110,000 (포함)
      withDays(2, 10, 1_050_000, { vat_included: false }), // 하루 105,000 (별도)
      withDays(3, 10, 1_000_000, { vat_included: true }), // 하루 100,000 (포함)
      withDays(4, 10, 900_000, { vat_included: null }), // 하루 90,000 (모름)
      withDays(5, 10, 2_000_000, { vat_included: false }), // 하루 200,000 (별도)
    ]);
    const got = rankRows(rows, 'per_day_krw', 'asc');
    expect(got.split).toBe(true);
    // 별도끼리 → 포함끼리 → 모름끼리. 가장 싼 4번(모름)이 맨 앞에 오지 않는다.
    expect(got.rows.map((r) => [r.productId, r.rank, r.rankGroup])).toEqual([
      [2, 1, 'vat_excluded'],
      [5, 2, 'vat_excluded'],
      [3, 1, 'vat_included'],
      [1, 2, 'vat_included'],
      [4, 1, 'vat_unknown'],
    ]);
    // 값은 적힌 그대로다.
    expect(got.rows.map((r) => r.values.per_day_krw.value)).toEqual([105_000, 200_000, 100_000, 110_000, 90_000]);
  });

  it('부가세가 섞였어도 돈이 아닌 잣대는 한 줄로 차례를 매긴다', () => {
    const rows = rowsOf([
      ad({ id: 1, vat_included: true, spec: { footfall_per_day: 30_000 } }),
      ad({ id: 2, vat_included: false, spec: { footfall_per_day: 140_000 } }),
    ]);
    const got = rankRows(rows, 'footfall_per_day');
    expect(got.split).toBe(false);
    expect(got.rows.map((r) => [r.productId, r.rank, r.rankGroup])).toEqual([[2, 1, null], [1, 2, null]]);
  });

  it('부가세를 모르는 것과 한쪽(포함만 또는 별도만)이 섞여도 섞인 것이다', () => {
    const unknownAndIncluded = rowsOf([withDays(1, 10, 2_000_000, { vat_included: null }), withDays(2, 10, 1_000_000, { vat_included: true })]);
    expect(vatMixed(unknownAndIncluded)).toBe(true);
    const got = rankRows(unknownAndIncluded, 'per_day_krw');
    expect(got.split).toBe(true);
    expect(got.rows.map((r) => [r.productId, r.rank, r.rankGroup])).toEqual([[2, 1, 'vat_included'], [1, 1, 'vat_unknown']]);
    expect(vatMixed(rowsOf([withDays(1, 10, 2_000_000, { vat_included: null }), withDays(2, 10, 1_000_000, { vat_included: false })]))).toBe(true);
  });

  it('부가세 섞임은 그 잣대의 값이 있는 줄만 보고 판정한다', () => {
    // 값이 있는 둘은 모두 별도다. 값이 없는 3번(포함)과 굿즈(포함) 때문에 묶지 않는다.
    const rows = rowsOf([withDays(1, 10, 2_000_000), withDays(2, 10, 1_000_000), ad({ id: 3, vat_included: true, options: [] }), goods({ id: 4, vat_included: true })]);
    const got = rankRows(rows, 'per_day_krw');
    expect(got.split).toBe(false);
    expect(got.rows.map((r) => [r.productId, r.rank, r.rankGroup])).toEqual([[2, 1, null], [1, 2, null], [3, null, null], [4, null, null]]);
    // 값이 하나도 없으면 묶을 것도 없다.
    const none = rankRows(rowsOf([goods({ id: 1, vat_included: true }), goods({ id: 2, vat_included: false })]), 'per_day_krw');
    expect(none.split).toBe(false);
    expect(none.rows.map((r) => r.rank)).toEqual([null, null]);
  });

  it('같은 값은 같은 차례이고 다음 차례는 그만큼 건너뛴다', () => {
    const rows = rowsOf([withDays(9, 10, 1_000_000), withDays(3, 20, 2_000_000), withDays(5, 5, 500_000), withDays(1, 10, 2_000_000), withDays(7, 10, 3_000_000)]);
    expect(rankRows(rows, 'per_day_krw', 'asc').rows.map((r) => [r.productId, r.rank])).toEqual([[3, 1], [5, 1], [9, 1], [1, 4], [7, 5]]);
    expect(rankRows(rows, 'per_day_krw', 'desc').rows.map((r) => [r.productId, r.rank])).toEqual([[7, 1], [1, 2], [3, 3], [5, 3], [9, 3]]);
  });

  it('종류가 섞인 묶음의 판매가는 종류끼리만 차례를 매긴다(기간 옵션 값·수량 옵션 값·낱개 값을 한 줄로 세우지 않는다)', () => {
    const rows = rowsOf([
      withDays(5, 2, 5, { price_krw: 5 }),
      goods({ id: 18, price_krw: 4_500, vat_included: false }),
      catering({ id: 14, price_krw: 100_000, vat_included: false, options: [{ qty: 30, price_krw: 100_000 }] }),
      withDays(1, 7, 1_500_000),
      withDays(11, 7, 1_500_000),
      goods({ id: 19, price_krw: 2_300, vat_included: false }),
    ]);
    const got = rankRows(rows, 'price_krw');
    expect(got.byType).toBe(true);
    expect(got.split).toBe(false);
    expect(got.rows.map((r) => [r.productId, r.rank, r.rankType])).toEqual([
      [5, 1, 'ad'],
      [1, 2, 'ad'],
      [11, 2, 'ad'],
      [14, 1, 'catering'],
      [19, 1, 'goods'],
      [18, 2, 'goods'],
    ]);
    // 종류가 하나면 묶지 않는다. 종류마다 뜻이 같은 잣대(운영 시간)도 묶지 않는다.
    expect(rankRows(rowsOf([goods({ id: 1 }), goods({ id: 2 })]), 'price_krw')).toMatchObject({ byType: false });
    const hours = rowsOf([
      ad({ id: 1, spec: { hours: { open: '05:00', close: '01:00', nextDay: true } } }),
      catering({ id: 2, spec: { service_hours: { open: '09:00', close: '15:00', nextDay: false } } }),
    ]);
    expect(rankRows(hours, 'open_minutes')).toMatchObject({ byType: false });
  });

  it('종류도 부가세도 섞였으면 종류 안에서 부가세가 같은 것끼리 차례를 매긴다', () => {
    const rows = rowsOf([
      withDays(1, 7, 300, { price_krw: 300, vat_included: true }),
      withDays(2, 7, 200, { price_krw: 200, vat_included: false }),
      goods({ id: 3, price_krw: 100, vat_included: true }),
      goods({ id: 4, price_krw: 50, vat_included: true }),
    ]);
    const got = rankRows(rows, 'price_krw');
    expect(got).toMatchObject({ split: true, byType: true });
    expect(got.rows.map((r) => [r.productId, r.rank, r.rankType, r.rankGroup])).toEqual([
      [2, 1, 'ad', 'vat_excluded'],
      [1, 1, 'ad', 'vat_included'],
      [4, 1, 'goods', 'vat_included'],
      [3, 2, 'goods', 'vat_included'],
    ]);
  });

  it('부가세가 모두 같으면 돈 잣대도 한 줄이다', () => {
    const rows = rowsOf([withDays(1, 10, 2_000_000), withDays(2, 10, 1_000_000)]);
    expect(vatMixed(rows)).toBe(false);
    expect(rankRows(rows, 'per_day_krw').rows.map((r) => [r.productId, r.rank, r.rankGroup])).toEqual([[2, 1, null], [1, 2, null]]);
  });
});

describe('묶음의 경고', () => {
  it('부가세 포함과 별도가 섞이면 수를 세어 알리고, 합쳐 견주지 않는 돈 잣대를 함께 낸다', () => {
    const rows = rowsOf([ad({ vat_included: true }), ad({ vat_included: false }), ad({ vat_included: false }), ad({ vat_included: null })]);
    expect(groupWarnings(rows)).toEqual([{ code: 'vat_mixed', included: 1, excluded: 2, unknown: 1, metrics: ['per_day_krw', 'per_1000_footfall_krw', 'price_krw'] }]);
  });
  it('모두 같으면 경고가 없다. 모두 모름이어도 섞인 것은 아니다', () => {
    expect(groupWarnings(rowsOf([ad(), ad()]))).toEqual([]);
    expect(groupWarnings(rowsOf([ad({ vat_included: null }), ad({ vat_included: null })]))).toEqual([]);
    expect(groupWarnings([])).toEqual([]);
  });
  it('종류가 섞이면 한쪽에만 있어 견줄 수 없는 잣대를 낸다', () => {
    const rows = rowsOf([ad({ vat_included: true }), goods({ vat_included: true })]);
    const [warning] = groupWarnings(rows);
    expect(warning).toMatchObject({ code: 'mixed_types', types: ['ad', 'goods'] });
    const metrics = warning?.code === 'mixed_types' ? warning.metrics : [];
    expect(metrics).toContain('per_day_krw');
    expect(metrics).toContain('min_order_qty');
    // 판매가는 두 종류 모두에 있다.
    expect(metrics).not.toContain('price_krw');
  });
});

describe('나란히 놓기', () => {
  it('칸마다 서로 다른지 본다. 값과 없음이 섞여도 다르고, 모두 없음이면 같다', () => {
    const a = ad({ id: 1, spec: { footfall_per_day: 140_000, booking_deadline_days: 14, size_m: { width: 2, height: 1.5 } } });
    const b = ad({ id: 2, spec: { booking_deadline_days: 14, size_m: { width: 3, height: 1 } } });
    const side = sideBySide(rowsOf([a, b]));
    const of = (metric: string) => side.metrics.find((m) => m.metric === metric);
    expect(of('footfall_per_day')?.differs).toBe(true); // 값과 없음
    expect(of('booking_deadline_days')?.differs).toBe(false); // 같은 값
    expect(of('refund_full_days')?.differs).toBe(false); // 둘 다 없음
    expect(of('area_m2')?.differs).toBe(false); // 2 × 1.5 = 3 × 1
    expect(side.facts).toEqual([
      { fact: 'type', differs: false },
      { fact: 'subtype', differs: false },
      { fact: 'region', differs: false },
      { fact: 'vat', differs: false },
    ]);
  });

  it('가장 좋은 쪽은 방향이 분명한 잣대에만 붙는다', () => {
    const a = withDays(1, 10, 1_000_000, { spec: { footfall_per_day: 50_000, size_m: { width: 2, height: 2 }, spot_seconds: 15, booking_deadline_days: 14 } });
    const b = withDays(2, 10, 2_000_000, { spec: { footfall_per_day: 80_000, size_m: { width: 4, height: 2 }, spot_seconds: 20, booking_deadline_days: 7 } });
    const side = sideBySide(rowsOf([a, b]));
    const of = (metric: string) => side.metrics.find((m) => m.metric === metric);
    expect(of('per_day_krw')).toMatchObject({ best: [1], bestWithheld: null }); // 작을수록 좋다
    expect(of('footfall_per_day')).toMatchObject({ best: [2], bestWithheld: null }); // 클수록 좋다
    expect(of('booking_deadline_days')).toMatchObject({ best: [2], bestWithheld: null });
    expect(of('area_m2')).toMatchObject({ differs: true, best: [], bestWithheld: 'no_direction' });
    expect(of('spot_seconds')).toMatchObject({ differs: true, best: [], bestWithheld: 'no_direction' });
    // 광고의 판매가는 기간이 다른 옵션의 값일 수 있어 좋은 쪽을 말하지 않는다.
    expect(of('price_krw')).toMatchObject({ best: [], bestWithheld: 'no_direction' });
  });

  it('부가세가 섞였으면 돈 잣대에는 좋은 쪽을 표시하지 않는다. 돈이 아닌 잣대에는 표시한다', () => {
    const a = withDays(1, 10, 1_000_000, { vat_included: true, spec: { footfall_per_day: 50_000 } });
    const b = withDays(2, 10, 2_000_000, { vat_included: false, spec: { footfall_per_day: 80_000 } });
    const side = sideBySide(rowsOf([a, b]));
    const of = (metric: string) => side.metrics.find((m) => m.metric === metric);
    expect(of('per_day_krw')).toMatchObject({ differs: true, best: [], bestWithheld: 'vat_mixed' });
    expect(of('per_1000_footfall_krw')).toMatchObject({ best: [], bestWithheld: 'vat_mixed' });
    expect(of('footfall_per_day')).toMatchObject({ best: [2], bestWithheld: null });
    expect(side.warnings.map((w) => w.code)).toEqual(['vat_mixed']);
    expect(side.facts.find((f) => f.fact === 'vat')?.differs).toBe(true);
  });

  it('부가세를 모르는 것끼리도 돈 잣대의 좋은 쪽을 말하지 않는다', () => {
    const side = sideBySide(rowsOf([withDays(1, 10, 1_000_000, { vat_included: null }), withDays(2, 10, 2_000_000, { vat_included: null })]));
    expect(side.metrics.find((m) => m.metric === 'per_day_krw')).toMatchObject({ best: [], bestWithheld: 'vat_mixed' });
  });

  it('값이 같으면 좋은 쪽이 없고, 좋은 쪽이 여럿이면 모두 낸다', () => {
    const same = sideBySide(rowsOf([withDays(1, 10, 1_000_000), withDays(2, 20, 2_000_000)]));
    expect(same.metrics.find((m) => m.metric === 'per_day_krw')).toMatchObject({ differs: false, best: [], bestWithheld: 'all_same' });
    const tie = sideBySide(rowsOf([withDays(1, 10, 1_000_000), withDays(2, 10, 1_000_000), withDays(3, 10, 3_000_000)]));
    expect(tie.metrics.find((m) => m.metric === 'per_day_krw')).toMatchObject({ differs: true, best: [1, 2], bestWithheld: null });
  });

  it('값이 있는 것이 하나뿐이면 좋은 쪽을 말하지 않는다', () => {
    const side = sideBySide(rowsOf([ad({ id: 1, spec: { footfall_per_day: 100 } }), ad({ id: 2 })]));
    expect(side.metrics.find((m) => m.metric === 'footfall_per_day')).toMatchObject({ differs: true, best: [], bestWithheld: 'too_few' });
  });

  it('종류가 섞이면 한쪽에만 있는 칸은 "해당 없음"이고, 양쪽에 있는 칸에도 좋은 쪽을 붙이지 않는다', () => {
    const a = ad({ id: 1, vat_included: true, spec: { hours: { open: '05:00', close: '01:00', nextDay: true } } });
    const c = catering({ id: 2, vat_included: true, spec: { service_hours: { open: '09:00', close: '15:00', nextDay: false } } });
    const g = goods({ id: 3, vat_included: true, spec: { min_order_qty: 30 } });
    const side = sideBySide(rowsOf([a, c, g]));
    expect(side.warnings.map((w) => w.code)).toEqual(['mixed_types']);
    expect(side.metrics.find((m) => m.metric === 'open_minutes')).toMatchObject({ differs: true, best: [], bestWithheld: 'mixed_types' });
    expect(side.metrics.find((m) => m.metric === 'min_order_qty')).toMatchObject({ differs: true, best: [], bestWithheld: 'too_few' });
    expect(side.rows[2]?.values.per_day_krw.missing?.reason).toBe('not_applicable');
    expect(side.facts.find((f) => f.fact === 'type')?.differs).toBe(true);
  });

  it('굿즈끼리는 판매가의 좋은 쪽을 말한다(부가세가 같을 때)', () => {
    const side = sideBySide(rowsOf([goods({ id: 1, price_krw: 4_500 }), goods({ id: 2, price_krw: 2_300 })]));
    expect(side.metrics.find((m) => m.metric === 'price_krw')).toMatchObject({ best: [2], bestWithheld: null });
    // 굿즈에는 광고의 잣대가 없다.
    expect(side.metrics.map((m) => m.metric)).toEqual(['price_krw', 'min_order_qty', 'lead_time_days']);
  });

  it('케이터링끼리는 수량이 같은 옵션의 한 개당 값만 견준다', () => {
    const a = catering({ id: 1, options: [{ qty: 100, price_krw: 800_000 }, { qty: 300, price_krw: 2_100_000 }] }); // 8,000 / 7,000
    const b = catering({ id: 2, price_krw: 900_000, options: [{ qty: 100, price_krw: 900_000 }] }); // 9,000 / 9,000
    const side = sideBySide(rowsOf([a, b]));
    // 가장 적은 수량은 둘 다 100개 옵션이다.
    expect(side.metrics.find((m) => m.metric === 'unit_krw_min_qty')).toMatchObject({ best: [1], bestWithheld: null });
    // 가장 많은 수량은 300개 옵션과 100개 옵션이라 견주지 않는다.
    expect(side.metrics.find((m) => m.metric === 'unit_krw_max_qty')).toMatchObject({ differs: true, best: [], bestWithheld: 'mixed_basis' });
  });

  it('하루당 값·1,000명당 값은 나눈 옵션의 기간이 같을 때만 좋은 쪽을 붙인다', () => {
    // 7일 1,500,000 → 214,286 / 30일 3,200,000 → 106,667. 30일 옵션이 싸 보이지만 같은 기간의 값이 아니다.
    const week = ad({ id: 1, options: [{ days: 7, price_krw: 1_500_000 }, { days: 14, price_krw: 2_800_000 }], spec: { footfall_per_day: 100_000 } });
    const month = ad({ id: 2, price_krw: 3_200_000, options: [{ days: 30, price_krw: 3_200_000 }], spec: { footfall_per_day: 140_000 } });
    const side = sideBySide(rowsOf([week, month]));
    const of = (metric: string) => side.metrics.find((m) => m.metric === metric);
    expect(of('per_day_krw')).toMatchObject({ differs: true, best: [], bestWithheld: 'mixed_basis' });
    expect(of('per_1000_footfall_krw')).toMatchObject({ differs: true, best: [], bestWithheld: 'mixed_basis' });
    // 옵션에서 나누지 않은 잣대에는 그대로 붙는다.
    expect(of('footfall_per_day')).toMatchObject({ best: [2], bestWithheld: null });
    // 넷 가운데 하나만 기간이 달라도 붙이지 않는다.
    const four = sideBySide(rowsOf([withDays(1, 7, 700_000), withDays(2, 7, 1_400_000), withDays(3, 7, 2_100_000), withDays(4, 2, 100)]));
    expect(four.metrics.find((m) => m.metric === 'per_day_krw')).toMatchObject({ best: [], bestWithheld: 'mixed_basis' });
    // 기간이 모두 같으면 붙는다.
    const same = sideBySide(rowsOf([withDays(1, 7, 700_000), withDays(2, 7, 1_400_000)]));
    expect(same.metrics.find((m) => m.metric === 'per_day_krw')).toMatchObject({ best: [1], bestWithheld: null });
  });

  it('받은 차례 그대로 놓는다(번호순으로 바꾸지 않는다)', () => {
    const side = sideBySide(rowsOf([withDays(3, 7, 700_000), withDays(1, 7, 1_400_000)]));
    expect(side.productIds).toEqual([3, 1]);
    expect(side.rows.map((r) => r.productId)).toEqual([3, 1]);
  });
});

describe('한 번에: 주소 값 → 응답', () => {
  const products = [
    withDays(5, 7, 1_500_000, { subtype: '전광판', vat_included: false, spec: { region: '합정역 7번출구' } }),
    withDays(7, 30, 3_200_000, { subtype: '지하철', vat_included: false, spec: { region: '강남역', footfall_per_day: 140_000 } }),
    withDays(10, 30, 1_100_000, { subtype: '버스', vat_included: true, spec: { region: '마포구', footfall_per_day: 30_000 } }),
    goods({ id: 8 }),
  ];
  const parse = (raw: Record<string, string>) => CompareQuerySchema.parse(raw);

  it('아무것도 안 주면 전부를 번호순으로 놓고 차례를 매기지 않는다', () => {
    const got = buildCompare([...products].reverse(), parse({}));
    if (!got.ok) throw new Error('응답이 있어야 한다');
    expect(CompareResponseSchema.safeParse(got.response).success).toBe(true);
    expect(got.response.total).toBe(4);
    expect(got.response.rows.map((r) => r.productId)).toEqual([5, 7, 8, 10]);
    expect(got.response.rows.every((r) => r.rank === null)).toBe(true);
    expect(got.response.sort).toBeNull();
    expect(got.response.side).toBeNull();
    expect(got.response.warnings.map((w) => w.code)).toEqual(['vat_mixed', 'mixed_types']);
  });

  it('거르고 차례를 매긴다. 부가세가 섞였으면 그렇다고 알린다', () => {
    const got = buildCompare(products, parse({ type: 'ad', sort: 'per_day_krw' }));
    if (!got.ok) throw new Error('응답이 있어야 한다');
    expect(got.response.filter).toEqual({ type: 'ad', subtype: null, region: null });
    expect(got.response.sort).toEqual({ metric: 'per_day_krw', order: 'asc', split: true, byType: false });
    // 별도끼리: 7번 106,667 → 5번 214,286. 포함끼리: 10번 36,667. 가장 싼 10번이 맨 앞이 아니다.
    expect(got.response.rows.map((r) => [r.productId, r.values.per_day_krw.value, r.rank, r.rankGroup])).toEqual([
      [7, 106_667, 1, 'vat_excluded'],
      [5, 214_286, 2, 'vat_excluded'],
      [10, 36_667, 1, 'vat_included'],
    ]);
    expect(got.response.total).toBe(4);
  });

  it('값이 없는 것은 맨 뒤다', () => {
    const got = buildCompare(products, parse({ type: 'ad', sort: 'footfall_per_day' }));
    if (!got.ok) throw new Error('응답이 있어야 한다');
    expect(got.response.sort).toEqual({ metric: 'footfall_per_day', order: 'desc', split: false, byType: false });
    expect(got.response.rows.map((r) => [r.productId, r.rank])).toEqual([[7, 1], [10, 2], [5, null]]);
  });

  it('종류를 고르지 않고 판매가로 차례를 매기면 종류끼리 묶었다고 알리고, 응답은 약속의 꼴을 통과한다', () => {
    const got = buildCompare(products, parse({ sort: 'price_krw' }));
    if (!got.ok) throw new Error('응답이 있어야 한다');
    expect(got.response.sort).toMatchObject({ metric: 'price_krw', byType: true });
    expect(new Set(got.response.rows.map((r) => r.rankType)).size).toBeGreaterThan(1);
    expect(got.response.rows.every((r) => r.rankType === r.type)).toBe(true);
    expect(CompareResponseSchema.safeParse(got.response).success).toBe(true);
    // 값이 하나도 없는 잣대로 매기면 묶지 않는다(부가세가 섞였어도).
    const none = buildCompare(products, parse({ type: 'goods', sort: 'per_day_krw' }));
    if (!none.ok) throw new Error('응답이 있어야 한다');
    expect(none.response.sort).toEqual({ metric: 'per_day_krw', order: 'asc', split: false, byType: false });
  });

  it('고른 번호를 받은 차례 그대로 나란히 놓는다. 거르기와 따로다', () => {
    const got = buildCompare(products, parse({ type: 'goods', ids: '10,5' }));
    if (!got.ok) throw new Error('응답이 있어야 한다');
    expect(got.response.rows.map((r) => r.productId)).toEqual([8]);
    expect(got.response.side?.productIds).toEqual([10, 5]);
    expect(got.response.side?.warnings.map((w) => w.code)).toEqual(['vat_mixed']);
  });

  it('목록에 없는 번호가 있으면 응답을 만들지 않고 그 번호를 돌려준다', () => {
    expect(buildCompare(products, parse({ ids: '5,999,7,1000' }))).toEqual({ ok: false, missingIds: [999, 1000] });
  });
});

describe('주소 값의 꼴', () => {
  const ok = (raw: Record<string, string>) => CompareQuerySchema.safeParse(raw).success;
  it('받는 것', () => {
    expect(ok({})).toBe(true);
    expect(ok({ type: 'ad', subtype: '전광판', region: '합정', sort: 'per_day_krw', order: 'desc', ids: '1,2,3,4' })).toBe(true);
    expect(ok({ subtype: '커피차' })).toBe(true);
    expect(CompareQuerySchema.parse({ ids: '12,3' }).ids).toEqual([12, 3]);
  });
  it('받지 않는 것', () => {
    expect(ok({ type: 'food' })).toBe(false);
    expect(ok({ subtype: '비행선' })).toBe(false);
    expect(ok({ type: 'ad', subtype: '커피차' })).toBe(false); // 종류와 갈래가 안 맞는다
    expect(ok({ sort: 'vat_included' })).toBe(false);
    expect(ok({ order: 'asc' })).toBe(false); // sort 없는 order
    expect(ok({ sort: 'per_day_krw', order: 'up' })).toBe(false);
    expect(ok({ ids: '5' })).toBe(false); // 하나
    expect(ok({ ids: '1,2,3,4,5' })).toBe(false); // 다섯
    expect(ok({ ids: '5,5' })).toBe(false); // 같은 번호
    expect(ok({ ids: '5,x' })).toBe(false);
    expect(ok({ ids: '0,1' })).toBe(false);
    expect(ok({ region: 'ㄱ'.repeat(61) })).toBe(false);
    expect(ok({ region: '   ' })).toBe(false);
  });
});
