// 날짜와 남은 날을 말로 적기. 요일은 알려진 날 셋으로 맞춰 본다.
import { describe, expect, it } from 'vitest';
import { dateText, daysLeftText, daysUntilText, monthDayText, weekdayOf } from './words';

describe('요일', () => {
  it('알려진 날의 요일과 같다', () => {
    expect(weekdayOf('1970-01-01')).toBe('목');
    expect(weekdayOf('2000-01-01')).toBe('토');
    expect(weekdayOf('2026-10-12')).toBe('월');
  });

  it('1970년보다 앞선 날도 맞는다', () => {
    expect(weekdayOf('1969-12-31')).toBe('수');
    expect(weekdayOf('1969-12-28')).toBe('일');
  });

  it('이레가 지나면 같은 요일이다. 윤년의 2월 29일을 건너도 그렇다', () => {
    expect(weekdayOf('2026-10-19')).toBe('월');
    expect(weekdayOf('2028-02-28')).toBe(weekdayOf('2028-03-06'));
    expect(weekdayOf('2028-02-29')).toBe('화');
  });

  it('달력에 없는 날짜는 받지 않는다', () => {
    expect(() => weekdayOf('2027-02-29')).toThrow();
  });
});

describe('말로 적기', () => {
  it('날짜는 년·월·일과 요일로, 앞의 0 없이', () => {
    expect(dateText('2026-10-12')).toBe('2026년 10월 12일(월)');
    expect(dateText('2027-03-09')).toBe('2027년 3월 9일(화)');
    expect(monthDayText(2, 29)).toBe('2월 29일');
  });

  it('남은 날: 마감 당일은 "오늘까지", 지났으면 "○일 지남"', () => {
    expect(daysLeftText(0)).toBe('오늘까지');
    expect(daysLeftText(1)).toBe('1일 남음');
    expect(daysLeftText(134)).toBe('134일 남음');
    expect(daysLeftText(-1)).toBe('1일 지남');
  });

  it('그 날까지: 오늘, ○일 뒤, ○일 전', () => {
    expect(daysUntilText(0)).toBe('오늘');
    expect(daysUntilText(12)).toBe('12일 뒤');
    expect(daysUntilText(-3)).toBe('3일 전');
  });
});
