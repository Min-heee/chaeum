// 해마다 돌아오는 날이 "오늘 이후 처음" 언제 오는가. 해가 바뀌는 날과 윤년의 2월 29일을 본다.
import { describe, expect, it } from 'vitest';
import type { Anniversary } from '@/contract/tools/calendar';
import { isMonthDay, nextOccurrence, occurrenceIn, parseAnniversaries, TODAY_MAX, upcomingAnniversaries } from './occurrence';

describe('달·일의 꼴', () => {
  it('달력에 있는 달·일만 받는다. 2월 29일은 있는 날이다', () => {
    expect(isMonthDay(2, 29)).toBe(true);
    expect(isMonthDay(12, 31)).toBe(true);
    expect(isMonthDay(2, 30)).toBe(false);
    expect(isMonthDay(4, 31)).toBe(false);
    expect(isMonthDay(13, 1)).toBe(false);
    expect(isMonthDay(0, 10)).toBe(false);
    expect(isMonthDay(3, 1.5)).toBe(false);
  });

  it('그 해의 그 달·일을 날짜 글자로 낸다', () => {
    expect(occurrenceIn(2027, 3, 9)).toBe('2027-03-09');
    expect(occurrenceIn(2027, 12, 31)).toBe('2027-12-31');
    expect(() => occurrenceIn(2027, 4, 31)).toThrow();
    expect(() => occurrenceIn(2201, 3, 9)).toThrow();
  });
});

describe('오늘 이후 처음 오는 날', () => {
  it('올해 아직 안 지났으면 올해, 지났으면 내년이다', () => {
    expect(nextOccurrence(10, 24, '2026-10-12')).toBe('2026-10-24');
    expect(nextOccurrence(3, 9, '2026-10-12')).toBe('2027-03-09');
  });

  it('오늘이 그 날이면 오늘이다. 하루 지나면 내년이다', () => {
    expect(nextOccurrence(10, 12, '2026-10-12')).toBe('2026-10-12');
    expect(nextOccurrence(10, 12, '2026-10-13')).toBe('2027-10-12');
    expect(nextOccurrence(10, 12, '2026-10-11')).toBe('2026-10-12');
  });

  it('해가 바뀌는 날: 12월 31일과 1월 1일', () => {
    expect(nextOccurrence(1, 1, '2026-12-31')).toBe('2027-01-01');
    expect(nextOccurrence(12, 31, '2026-12-31')).toBe('2026-12-31');
    expect(nextOccurrence(12, 31, '2027-01-01')).toBe('2027-12-31');
    expect(nextOccurrence(1, 1, '2027-01-01')).toBe('2027-01-01');
  });

  it('2월 29일 기념일: 윤년에는 2월 29일, 윤년이 아닌 해에는 2월 28일로 센다', () => {
    expect(occurrenceIn(2028, 2, 29)).toBe('2028-02-29');
    expect(occurrenceIn(2027, 2, 29)).toBe('2027-02-28');
    // 2100년은 100으로 나뉘어 윤년이 아니다. 2000년은 400으로 나뉘어 윤년이다.
    expect(occurrenceIn(2100, 2, 29)).toBe('2100-02-28');
    expect(occurrenceIn(2000, 2, 29)).toBe('2000-02-29');

    expect(nextOccurrence(2, 29, '2026-10-12')).toBe('2027-02-28');
    expect(nextOccurrence(2, 29, '2027-02-28')).toBe('2027-02-28');
    // 평년의 2월 28일이 지나면 다음은 윤년의 진짜 2월 29일이다.
    expect(nextOccurrence(2, 29, '2027-03-01')).toBe('2028-02-29');
    // 윤년의 2월 28일에는 아직 하루 남았다.
    expect(nextOccurrence(2, 29, '2028-02-28')).toBe('2028-02-29');
    expect(nextOccurrence(2, 29, '2028-02-29')).toBe('2028-02-29');
    expect(nextOccurrence(2, 29, '2028-03-01')).toBe('2029-02-28');
  });

  it('2월 28일 기념일은 윤년에도 2월 28일이다', () => {
    expect(nextOccurrence(2, 28, '2028-02-01')).toBe('2028-02-28');
    expect(nextOccurrence(2, 28, '2028-02-29')).toBe('2029-02-28');
  });

  it('틀린 오늘과 달력에 없는 달·일은 받지 않는다', () => {
    expect(() => nextOccurrence(3, 9, '2027-02-29')).toThrow();
    expect(() => nextOccurrence(3, 9, '2027-3-9')).toThrow();
    expect(() => nextOccurrence(2, 30, '2027-01-01')).toThrow();
  });

  it('받을 수 있는 가장 늦은 오늘에서도 다음 해를 낼 수 있다', () => {
    expect(nextOccurrence(1, 1, TODAY_MAX)).toBe('2200-01-01');
    expect(nextOccurrence(2, 29, TODAY_MAX)).toBe('2200-02-28');
  });
});

describe('기념일 목록', () => {
  const list: Anniversary[] = [
    { id: 'ann-a', artist: '가상 그룹', kind: 'debut', month: 1, day: 5 },
    { id: 'ann-b', artist: '가상 가수', kind: 'birthday', month: 2, day: 29 },
    { id: 'ann-c', artist: '가상 가수 둘', kind: 'birthday', month: 10, day: 24 },
    { id: 'ann-d', artist: '가상 그룹 둘', kind: 'debut', month: 10, day: 24 },
  ];

  it('다음에 오는 날짜와 남은 날을 붙이고 가까운 것부터 놓는다(같은 날이면 번호 순)', () => {
    expect(upcomingAnniversaries(list, '2026-10-12').map((a) => [a.id, a.next, a.daysUntil])).toEqual([
      ['ann-c', '2026-10-24', 12],
      ['ann-d', '2026-10-24', 12],
      ['ann-a', '2027-01-05', 85],
      ['ann-b', '2027-02-28', 139],
    ]);
  });

  it('오늘이 기념일이면 남은 날이 0 이고 맨 앞이다. 하루 지나면 맨 뒤로 간다', () => {
    expect(upcomingAnniversaries(list, '2026-10-24')[0]).toMatchObject({ id: 'ann-c', next: '2026-10-24', daysUntil: 0 });
    const after = upcomingAnniversaries(list, '2026-10-25');
    expect(after[0]).toMatchObject({ id: 'ann-a', next: '2027-01-05' });
    expect(after.at(-1)).toMatchObject({ id: 'ann-d', next: '2027-10-24', daysUntil: 364 });
  });

  it('목록 파일의 꼴을 본다: 달력에 없는 날, 겹친 번호, 모르는 갈래는 받지 않는다', () => {
    expect(parseAnniversaries(list)).toEqual(list);
    expect(() => parseAnniversaries([{ id: 'ann-a', artist: '가상 가수', kind: 'birthday', month: 4, day: 31 }])).toThrow();
    expect(() => parseAnniversaries([list[0], list[0]])).toThrow();
    expect(() => parseAnniversaries([{ id: 'ann-a', artist: '가상 가수', kind: 'wedding', month: 4, day: 1 }])).toThrow();
    expect(() => parseAnniversaries([])).toThrow();
  });
});
