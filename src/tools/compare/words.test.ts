// 값을 사람 말로 적는 것과, 화면에서 고른 값을 주소로 바꾸는 것.
import { describe, expect, it } from 'vitest';
import { CompareQuerySchema } from '@/contract/tools/compare';
import { ad, catering, goods } from './fixtures';
import { compareRow, optionValues } from './metrics';
import { comparePath, nextSort, tableMetrics, togglePick } from './query';
import {
  basisText,
  belowOneWon,
  betterText,
  durationText,
  metricValueText,
  missingText,
  optionText,
  otherOptionLines,
  rankHeadText,
  rankScopeText,
  secondsText,
  skippedText,
  vatText,
  warningText,
  withheldText,
} from './words';

describe('값을 말로', () => {
  it('단위를 붙인다', () => {
    expect(metricValueText('per_day_krw', 214_286)).toBe('214,286원');
    expect(metricValueText('footfall_per_day', 140_000)).toBe('140,000명');
    expect(metricValueText('area_m2', 3.7)).toBe('3.7 m²');
    expect(metricValueText('open_minutes', 1200)).toBe('20시간');
    expect(metricValueText('plays_per_day', 100)).toBe('100회');
    expect(metricValueText('exposure_seconds', 2000)).toBe('2,000초(33분 20초)');
    expect(metricValueText('booking_deadline_days', 14)).toBe('14일 전까지');
    expect(metricValueText('material_deadline_days', 0)).toBe('당일까지');
    expect(metricValueText('lead_time_days', 7)).toBe('7일');
    expect(metricValueText('min_order_qty', 30)).toBe('30개');
  });
  it('시간과 초', () => {
    expect(durationText(1140)).toBe('19시간');
    expect(durationText(1170)).toBe('19시간 30분');
    expect(durationText(45)).toBe('45분');
    expect(secondsText(20)).toBe('20초');
    expect(secondsText(3600)).toBe('3,600초(1시간)');
    expect(secondsText(86_400)).toBe('86,400초(24시간)');
    // 4,000,000,000초 = 1,111,111시간 6분 40초
    expect(secondsText(4_000_000_000)).toBe('4,000,000,000초(1,111,111시간 6분 40초)');
  });
});

describe('어디서 계산했는지', () => {
  it('하루당 값: 어느 옵션의 값을 며칠로 나눴는지', () => {
    const row = compareRow(ad({ options: [{ days: 7, price_krw: 1_500_000 }, { days: 14, price_krw: 2_800_000 }] }));
    expect(basisText(row.values.per_day_krw.basis)).toBe('7일 옵션 1,500,000원 ÷ 7');
  });
  it('유동인구 1,000명당 값, 한 개당 값, 넓이, 운영 시간, 노출 시간', () => {
    const row = compareRow(
      ad({
        options: [{ days: 30, price_krw: 3_200_000 }],
        spec: { footfall_per_day: 140_000, size_m: { width: 2, height: 1.5 }, hours: { open: '05:30', close: '00:30', nextDay: true }, plays_per_day: 100, spot_seconds: 20 },
      }),
    );
    expect(basisText(row.values.per_1000_footfall_krw.basis)).toBe('30일 옵션 3,200,000원 ÷ 30 ÷ 유동인구 140,000명 × 1,000');
    expect(basisText(row.values.area_m2.basis)).toBe('가로 2 × 세로 1.5 m');
    expect(basisText(row.values.open_minutes.basis)).toBe('05:30~다음 날 00:30');
    expect(basisText(row.values.exposure_seconds.basis)).toBe('하루 100회 × 20초');
    expect(basisText(compareRow(catering()).values.unit_krw_min_qty.basis)).toBe('수량 100 옵션 800,000원 ÷ 100');
    // 칸을 그대로 읽은 값에는 적을 것이 없다.
    expect(basisText(row.values.footfall_per_day.basis)).toBeNull();
    expect(basisText(null)).toBeNull();
  });
  it('옵션마다 한 줄', () => {
    const [seven, fourteen] = optionValues(ad({ options: [{ days: 7, price_krw: 1_500_000 }, { days: 14, price_krw: 2_800_000 }] }));
    expect(optionText(seven!)).toBe('7일 1,500,000원 → 하루 214,286원(반올림)');
    expect(optionText(fourteen!)).toBe('14일 2,800,000원 → 하루 200,000원');
    expect(optionText(optionValues(catering())[0]!)).toBe('수량 100 800,000원 → 한 개 8,000원');
  });
});

describe('없음의 까닭', () => {
  it('없는 것은 "없음", 그 종류에 없는 칸은 "해당 없음"', () => {
    const row = compareRow(ad({ options: [] }));
    expect(missingText(row.values.per_day_krw.missing!)).toEqual({ label: '없음', why: '기간 옵션이 없습니다. 기간을 몰라 하루당 값을 내지 않습니다.' });
    expect(missingText(row.values.per_1000_footfall_krw.missing!).why).toContain('하루 유동인구도 없습니다');
    expect(missingText(row.values.footfall_per_day.missing!)).toEqual({ label: '없음', why: '하루 유동인구(명) 칸이 비어 있습니다.' });
    expect(missingText(row.values.exposure_seconds.missing!).why).toBe('하루 송출 횟수, 한 번 길이(초) 칸이 비어 있습니다.');
    expect(missingText(row.values.min_order_qty.missing!).label).toBe('해당 없음');
    expect(missingText(compareRow(catering({ options: [] })).values.unit_krw_min_qty.missing!).why).toContain('수량을 몰라');
    expect(missingText(compareRow(goods({ spec: { min_order_qty: -3 } })).values.min_order_qty.missing!).why).toBe('최소 주문 수량 칸의 값으로는 계산할 수 없습니다.');
  });
  it('부가세가 적혀 있지 않으면 없음이다', () => {
    expect([vatText(true), vatText(false), vatText(null)]).toEqual(['포함', '별도', '없음']);
  });
});

describe('경고와 방향', () => {
  it('부가세가 섞였다는 말에 수와, 더하거나 빼지 않았다는 것을 적는다', () => {
    const text = warningText({ code: 'vat_mixed', included: 1, excluded: 2, unknown: 0, metrics: ['per_day_krw', 'price_krw'] });
    expect(text).toContain('별도 2건, 포함 1건');
    expect(text).toContain('더하거나 빼지 않았습니다');
    expect(text).toContain('하루당 값, 판매가');
    expect(text).not.toContain('적혀 있지 않은 것');
  });
  it('종류가 섞였다는 말', () => {
    expect(warningText({ code: 'mixed_types', types: ['ad', 'goods'], metrics: ['per_day_krw'] })).toContain('광고 지면, 굿즈');
  });
  it('방향과 좋은 쪽을 붙이지 않은 까닭', () => {
    expect(betterText('per_day_krw')).toBe('작을수록 좋음');
    expect(betterText('footfall_per_day')).toBe('클수록 좋음');
    expect(betterText('area_m2')).toBeNull();
    expect(withheldText('vat_mixed')).toContain('부가세');
    expect(withheldText('all_same')).toBeNull();
    expect(withheldText('mixed_basis', 'per_day_krw')).toBe('값을 나눈 옵션의 기간이 서로 달라 좋은 쪽을 표시하지 않습니다.');
    expect(withheldText('mixed_basis', 'unit_krw_max_qty')).toContain('수량이 서로 달라');
    expect(withheldText(null)).toBeNull();
  });
});

describe('화면에서 고른 값 → 주소', () => {
  const base = { type: null, subtype: null, region: '', sort: null, ids: [] } as const;
  it('고른 것만 싣는다. 만든 주소는 약속의 꼴을 통과한다', () => {
    expect(comparePath(base)).toBe('/api/compare');
    const path = comparePath({ type: 'ad', subtype: '전광판', region: ' 합정 ', sort: { metric: 'per_day_krw', order: 'asc' }, ids: [5, 7] });
    const params = Object.fromEntries(new URL(path, 'http://chaeum.test').searchParams);
    expect(params).toEqual({ type: 'ad', subtype: '전광판', region: '합정', sort: 'per_day_krw', order: 'asc', ids: '5,7' });
    expect(CompareQuerySchema.safeParse(params).success).toBe(true);
  });
  it('종류와 안 맞는 갈래, 하나뿐인 고르기는 보내지 않는다', () => {
    expect(comparePath({ ...base, type: 'goods', subtype: '전광판' })).toBe('/api/compare?type=goods');
    expect(comparePath({ ...base, ids: [5] })).toBe('/api/compare');
  });
  it('잣대 칸을 누르면: 처음은 좋은 쪽이 앞, 다시 누르면 거꾸로', () => {
    expect(nextSort(null, 'per_day_krw')).toEqual({ metric: 'per_day_krw', order: 'asc' });
    expect(nextSort({ metric: 'per_day_krw', order: 'asc' }, 'per_day_krw')).toEqual({ metric: 'per_day_krw', order: 'desc' });
    expect(nextSort({ metric: 'per_day_krw', order: 'desc' }, 'footfall_per_day')).toEqual({ metric: 'footfall_per_day', order: 'desc' });
  });
  it('고르기는 넷까지', () => {
    expect(togglePick([1, 2], 3)).toEqual([1, 2, 3]);
    expect(togglePick([1, 2, 3], 2)).toEqual([1, 3]);
    expect(togglePick([1, 2, 3, 4], 5)).toEqual([1, 2, 3, 4]);
  });
  it('표의 칸: 종류를 고르면 그 종류의 잣대, 안 고르면 표의 종류 모두에 있는 잣대만', () => {
    expect(tableMetrics('goods', [])).toEqual(['price_krw', 'min_order_qty', 'lead_time_days']);
    expect(tableMetrics(null, [{ type: 'ad' }, { type: 'goods' }])).toEqual(['price_krw']);
    expect(tableMetrics(null, [{ type: 'ad' }, { type: 'catering' }])).toEqual(['open_minutes', 'price_krw']);
    expect(tableMetrics(null, [{ type: 'catering' }])).toContain('unit_krw_min_qty');
    expect(tableMetrics(null, [])).toEqual(['price_krw']);
  });
});

describe('가장자리의 말', () => {
  it('반올림하면 0원이 되는 값은 "1원 미만"이다. 0원이라고 적지 않는다', () => {
    // 1 ÷ 30 = 0.03… → 0
    const row = compareRow(ad({ price_krw: 1, options: [{ days: 30, price_krw: 1 }] }));
    const v = row.values.per_day_krw;
    expect(v).toMatchObject({ value: 0, rounded: true });
    expect(metricValueText('per_day_krw', 0, true)).toBe('1원 미만');
    expect(belowOneWon('per_day_krw', 0, true)).toBe(true);
    expect(belowOneWon('per_day_krw', 1, true)).toBe(false);
    // 돈이 아닌 0 과 반올림이 아닌 0 은 그대로다.
    expect(belowOneWon('booking_deadline_days', 0, false)).toBe(false);
    expect(metricValueText('booking_deadline_days', 0)).toBe('당일까지');
    expect(optionText(row.options[0]!)).toBe('30일 1원 → 하루 1원 미만');
  });

  it('다른 옵션: 칸의 값을 낸 옵션은 빼고 적는다', () => {
    // 같은 7일 옵션이 둘이고 판매가는 비싼 쪽이다. 대표(1,500,000)를 빼고 나머지 둘을 적는다.
    const board = compareRow(ad({ price_krw: 1_500_000, options: [{ days: 7, price_krw: 1_400_000 }, { days: 7, price_krw: 1_500_000 }, { days: 14, price_krw: 2_800_000 }] }));
    expect(otherOptionLines(board, 'per_day_krw')).toEqual(['다른 옵션: 7일 1,400,000원 → 하루 200,000원', '다른 옵션: 14일 2,800,000원 → 하루 200,000원']);
    expect(otherOptionLines(board, 'footfall_per_day')).toEqual([]);
    // 케이터링: 가장 적은 수량·가장 많은 수량 칸에 쓴 옵션을 빼면 가운데만 남는다.
    const truck = compareRow(catering({ options: [{ qty: 100, price_krw: 800_000 }, { qty: 200, price_krw: 1_500_000 }, { qty: 300, price_krw: 2_100_000 }] }));
    expect(otherOptionLines(truck, 'unit_krw_min_qty')).toEqual(['다른 옵션: 수량 200 1,500,000원 → 한 개 7,500원']);
    expect(otherOptionLines(compareRow(catering()), 'unit_krw_min_qty')).toEqual([]);
  });

  it('뺀 옵션이 있으면 그렇다고 적는다', () => {
    expect(skippedText(0)).toBeNull();
    expect(skippedText(2)).toContain('쓸 수 없는 옵션 2개를 뺐습니다');
  });

  it('차례를 묶은 머리줄과 한마디', () => {
    expect(rankHeadText(null, null)).toBeNull();
    expect(rankHeadText(null, 'vat_excluded')).toBe('부가세 별도끼리');
    expect(rankHeadText('ad', null)).toBe('광고 지면끼리');
    expect(rankHeadText('goods', 'vat_included')).toBe('굿즈끼리 · 부가세 포함끼리');
    expect(rankScopeText({ split: false, byType: false })).toBe('');
    expect(rankScopeText({ split: true, byType: false })).toBe(' (부가세가 같은 것끼리)');
    expect(rankScopeText({ split: true, byType: true })).toBe(' (종류가 같은 것끼리, 부가세가 같은 것끼리)');
  });
});
