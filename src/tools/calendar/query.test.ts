// 화면에서 고른 값이 어떤 요청이 되는가. 보낸 주소 값은 늘 약속(CalendarQuerySchema)을 통과해야 한다.
import { describe, expect, it } from 'vitest';
import { CalendarQuerySchema } from '@/contract/tools/calendar';
import { TODAY_MAX } from './occurrence';
import { calendarPath, calendarQuery, isCounting, isUsableToday, type CalendarChoice } from './query';

const choice = (over: Partial<CalendarChoice>): CalendarChoice => ({ basis: 'anniversary', anniversaryId: null, date: '', today: '2026-10-12', ...over });

describe('오늘로 받을 수 있는 날짜', () => {
  it('달력에 있는 날짜이고 2199년까지다', () => {
    expect(isUsableToday('2026-10-12')).toBe(true);
    expect(isUsableToday(TODAY_MAX)).toBe(true);
    expect(isUsableToday('2200-01-01')).toBe(false);
    expect(isUsableToday('2027-02-29')).toBe(false);
    expect(isUsableToday('0002-03-09')).toBe(false);
    expect(isUsableToday('')).toBe(false);
    expect(isUsableToday(null)).toBe(false);
  });
});

describe('보낼 주소 값', () => {
  it('오늘을 모르거나 받을 수 없는 날짜면 보내지 않는다', () => {
    expect(calendarQuery(choice({ today: null }))).toBeNull();
    expect(calendarQuery(choice({ today: '2200-01-01', anniversaryId: 'ann-04' }))).toBeNull();
    expect(calendarQuery(choice({ today: '2026-13-01', basis: 'date', date: '2027-03-09' }))).toBeNull();
  });

  it('기념일을 골랐으면 그 번호와 오늘을 보낸다', () => {
    expect(calendarQuery(choice({ anniversaryId: 'ann-04' }))).toEqual({ anniversary: 'ann-04', today: '2026-10-12' });
  });

  it('기념일을 아직 안 골랐으면 오늘만 보낸다(기념일 목록만 받는다)', () => {
    const query = calendarQuery(choice({}));
    expect(query).toEqual({ today: '2026-10-12' });
    expect(query && isCounting(query)).toBe(false);
  });

  it('날짜를 직접 넣었으면 그 날짜와 오늘을 보낸다. 골라 둔 기념일은 싣지 않는다', () => {
    const query = calendarQuery(choice({ basis: 'date', date: '2027-03-09', anniversaryId: 'ann-04' }));
    expect(query).toEqual({ date: '2027-03-09', today: '2026-10-12' });
    expect(query && isCounting(query)).toBe(true);
  });

  it('날짜가 비었거나 달력에 없으면 오늘만 보낸다(지어낸 날짜로 세지 않는다)', () => {
    for (const date of ['', '2027-02-29', '2027-3-9', '0002-03-09', '2201-01-01']) {
      expect([date, calendarQuery(choice({ basis: 'date', date, anniversaryId: 'ann-04' }))]).toEqual([date, { today: '2026-10-12' }]);
    }
  });

  it('기념일로 세는 동안에는 넣어 둔 날짜를 싣지 않는다', () => {
    expect(calendarQuery(choice({ basis: 'anniversary', anniversaryId: 'ann-03', date: '2027-03-09' }))).toEqual({ anniversary: 'ann-03', today: '2026-10-12' });
  });

  it('어떤 고르기에서 나온 주소 값도 약속을 통과한다(date 와 anniversary 가 함께 가지 않는다)', () => {
    const choices: CalendarChoice[] = [];
    for (const basis of ['anniversary', 'date'] as const) {
      for (const anniversaryId of [null, 'ann-01']) {
        for (const date of ['', '2028-02-29', '2027-02-29']) {
          for (const today of ['2026-10-12', '2028-02-29', TODAY_MAX]) choices.push({ basis, anniversaryId, date, today });
        }
      }
    }
    for (const c of choices) {
      const query = calendarQuery(c);
      expect(query).not.toBeNull();
      expect(CalendarQuerySchema.safeParse(query).success).toBe(true);
      expect(Boolean(query?.date && query.anniversary)).toBe(false);
    }
  });
});

describe('주소', () => {
  it('주소 값을 늘 같은 순서로 적는다', () => {
    expect(calendarPath({ today: '2026-10-12' })).toBe('/api/calendar?today=2026-10-12');
    expect(calendarPath({ today: '2026-10-12', anniversary: 'ann-04' })).toBe('/api/calendar?anniversary=ann-04&today=2026-10-12');
    expect(calendarPath({ today: '2026-10-12', date: '2027-03-09' })).toBe('/api/calendar?date=2027-03-09&today=2026-10-12');
    expect(calendarPath({})).toBe('/api/calendar');
  });

  it('적은 주소를 다시 읽으면 같은 주소 값이다', () => {
    const query = { date: '2027-03-09', today: '2026-10-12' };
    const params = new URL(calendarPath(query), 'http://chaeum.test').searchParams;
    expect(CalendarQuerySchema.parse(Object.fromEntries(params))).toEqual(query);
  });
});
