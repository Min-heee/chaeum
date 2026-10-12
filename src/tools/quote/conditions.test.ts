import { describe, expect, it } from 'vitest';
import { QuoteConditionsSchema, type QuoteExtraction } from '@/contract/tools/quote';
import { resolveBudget, resolveConditions, resolveDateRange } from './conditions';

const NONE: QuoteExtraction = {
  lang: 'ko', budget_raw: null, budget_krw: null, region: null, date_raw: null, date: null, type: null, subtype: null, qty: null, days: null,
};
const parts = (p: Partial<NonNullable<QuoteExtraction['date']>>) => ({ year: null, month: null, day_from: null, day_to: null, week_of_month: null, ...p });
const TODAY = '2026-10-12';

describe('예산 읽기', () => {
  it('코드가 단위까지 읽은 표현은 코드 값을 쓴다(모델 값이 달라도)', () => {
    expect(resolveBudget('300만 원', 9)).toEqual({ budgetKrw: 3_000_000, budgetBy: 'code' });
    expect(resolveBudget('3 million won', null)).toEqual({ budgetKrw: 3_000_000, budgetBy: 'code' });
    expect(resolveBudget('300万韩元', null)).toEqual({ budgetKrw: 3_000_000, budgetBy: 'code' });
    expect(resolveBudget('KRW 2,200,000', null)).toEqual({ budgetKrw: 2_200_000, budgetBy: 'code' });
  });
  it('코드가 단위를 짐작해야 하는 표현은 모델이 읽은 값을 쓰고 그렇게 표시한다', () => {
    expect(resolveBudget('300', 3_000_000)).toEqual({ budgetKrw: 3_000_000, budgetBy: 'model' });
    expect(resolveBudget('3百万韩元', 3_000_000)).toEqual({ budgetKrw: 3_000_000, budgetBy: 'model' });
    // 모델 값도 없으면 짐작한 값을 쓰지 않는다.
    expect(resolveBudget('300', null)).toEqual({ budgetKrw: null, budgetBy: null });
  });
  it('코드가 못 읽은 표현(범위)은 모델 값을 쓴다', () => {
    expect(resolveBudget('100~150만원', 1_500_000)).toEqual({ budgetKrw: 1_500_000, budgetBy: 'model' });
  });
  it('원이 아닌 돈은 예산 조건이 없다. 모델이 바꿔 읽은 값도 쓰지 않는다', () => {
    for (const raw of ['$2,000', '600달러쯤', 'around 500 USD', '5000元人民币', '5,000 yuan', '3万円', '€300']) {
      expect(resolveBudget(raw, 2_700_000)).toEqual({ budgetKrw: null, budgetBy: null });
    }
    // "韩元"의 元 은 원이다.
    expect(resolveBudget('150万韩元以内', null)).toEqual({ budgetKrw: 1_500_000, budgetBy: 'code' });
  });
  it('영어 통화 낱말은 낱말째로만 본다. 숫자에 붙은 것은 본다', () => {
    // "europe" 의 eur 에 걸리지 않는다. 코드가 못 읽은 표현이라 모델 값을 쓴다.
    expect(resolveBudget('예산 300만원 europe', 3_000_000)).toEqual({ budgetKrw: 3_000_000, budgetBy: 'model' });
    expect(resolveBudget('500usd', 700_000)).toEqual({ budgetKrw: null, budgetBy: null });
    expect(resolveBudget('200 euros', 300_000)).toEqual({ budgetKrw: null, budgetBy: null });
  });
  it('원화와 다른 통화가 함께 있으면 원화 조각만 읽는다. 하나로 정하지 못하면 예산 조건이 없다', () => {
    expect(resolveBudget('3000000 won (about $2,200)', 3_000_000)).toEqual({ budgetKrw: 3_000_000, budgetBy: 'code' });
    expect(resolveBudget('300만원, 약 2200달러', null)).toEqual({ budgetKrw: 3_000_000, budgetBy: 'code' });
    expect(resolveBudget('2,000,000 KRW / 1,500 USD', null)).toEqual({ budgetKrw: 2_000_000, budgetBy: 'code' });
    // 한 조각에 두 통화가 섞였으면 가르지 못한다. 모델 값도 쓰지 않는다.
    expect(resolveBudget('300만원 또는 2200달러', 3_000_000)).toEqual({ budgetKrw: null, budgetBy: null });
  });
  it('빼기 부호가 붙은 표현은 예산 조건이 없다. 범위의 줄표는 부호가 아니다', () => {
    expect(resolveBudget('-300만원', 3_000_000)).toEqual({ budgetKrw: null, budgetBy: null });
    expect(resolveBudget('예산 −300만원', null)).toEqual({ budgetKrw: null, budgetBy: null });
    expect(resolveBudget('100-150만원', 1_500_000)).toEqual({ budgetKrw: 1_500_000, budgetBy: 'model' });
  });
  it('표현 없이 모델 값만 왔으면 그 값을 쓰되 0 이하·소수·터무니없이 큰 값은 버린다', () => {
    expect(resolveBudget(null, 800_000)).toEqual({ budgetKrw: 800_000, budgetBy: 'model' });
    for (const bad of [0, -5, 1.5, 1e15, Number.NaN]) expect(resolveBudget(null, bad)).toEqual({ budgetKrw: null, budgetBy: null });
  });
});

describe('날짜 조각 → 날짜 범위', () => {
  it('N째 주는 (N−1)×7+1 일부터 7일이다', () => {
    expect(resolveDateRange(parts({ month: 5, week_of_month: 1 }), TODAY)).toEqual({ dateFrom: '2027-05-01', dateTo: '2027-05-07' });
    expect(resolveDateRange(parts({ month: 3, week_of_month: 2 }), TODAY)).toEqual({ dateFrom: '2027-03-08', dateTo: '2027-03-14' });
  });
  it('다섯째 주는 말일에서 자른다. 그 달에 없는 주차면 날짜로 바꾸지 못한다', () => {
    expect(resolveDateRange(parts({ month: 11, week_of_month: 5 }), TODAY)).toEqual({ dateFrom: '2026-11-29', dateTo: '2026-11-30' });
    // 평년 2월은 28일까지라 다섯째 주(29일~)가 없다. 처음 오는 2월(2027) 하나만 보고, 다음 윤년의 2월 29일로 바꾸지 않는다.
    expect(resolveDateRange(parts({ month: 2, week_of_month: 5 }), TODAY)).toBeNull();
    // 처음 오는 2월이 윤년이면 그 달에는 다섯째 주가 있다(29일 하루).
    expect(resolveDateRange(parts({ month: 2, week_of_month: 5 }), '2027-10-12')).toEqual({ dateFrom: '2028-02-29', dateTo: '2028-02-29' });
    // 이번 달의 그 주가 이미 지났으면 다음 해의 그 달이다.
    expect(resolveDateRange(parts({ month: 10, week_of_month: 1 }), TODAY)).toEqual({ dateFrom: '2027-10-01', dateTo: '2027-10-07' });
    expect(resolveDateRange(parts({ month: 5, week_of_month: 6 }), TODAY)).toBeNull();
  });
  it('달만 있으면 1일부터 말일까지', () => {
    expect(resolveDateRange(parts({ month: 12 }), TODAY)).toEqual({ dateFrom: '2026-12-01', dateTo: '2026-12-31' });
    expect(resolveDateRange(parts({ year: 2028, month: 2 }), TODAY)).toEqual({ dateFrom: '2028-02-01', dateTo: '2028-02-29' });
  });
  it('날이 하나면 하루짜리 범위, 둘이면 그 사이', () => {
    expect(resolveDateRange(parts({ month: 11, day_from: 20 }), TODAY)).toEqual({ dateFrom: '2026-11-20', dateTo: '2026-11-20' });
    expect(resolveDateRange(parts({ month: 5, day_from: 3, day_to: 5 }), TODAY)).toEqual({ dateFrom: '2027-05-03', dateTo: '2027-05-05' });
    expect(resolveDateRange(parts({ month: 5, day_to: 5 }), TODAY)).toEqual({ dateFrom: '2027-05-05', dateTo: '2027-05-05' });
  });
  it('연도가 없으면 오늘 이후로 처음 오는 날이다. 오늘은 아직 지나지 않았다', () => {
    expect(resolveDateRange(parts({ month: 10, day_from: 12 }), TODAY)).toEqual({ dateFrom: '2026-10-12', dateTo: '2026-10-12' });
    expect(resolveDateRange(parts({ month: 10, day_from: 11 }), TODAY)).toEqual({ dateFrom: '2027-10-11', dateTo: '2027-10-11' });
    expect(resolveDateRange(parts({ month: 9 }), TODAY)).toEqual({ dateFrom: '2027-09-01', dateTo: '2027-09-30' });
  });
  it('범위가 오늘을 품으면 첫날을 오늘로 당긴다(이번 달, 이번 주). 지난 날에 시작하는 범위가 되지 않는다', () => {
    expect(resolveDateRange(parts({ month: 10 }), TODAY)).toEqual({ dateFrom: TODAY, dateTo: '2026-10-31' });
    expect(resolveDateRange(parts({ month: 10, week_of_month: 2 }), TODAY)).toEqual({ dateFrom: TODAY, dateTo: '2026-10-14' });
    expect(resolveDateRange(parts({ month: 10, day_from: 10, day_to: 20 }), TODAY)).toEqual({ dateFrom: TODAY, dateTo: '2026-10-20' });
    // 연도가 적힌 범위도 같다.
    expect(resolveDateRange(parts({ year: 2026, month: 10 }), TODAY)).toEqual({ dateFrom: TODAY, dateTo: '2026-10-31' });
    // 오늘이 범위의 첫날·끝날이면 그대로다. 아직 안 온 범위도 그대로다.
    expect(resolveDateRange(parts({ month: 10, day_from: 12, day_to: 15 }), TODAY)).toEqual({ dateFrom: TODAY, dateTo: '2026-10-15' });
    expect(resolveDateRange(parts({ month: 10, day_from: 5, day_to: 12 }), TODAY)).toEqual({ dateFrom: TODAY, dateTo: TODAY });
    expect(resolveDateRange(parts({ month: 10, day_from: 13, day_to: 15 }), TODAY)).toEqual({ dateFrom: '2026-10-13', dateTo: '2026-10-15' });
  });
  it('해가 바뀌는 날: 12월 31일에 묻는 1월 1일은 다음 해다', () => {
    expect(resolveDateRange(parts({ month: 1, day_from: 1 }), '2026-12-31')).toEqual({ dateFrom: '2027-01-01', dateTo: '2027-01-01' });
  });
  it('연도 없는 2월 29일은 다음 윤년이다', () => {
    expect(resolveDateRange(parts({ month: 2, day_from: 29 }), TODAY)).toEqual({ dateFrom: '2028-02-29', dateTo: '2028-02-29' });
  });
  it('연도가 적혀 있으면 지난 날이어도 그대로 둔다(마감 세기가 늦었다고 알린다)', () => {
    expect(resolveDateRange(parts({ year: 2026, month: 3, day_from: 2 }), TODAY)).toEqual({ dateFrom: '2026-03-02', dateTo: '2026-03-02' });
  });
  it('달력에 없는 날, 달이 없는 조각, 끝이 시작보다 앞인 범위는 날짜로 바꾸지 못한다', () => {
    expect(resolveDateRange(parts({ month: 2, day_from: 30 }), TODAY)).toBeNull();
    expect(resolveDateRange(parts({ year: 2027, month: 2, day_from: 29 }), TODAY)).toBeNull();
    expect(resolveDateRange(parts({ month: 4, day_from: 31 }), TODAY)).toBeNull();
    expect(resolveDateRange(parts({ day_from: 3 }), TODAY)).toBeNull();
    expect(resolveDateRange(parts({ month: 13 }), TODAY)).toBeNull();
    expect(resolveDateRange(parts({ month: 5, day_from: 5, day_to: 3 }), TODAY)).toBeNull();
    expect(resolveDateRange(parts({ month: 5, day_from: 0 }), TODAY)).toBeNull();
    expect(resolveDateRange(parts({ month: 5, day_from: 3.5 }), TODAY)).toBeNull();
    expect(resolveDateRange(null, TODAY)).toBeNull();
  });
});

describe('조건으로 다듬기', () => {
  it('아무것도 없는 답은 모두 null 이고 날짜 문제도 없다', () => {
    const got = resolveConditions(NONE, TODAY);
    expect(got).toEqual({
      lang: 'ko', budgetKrw: null, budgetBy: null, region: null, dateFrom: null, dateTo: null, dateProblem: false, type: null, subtype: null, qty: null, days: null,
    });
    expect(QuoteConditionsSchema.safeParse(got).success).toBe(true);
  });
  it('다 있는 답', () => {
    const got = resolveConditions(
      {
        lang: 'en', budget_raw: '3 million won', budget_krw: 3_000_000, region: '  홍대 ', date_raw: 'first week of May',
        date: parts({ month: 5, week_of_month: 1 }), type: 'ad', subtype: '전광판', qty: null, days: 14,
      },
      TODAY,
    );
    expect(got).toEqual({
      lang: 'en', budgetKrw: 3_000_000, budgetBy: 'code', region: '홍대', dateFrom: '2027-05-01', dateTo: '2027-05-07', dateProblem: false,
      type: 'ad', subtype: '전광판', qty: null, days: 14,
    });
    expect(QuoteConditionsSchema.safeParse(got).success).toBe(true);
  });
  it('날짜 표현은 있었는데 날짜로 못 바꿨으면 dateProblem 이 참이다', () => {
    expect(resolveConditions({ ...NONE, date_raw: '다음 주 금요일', date: parts({}) }, TODAY)).toMatchObject({ dateFrom: null, dateTo: null, dateProblem: true });
    expect(resolveConditions({ ...NONE, date_raw: null, date: parts({ month: 2, day_from: 30 }) }, TODAY)).toMatchObject({ dateFrom: null, dateProblem: true });
    expect(resolveConditions({ ...NONE, date_raw: '  ', date: parts({}) }, TODAY).dateProblem).toBe(false);
  });
  it('갈래는 닫힌 목록의 말일 때만, 종류와 맞을 때만 남긴다', () => {
    expect(resolveConditions({ ...NONE, type: 'ad', subtype: '전광판' }, TODAY).subtype).toBe('전광판');
    expect(resolveConditions({ ...NONE, type: null, subtype: '커피차' }, TODAY)).toMatchObject({ type: null, subtype: '커피차' });
    expect(resolveConditions({ ...NONE, type: 'ad', subtype: '커피차' }, TODAY)).toMatchObject({ type: 'ad', subtype: null });
    expect(resolveConditions({ ...NONE, type: 'ad', subtype: 'LED screen' }, TODAY).subtype).toBeNull();
  });
  it('수량과 기간은 0보다 큰 정수만 남긴다', () => {
    expect(resolveConditions({ ...NONE, qty: 200, days: 14 }, TODAY)).toMatchObject({ qty: 200, days: 14 });
    expect(resolveConditions({ ...NONE, qty: 0, days: -7 }, TODAY)).toMatchObject({ qty: null, days: null });
    expect(resolveConditions({ ...NONE, qty: 1.5, days: 2.5 }, TODAY)).toMatchObject({ qty: null, days: null });
  });
  it('빈 지역은 null 이다. 지역 글의 제어 글자는 정리한다', () => {
    expect(resolveConditions({ ...NONE, region: '   ' }, TODAY).region).toBeNull();
    expect(resolveConditions({ ...NONE, region: '강남역\n근처' }, TODAY).region).toBe('강남역 근처');
  });
  it('오늘 날짜의 꼴이 틀리면 오류', () => {
    expect(() => resolveConditions(NONE, '2026-13-01')).toThrow();
  });
});
