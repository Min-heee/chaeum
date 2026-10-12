// 기념일 목록 파일(data/seed/anniversaries.json)이 약속한 꼴인지 본다. 이름은 전부 지어낸 것이다.
import { describe, expect, it } from 'vitest';
import { ANNIVERSARY_KINDS } from '@/contract/tools/calendar';
import anniversariesJson from '../../../data/seed/anniversaries.json';
import { parseAnniversaries, upcomingAnniversaries } from './occurrence';

const list = parseAnniversaries(anniversariesJson);

describe('기념일 목록 파일', () => {
  it('꼴이 맞고 번호가 겹치지 않는다', () => {
    expect(new Set(list.map((a) => a.id)).size).toBe(list.length);
  });

  it('가수·그룹은 12~15팀이고 생일과 데뷔일이 모두 있다', () => {
    const teams = new Set(list.map((a) => a.artist));
    expect(teams.size).toBeGreaterThanOrEqual(12);
    expect(teams.size).toBeLessThanOrEqual(15);
    for (const kind of ANNIVERSARY_KINDS) expect(list.some((a) => a.kind === kind)).toBe(true);
  });

  it('같은 가수의 같은 갈래가 두 줄이 아니다(생일이 둘일 수 없다)', () => {
    const keys = list.map((a) => `${a.artist}/${a.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('날짜가 한 해에 고르게 있다: 달마다 하나 이상', () => {
    const months = new Set(list.map((a) => a.month));
    expect([...months].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('2월 29일 기념일이 하나 들어 있다(평년에 2월 28일로 세는 보기)', () => {
    expect(list.filter((a) => a.month === 2 && a.day === 29)).toHaveLength(1);
  });

  it('어느 오늘에서 세어도 모든 줄의 다음 날짜가 한 해 안에 온다', () => {
    for (const today of ['2026-10-12', '2027-02-28', '2028-02-29', '2028-12-31']) {
      const upcoming = upcomingAnniversaries(list, today);
      expect(upcoming).toHaveLength(list.length);
      expect(upcoming.every((a) => a.daysUntil >= 0 && a.daysUntil <= 365)).toBe(true);
    }
  });
});
