// 상품 하나의 견줄 값. 기대값은 모두 손으로 센 것이다(식을 주석에 적는다).
import { describe, expect, it } from 'vitest';
import { COMPARE_METRIC_DEFS, COMPARE_METRICS, CompareRowSchema, metricsOfType } from '@/contract/tools/compare';
import { ad, catering, goods } from './fixtures';
import { compareRow, exposureSeconds, openMinutes, optionValues, perDay, perThousandFootfall, perUnit, roundDiv, screenArea, skippedOptions } from './metrics';

describe('원 단위 반올림', () => {
  it('나누어떨어지면 그대로이고 반올림 표시가 없다', () => {
    expect(roundDiv(2_800_000, 14)).toEqual({ value: 200_000, rounded: false });
  });
  it('나누어떨어지지 않으면 반올림하고 그렇다고 알린다', () => {
    // 1,500,000 ÷ 7 = 214,285.71… → 214,286
    expect(roundDiv(1_500_000, 7)).toEqual({ value: 214_286, rounded: true });
    // 1,000,000 ÷ 3 = 333,333.33… → 333,333
    expect(roundDiv(1_000_000, 3)).toEqual({ value: 333_333, rounded: true });
  });
  it('꼭 반이면 올린다', () => {
    expect(roundDiv(5, 2)).toEqual({ value: 3, rounded: true });
  });
  it('0 이하로 나누거나 정수가 아니면 계산하지 않는다', () => {
    expect(roundDiv(100, 0)).toBeNull();
    expect(roundDiv(100, -7)).toBeNull();
    expect(roundDiv(100.5, 7)).toBeNull();
  });
});

describe('하루당 값', () => {
  it('가장 짧은 기간 옵션의 값 ÷ 그 옵션의 일수이고, 어느 옵션에서 계산했는지 함께 낸다', () => {
    const p = ad({ options: [{ days: 14, price_krw: 2_800_000 }, { days: 7, price_krw: 1_500_000 }] });
    expect(perDay(p)).toEqual({ value: 214_286, rounded: true, basis: { kind: 'period_option', days: 7, price_krw: 1_500_000 }, missing: null });
  });

  it('기간 옵션마다 하루당 값을 따로 낸다(작은 것부터). 옵션에 없는 기간은 만들지 않는다', () => {
    const p = ad({ options: [{ days: 14, price_krw: 2_800_000 }, { days: 7, price_krw: 1_500_000 }] });
    expect(optionValues(p)).toEqual([
      { kind: 'period', size: 7, price_krw: 1_500_000, each: 214_286, rounded: true },
      { kind: 'period', size: 14, price_krw: 2_800_000, each: 200_000, rounded: false },
    ]);
  });

  it('옵션이 하나뿐이면 그 옵션이 대표다. 30일 옵션뿐이라고 7일 값을 지어내지 않는다', () => {
    // 3,200,000 ÷ 30 = 106,666.67 → 106,667
    const p = ad({ price_krw: 3_200_000, options: [{ days: 30, price_krw: 3_200_000 }] });
    expect(perDay(p)).toMatchObject({ value: 106_667, rounded: true, basis: { kind: 'period_option', days: 30, price_krw: 3_200_000 } });
    expect(optionValues(p)).toHaveLength(1);
  });

  it('옵션이 없고 판매가만 있으면 기간을 몰라 하루당 값을 내지 않는다(판매가를 하루 값으로 치지 않는다)', () => {
    const p = ad({ price_krw: 900_000, options: [] });
    expect(perDay(p)).toEqual({ value: null, rounded: false, basis: null, missing: { reason: 'no_period', fields: ['period_options'] } });
    expect(optionValues(p)).toEqual([]);
    expect(compareRow(p).values.price_krw.value).toBe(900_000);
  });

  it('옵션이 적혀 있어도 쓸 수 없는 값(0일, 0원)이면 건너뛴다. 남는 것이 없으면 값이 틀린 것이다', () => {
    expect(perDay(ad({ options: [{ days: 0, price_krw: 100 }, { days: 10, price_krw: 1_000_000 }] }))).toMatchObject({ value: 100_000, rounded: false });
    expect(perDay(ad({ options: [{ days: 0, price_krw: 100 }, { days: 7, price_krw: 0 }, 'x'] })).missing).toEqual({ reason: 'bad_value', fields: ['period_options'] });
  });

  it('쓸 수 없어 뺀 옵션의 수를 줄에 함께 낸다(말없이 버리지 않는다)', () => {
    // 700,001 ÷ 14 = 50,000.07… → 50,000
    const p = ad({ options: [{ days: 0, price_krw: 100 }, { days: 14, price_krw: 700_001 }, 'x'] });
    expect(perDay(p)).toMatchObject({ value: 50_000, rounded: true, basis: { days: 14, price_krw: 700_001 } });
    expect(skippedOptions(p)).toBe(2);
    expect(compareRow(p).optionsSkipped).toBe(2);
    expect(compareRow(ad()).optionsSkipped).toBe(0);
    expect(compareRow(goods()).optionsSkipped).toBe(0);
    expect(compareRow(catering({ options: [{ qty: 0, price_krw: 5 }, { qty: 10, price_krw: 50 }] })).optionsSkipped).toBe(1);
  });

  it('일수가 같은 옵션이 둘이면 대표 판매가와 값이 같은 것이 대표다. 같은 것이 없으면 값이 작은 쪽이다', () => {
    const options = [{ days: 7, price_krw: 1_500_000 }, { days: 7, price_krw: 1_400_000 }];
    // 판매가 1,500,000 → 1,500,000 ÷ 7 = 214,285.7… → 214,286 (1,400,000 ÷ 7 = 200,000 이 아니다)
    expect(perDay(ad({ price_krw: 1_500_000, options }))).toMatchObject({ value: 214_286, rounded: true, basis: { days: 7, price_krw: 1_500_000 } });
    // 1,500,000 × 1,000 ÷ (7 × 100,000) = 2,142.8… → 2,143
    expect(perThousandFootfall(ad({ price_krw: 1_500_000, options, spec: { footfall_per_day: 100_000 } }))).toMatchObject({ value: 2_143, basis: { price_krw: 1_500_000 } });
    // 판매가가 어느 옵션과도 다르면 값이 작은 쪽
    expect(perDay(ad({ price_krw: 999, options }))).toMatchObject({ value: 200_000, rounded: false, basis: { price_krw: 1_400_000 } });
    // 더 긴 기간의 옵션이 판매가와 같아도 대표는 가장 짧은 기간에서만 고른다
    expect(perDay(ad({ price_krw: 2_800_000, options: [...options, { days: 14, price_krw: 2_800_000 }] }))).toMatchObject({ value: 200_000, basis: { days: 7 } });
  });
});

describe('하루 유동인구 1,000명당 값', () => {
  it('하루당 값과 유동인구가 둘 다 있을 때만 낸다. 한 번에 나눠 반올림이 두 번 쌓이지 않는다', () => {
    // 3,200,000 × 1,000 ÷ (30 × 140,000) = 761.90… → 762  (반올림한 106,667 로 다시 나누면 761.91 로 같지만 한 번만 반올림한다)
    const p = ad({ options: [{ days: 30, price_krw: 3_200_000 }], spec: { footfall_per_day: 140_000 } });
    expect(perThousandFootfall(p)).toEqual({ value: 762, rounded: true, basis: { kind: 'per_footfall', days: 30, price_krw: 3_200_000, footfall: 140_000 }, missing: null });
    // 1,100,000 × 1,000 ÷ (30 × 30,000) = 1,222.22… → 1,222
    expect(perThousandFootfall(ad({ options: [{ days: 30, price_krw: 1_100_000 }], spec: { footfall_per_day: 30_000 } }))).toMatchObject({ value: 1_222, rounded: true });
  });

  it('반올림한 하루당 값을 다시 나누지 않는다', () => {
    // 5 × 1,000 ÷ (2 × 3) = 833.3… → 833. 하루당 값 5 ÷ 2 = 2.5 → 3 을 다시 나누면 3 × 1,000 ÷ 3 = 1,000 이 되어 틀린다.
    const p = ad({ price_krw: 5, options: [{ days: 2, price_krw: 5 }], spec: { footfall_per_day: 3 } });
    expect(perDay(p)).toMatchObject({ value: 3, rounded: true });
    expect(perThousandFootfall(p)).toEqual({ value: 833, rounded: true, basis: { kind: 'per_footfall', days: 2, price_krw: 5, footfall: 3 }, missing: null });
  });

  it('나누어떨어지면 반올림 표시가 없다', () => {
    // 1,000,000 × 1,000 ÷ (10 × 50,000) = 2,000
    expect(perThousandFootfall(ad({ options: [{ days: 10, price_krw: 1_000_000 }], spec: { footfall_per_day: 50_000 } }))).toMatchObject({ value: 2_000, rounded: false });
  });

  it('유동인구가 없으면 없음이다. 다른 칸(송출 횟수 등)에서 짐작하지 않는다', () => {
    const p = ad({ spec: { plays_per_day: 100, spot_seconds: 20 } });
    expect(perThousandFootfall(p).missing).toEqual({ reason: 'no_value', fields: ['footfall_per_day'] });
    expect(compareRow(p).values.footfall_per_day.missing).toEqual({ reason: 'no_value', fields: ['footfall_per_day'] });
  });

  it('기간 옵션이 없으면 유동인구가 있어도 내지 않는다', () => {
    expect(perThousandFootfall(ad({ options: [], spec: { footfall_per_day: 50_000 } })).missing).toEqual({ reason: 'no_period', fields: ['period_options'] });
    expect(perThousandFootfall(ad({ options: [] })).missing).toEqual({ reason: 'no_period', fields: ['period_options', 'footfall_per_day'] });
  });

  it('유동인구가 0 이하면 나누지 않는다', () => {
    expect(perThousandFootfall(ad({ spec: { footfall_per_day: 0 } })).missing).toEqual({ reason: 'bad_value', fields: ['footfall_per_day'] });
  });
});

describe('화면 넓이', () => {
  it('가로 × 세로(m²)', () => {
    expect(screenArea({ size_m: { width: 7, height: 12 } })).toEqual({ value: 84, rounded: false, basis: { kind: 'size', width: 7, height: 12 }, missing: null });
    expect(screenArea({ size_m: { width: 2, height: 1.5 } }).value).toBe(3);
    expect(screenArea({ size_m: { width: 3.7, height: 1 } }).value).toBe(3.7);
    // 소수 오차가 끼지 않는다(0.1 × 0.2 를 그대로 곱하면 0.020000000000000004 다).
    expect(screenArea({ size_m: { width: 0.1, height: 0.2 } }).value).toBe(0.02);
  });
  it('소수 셋째 자리가 있어도 적힌 숫자 그대로 곱한다. 넷째 자리를 넘으면 반올림하고 알린다', () => {
    // 1.005 × 2 = 2.01 (1.005 × 100 은 소수 오차로 100.49999… 가 된다. 그렇게 세면 2 가 나온다)
    expect(screenArea({ size_m: { width: 1.005, height: 2 } })).toEqual({ value: 2.01, rounded: false, basis: { kind: 'size', width: 1.005, height: 2 }, missing: null });
    // 12.34 × 5.67 = 69.9678
    expect(screenArea({ size_m: { width: 12.34, height: 5.67 } })).toMatchObject({ value: 69.9678, rounded: false });
    // 1.005 × 1.005 = 1.010025 → 1.01 (넷째 자리로 반올림)
    expect(screenArea({ size_m: { width: 1.005, height: 1.005 } })).toMatchObject({ value: 1.01, rounded: true });
    // 1.234 × 1.11 = 1.36974 → 1.3697
    expect(screenArea({ size_m: { width: 1.234, height: 1.11 } })).toMatchObject({ value: 1.3697, rounded: true });
  });
  it('크기가 없으면 없음. 해상도에서 짐작하지 않는다', () => {
    expect(screenArea({ resolution_px: { width: 1080, height: 1920 } }).missing).toEqual({ reason: 'no_value', fields: ['size_m'] });
    expect(screenArea({ size_m: { width: 0, height: 3 } }).missing?.reason).toBe('bad_value');
  });
});

describe('하루 운영 시간', () => {
  it('같은 날이면 끝 − 시작', () => {
    // 09:00~15:00 = 6시간 = 360분
    expect(openMinutes({ hours: { open: '09:00', close: '15:00', nextDay: false } }, 'hours').value).toBe(360);
  });
  it('다음 날로 넘어가면 그만큼 더한다', () => {
    // 05:00~다음 날 01:00 = 19시간 + 1시간 = 20시간 = 1,200분
    expect(openMinutes({ hours: { open: '05:00', close: '01:00', nextDay: true } }, 'hours')).toEqual({
      value: 1200, rounded: false, basis: { kind: 'hours', open: '05:00', close: '01:00', nextDay: true }, missing: null,
    });
    // 05:30~다음 날 00:30 = 19시간 = 1,140분
    expect(openMinutes({ hours: { open: '05:30', close: '00:30', nextDay: true } }, 'hours').value).toBe(1140);
    // 04:00~다음 날 00:00 = 20시간
    expect(openMinutes({ hours: { open: '04:00', close: '00:00', nextDay: true } }, 'hours').value).toBe(1200);
  });
  it('시작과 끝이 같고 다음 날이면 24시간이다', () => {
    expect(openMinutes({ hours: { open: '00:00', close: '00:00', nextDay: true } }, 'hours').value).toBe(1440);
  });
  it('0분 이하이거나 하루를 넘으면 계산하지 않는다', () => {
    expect(openMinutes({ hours: { open: '10:00', close: '09:00', nextDay: false } }, 'hours').missing?.reason).toBe('bad_value');
    expect(openMinutes({ hours: { open: '10:00', close: '10:00', nextDay: false } }, 'hours').missing?.reason).toBe('bad_value');
    expect(openMinutes({ hours: { open: '05:00', close: '06:00', nextDay: true } }, 'hours').missing?.reason).toBe('bad_value');
  });
  it('운영 시간이 없으면 없음', () => {
    expect(openMinutes({}, 'hours').missing).toEqual({ reason: 'no_value', fields: ['hours'] });
  });
  it('케이터링은 케이터링의 운영 시간 칸을 읽는다', () => {
    const row = compareRow(catering({ spec: { service_hours: { open: '11:00', close: '13:00', nextDay: false } } }));
    expect(row.values.open_minutes.value).toBe(120);
  });
});

describe('하루 노출 시간', () => {
  it('하루 송출 횟수 × 한 번 길이(초)', () => {
    expect(exposureSeconds({ plays_per_day: 100, spot_seconds: 20 })).toEqual({ value: 2000, rounded: false, basis: { kind: 'exposure', plays: 100, seconds: 20 }, missing: null });
  });
  it('둘 가운데 하나라도 없으면 없음이고 어느 칸이 없는지 낸다', () => {
    expect(exposureSeconds({ plays_per_day: 100 }).missing).toEqual({ reason: 'no_value', fields: ['spot_seconds'] });
    expect(exposureSeconds({}).missing).toEqual({ reason: 'no_value', fields: ['plays_per_day', 'spot_seconds'] });
    expect(exposureSeconds({ plays_per_day: -1, spot_seconds: 20 }).missing).toEqual({ reason: 'bad_value', fields: ['plays_per_day'] });
  });
});

describe('마감과 부가세', () => {
  it('마감 일수는 적힌 그대로다. 0일(당일까지)도 값이다', () => {
    const row = compareRow(ad({ spec: { booking_deadline_days: 14, material_deadline_days: 0 } }));
    expect(row.values.booking_deadline_days).toMatchObject({ value: 14, basis: { kind: 'field', field: 'booking_deadline_days' } });
    expect(row.values.material_deadline_days.value).toBe(0);
    // 전액 환불 일수는 안 적혀 있다. 예약 마감에서 짐작하지 않는다.
    expect(row.values.refund_full_days.missing).toEqual({ reason: 'no_value', fields: ['refund_full_days'] });
  });
  it('부가세가 적혀 있지 않으면 모름(null)이다', () => {
    expect(compareRow(ad({ vat_included: null })).vatIncluded).toBeNull();
    expect(compareRow(ad({ vat_included: true })).vatIncluded).toBe(true);
  });
});

describe('케이터링: 한 개당 값', () => {
  it('가장 적은 수량 옵션과 가장 많은 수량 옵션에서 각각 낸다', () => {
    const p = catering({ options: [{ qty: 300, price_krw: 2_100_000 }, { qty: 100, price_krw: 800_000 }, { qty: 200, price_krw: 1_500_000 }] });
    // 800,000 ÷ 100 = 8,000   2,100,000 ÷ 300 = 7,000
    expect(perUnit(p, 'min')).toEqual({ value: 8_000, rounded: false, basis: { kind: 'quantity_option', qty: 100, price_krw: 800_000 }, missing: null });
    expect(perUnit(p, 'max')).toEqual({ value: 7_000, rounded: false, basis: { kind: 'quantity_option', qty: 300, price_krw: 2_100_000 }, missing: null });
    expect(optionValues(p).map((o) => [o.size, o.each])).toEqual([[100, 8_000], [200, 7_500], [300, 7_000]]);
  });
  it('옵션이 하나뿐이면 둘이 같은 옵션이다', () => {
    // 100,000 ÷ 30 = 3,333.33… → 3,333
    const p = catering({ options: [{ qty: 30, price_krw: 100_000 }] });
    expect(perUnit(p, 'min')).toMatchObject({ value: 3_333, rounded: true, basis: { qty: 30 } });
    expect(perUnit(p, 'max')).toEqual(perUnit(p, 'min'));
  });
  it('수량이 같은 옵션이 둘이면: 가장 적은 수량은 판매가와 같은 것, 가장 많은 수량은 값이 작은 쪽', () => {
    const p = catering({ price_krw: 900_000, options: [{ qty: 100, price_krw: 800_000 }, { qty: 100, price_krw: 900_000 }, { qty: 300, price_krw: 2_400_000 }, { qty: 300, price_krw: 2_100_000 }] });
    expect(perUnit(p, 'min')).toMatchObject({ value: 9_000, basis: { qty: 100, price_krw: 900_000 } });
    expect(perUnit(p, 'max')).toMatchObject({ value: 7_000, basis: { qty: 300, price_krw: 2_100_000 } });
  });
  it('수량 옵션이 없으면 수량을 몰라 한 개당 값을 내지 않는다', () => {
    expect(perUnit(catering({ options: [] }), 'min').missing).toEqual({ reason: 'no_quantity', fields: ['quantity_options'] });
  });
});

describe('굿즈', () => {
  it('판매가·최소 주문 수량·제작 기간을 그대로 읽는다', () => {
    const row = compareRow(goods({ price_krw: 4_500, spec: { min_order_qty: 30, lead_time_days: 7 } }));
    expect(row.values.price_krw.value).toBe(4_500);
    expect(row.values.min_order_qty.value).toBe(30);
    expect(row.values.lead_time_days.value).toBe(7);
    expect(row.options).toEqual([]);
    expect(row.region).toBeNull();
  });
  it('판매가가 0 이하면 값이 아니다', () => {
    expect(compareRow(goods({ price_krw: 0 })).values.price_krw).toEqual({ value: null, rounded: false, basis: null, missing: { reason: 'bad_value', fields: ['price_krw'] } });
    expect(compareRow(goods({ price_krw: -1 })).values.price_krw.missing?.reason).toBe('bad_value');
  });
  it('0 이 값일 수 없는 칸의 0 은 값이 틀린 것이다(없음). 마감·제작 일수의 0 만 값이다', () => {
    const row = compareRow(ad({ spec: { footfall_per_day: 0, plays_per_day: 0, spot_seconds: 0 } }));
    expect(row.values.footfall_per_day.missing).toEqual({ reason: 'bad_value', fields: ['footfall_per_day'] });
    expect(row.values.plays_per_day.missing).toEqual({ reason: 'bad_value', fields: ['plays_per_day'] });
    expect(row.values.spot_seconds.missing).toEqual({ reason: 'bad_value', fields: ['spot_seconds'] });
    expect(row.values.exposure_seconds.missing).toEqual({ reason: 'bad_value', fields: ['plays_per_day', 'spot_seconds'] });
    const slogan = compareRow(goods({ spec: { min_order_qty: 0, lead_time_days: 0 } }));
    expect(slogan.values.min_order_qty.missing).toEqual({ reason: 'bad_value', fields: ['min_order_qty'] });
    expect(slogan.values.lead_time_days.value).toBe(0);
  });
  it('최소 주문 수량이 없으면 없음. 1개라고 치지 않는다', () => {
    expect(compareRow(goods()).values.min_order_qty.missing).toEqual({ reason: 'no_value', fields: ['min_order_qty'] });
  });
});

describe('잣대의 정의', () => {
  it('잣대마다 정의가 하나씩, 약속의 순서대로 있다', () => {
    expect(COMPARE_METRIC_DEFS.map((d) => d.key)).toEqual([...COMPARE_METRICS]);
    for (const def of COMPARE_METRIC_DEFS) {
      expect(def.types.length).toBeGreaterThan(0);
      expect(def.money).toBe(def.unit === 'krw');
    }
  });
  it('어느 쪽이 좋다고 말할 수 없는 잣대는 넓이와 한 번 길이다. 판매가는 굿즈에서만 방향이 있다', () => {
    expect(COMPARE_METRIC_DEFS.filter((d) => d.better === null).map((d) => d.key)).toEqual(['area_m2', 'spot_seconds']);
    expect(COMPARE_METRIC_DEFS.filter((d) => d.betterOnlyFor).map((d) => [d.key, d.betterOnlyFor])).toEqual([['price_krw', ['goods']]]);
  });
});

describe('상품 하나의 줄', () => {
  it('모든 잣대에 값 또는 없음의 까닭이 있고 약속의 꼴과 같다', () => {
    for (const p of [ad(), catering(), goods(), ad({ options: [], spec: { hours: 'x', size_m: 3 } })]) {
      const row = compareRow(p);
      expect(CompareRowSchema.safeParse(row).success).toBe(true);
      expect(Object.keys(row.values).sort()).toEqual([...COMPARE_METRICS].sort());
    }
  });
  it('그 종류에 없는 잣대는 "해당 없음"이다', () => {
    const row = compareRow(goods());
    expect(row.values.per_day_krw.missing).toEqual({ reason: 'not_applicable', fields: [] });
    for (const metric of metricsOfType('goods')) expect(row.values[metric].missing?.reason).not.toBe('not_applicable');
  });
  it('위치는 광고는 위치 칸, 케이터링은 출장 지역 칸이다', () => {
    expect(compareRow(ad({ spec: { region: ' 합정역 7번출구 ' } })).region).toBe('합정역 7번출구');
    expect(compareRow(catering({ spec: { service_region: '서울 전역' } })).region).toBe('서울 전역');
    expect(compareRow(ad()).region).toBeNull();
  });
});
