// 날짜 세기의 경계: 마감 당일, 달과 해가 바뀌는 날, 윤년.
import { describe, expect, it } from 'vitest';
import { IsoDateSchema, isRealDate } from '@/contract/tools/dates';
import { addDays, countDeadline, countDeadlines, dateOfDayNumber, dayNumber, deadlineStatus, diffDays, worstStatus, countableSpec, EARLIEST_DATE } from './deadline';

describe('날짜의 꼴', () => {
  it('달력에 있는 날짜만 받는다', () => {
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2027-02-29')).toBe(false);
    expect(isRealDate('2027-02-30')).toBe(false);
    expect(isRealDate('2027-13-01')).toBe(false);
    expect(isRealDate('2027-1-5')).toBe(false);
    expect(IsoDateSchema.safeParse('2027-04-31').success).toBe(false);
    expect(IsoDateSchema.safeParse('2027-04-30').success).toBe(true);
  });

  it('날 번호와 날짜가 서로 돌아온다', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dateOfDayNumber(dayNumber('2026-10-12'))).toBe('2026-10-12');
    expect(() => dayNumber('2027-02-29')).toThrow();
  });
});

describe('더하기와 빼기', () => {
  it('달이 바뀌는 날', () => {
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
    expect(addDays('2027-01-31', 1)).toBe('2027-02-01');
    expect(addDays('2027-05-03', -7)).toBe('2027-04-26');
  });

  it('해가 바뀌는 날', () => {
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08');
  });

  it('윤년: 2028년 2월은 29일까지다', () => {
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(diffDays('2028-02-01', '2028-03-01')).toBe(29);
    expect(diffDays('2027-02-01', '2027-03-01')).toBe(28);
    expect(diffDays('2028-01-01', '2029-01-01')).toBe(366);
  });

  it('앞선 날짜까지는 음수다', () => {
    expect(diffDays('2027-03-10', '2027-03-09')).toBe(-1);
    expect(diffDays('2027-03-10', '2027-03-10')).toBe(0);
  });

  it('정수가 아닌 날 수는 받지 않는다', () => {
    expect(() => addDays('2027-03-10', 1.5)).toThrow();
  });
});

describe('마감 세기', () => {
  it('마감일 = 기준일 − 일수, 남은 날 = 마감일 − 오늘', () => {
    expect(countDeadline('booking', 'booking_deadline_days', 14, '2027-05-03', '2027-04-01')).toEqual({
      kind: 'booking', field: 'booking_deadline_days', days: 14, date: '2027-04-19', daysLeft: 18, status: 'open',
    });
  });

  it('마감 당일은 아직 된다(곧 마감). 하루 지나면 이미 늦음', () => {
    expect(countDeadline('material', 'material_deadline_days', 7, '2027-05-03', '2027-04-26')).toMatchObject({ date: '2027-04-26', daysLeft: 0, status: 'closing' });
    expect(countDeadline('material', 'material_deadline_days', 7, '2027-05-03', '2027-04-27')).toMatchObject({ daysLeft: -1, status: 'late' });
  });

  it('남은 날이 3일까지는 곧 마감, 4일부터는 아직 됨', () => {
    expect(deadlineStatus(3)).toBe('closing');
    expect(deadlineStatus(4)).toBe('open');
    expect(deadlineStatus(0)).toBe('closing');
    expect(deadlineStatus(-1)).toBe('late');
  });

  it('일수 0 은 기준일 당일이 마감이다. 음수와 소수는 받지 않는다', () => {
    expect(countDeadline('design', 'design_deadline_days', 0, '2027-05-03', '2027-05-03')).toMatchObject({ date: '2027-05-03', daysLeft: 0, status: 'closing' });
    expect(() => countDeadline('design', 'design_deadline_days', -1, '2027-05-03', '2027-05-01')).toThrow();
    expect(() => countDeadline('design', 'design_deadline_days', 2.5, '2027-05-03', '2027-05-01')).toThrow();
  });

  it('윤년의 2월 29일을 건너 센다', () => {
    expect(countDeadline('booking', 'booking_deadline_days', 10, '2028-03-05', '2028-02-20')).toMatchObject({ date: '2028-02-24', daysLeft: 4 });
    expect(countDeadline('booking', 'booking_deadline_days', 10, '2027-03-05', '2027-02-20')).toMatchObject({ date: '2027-02-23', daysLeft: 3 });
  });
});

describe('상품의 마감 모두 세기', () => {
  it('광고 지면은 예약 마감과 소재 마감을 센다. 이른 것부터', () => {
    const got = countDeadlines('ad', { booking_deadline_days: 14, material_deadline_days: 7, region: '합정역' }, '2027-05-03', '2027-04-20');
    expect(got.missing).toEqual([]);
    expect(got.deadlines.map((d) => [d.kind, d.date, d.status])).toEqual([
      ['booking', '2027-04-19', 'late'],
      ['material', '2027-04-26', 'open'],
    ]);
    expect(worstStatus(got.deadlines)).toBe('late');
  });

  it('일수가 빈 마감은 세지 않고 빠진 것으로 알린다', () => {
    const got = countDeadlines('ad', { material_deadline_days: 5 }, '2027-05-03', '2027-04-26');
    expect(got.missing).toEqual(['booking']);
    expect(got.deadlines).toHaveLength(1);
    expect(worstStatus(got.deadlines)).toBe('closing');
  });

  it('케이터링은 시안 마감, 굿즈는 제작 기간만큼 앞선 주문 마감', () => {
    expect(countDeadlines('catering', { design_deadline_days: 3 }, '2027-05-03', '2027-04-01').deadlines[0]).toMatchObject({ kind: 'design', date: '2027-04-30' });
    expect(countDeadlines('goods', { lead_time_days: 10 }, '2027-05-03', '2027-04-01').deadlines[0]).toMatchObject({ kind: 'order', date: '2027-04-23' });
    expect(countDeadlines('goods', {}, '2027-05-03', '2027-04-01')).toEqual({ deadlines: [], missing: ['order'] });
    expect(worstStatus([])).toBeNull();
  });
});

describe('셀 수 있는 마감만 남기기(달력과 견적이 같이 쓴다)', () => {
  it('마감일이 다룰 수 있는 가장 이른 날짜 앞으로 나가는 일수 칸은 뺀다. 경계의 값은 남긴다', () => {
    // 1900-01-08 은 가장 이른 날짜에서 7일 뒤다. 7일 전 마감은 꼭 그 날이라 셀 수 있고, 8일 전은 셀 수 없다.
    const spec = { booking_deadline_days: 7, material_deadline_days: 8, region: '합정역' };
    expect(countableSpec('ad', spec, '1900-01-08')).toEqual({ booking_deadline_days: 7, region: '합정역' });
    expect(countableSpec('ad', spec, EARLIEST_DATE)).toEqual({ region: '합정역' });
    // 받은 것을 고치지 않는다. 보통의 날짜에서는 그대로다.
    expect(spec).toEqual({ booking_deadline_days: 7, material_deadline_days: 8, region: '합정역' });
    expect(countableSpec('ad', spec, '2027-05-01')).toEqual(spec);
  });
  it('뺀 뒤에는 1900년 초의 기준일로도 오류 없이 센다(뺀 마감은 "세지 못함"이다)', () => {
    const spec = { booking_deadline_days: 7, material_deadline_days: 14 };
    const got = countDeadlines('ad', countableSpec('ad', spec, '1900-01-08'), '1900-01-08', '2026-10-12');
    expect(got.deadlines.map((d) => [d.kind, d.date, d.status])).toEqual([['booking', '1900-01-01', 'late']]);
    expect(got.missing).toEqual(['material']);
    // 빼지 않으면 날짜 함수가 받지 않는다.
    expect(() => countDeadlines('ad', spec, '1900-01-08', '2026-10-12')).toThrow();
  });
});
