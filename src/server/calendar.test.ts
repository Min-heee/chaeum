// 달력의 서버 묶음과 경로에서 DB 없이 볼 수 있는 것: 오늘을 정하는 법, 기념일 고르기, 틀린 요청.
// 상품을 읽는 길은 calendar.db.test.ts 가 본다(시험용 DB 가 필요하다).
import { describe, expect, it } from 'vitest';
import { ApiErrorBodySchema, WORKSPACE_HEADER } from '@/contract/api';
import { CalendarResponseSchema, type CalendarResponse } from '@/contract/tools/calendar';
import { GET as calendarRoute } from '../../app/api/calendar/route';
import { anniversaryList, calendarFor } from './calendar';
import type { Db } from './types';

/** 읽으려 들면 시험이 깨지는 DB. 상품을 읽지 않아야 하는 길에 넘긴다. */
const NO_DB = {
  query: () => {
    throw new Error('이 길에서는 DB 를 읽지 않아야 한다');
  },
} as unknown as Db;

const WS = '11111111-2222-4333-8444-555555555555';
const NOON = new Date('2026-10-12T03:00:00Z');

async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const response = await calendarRoute(new Request(`http://chaeum.test${path}`, { headers }));
  return { status: response.status, body: await response.json() };
}

describe('오늘을 정하는 법', () => {
  it('today 를 안 주면 서버 시각의 한국 날짜다. UTC 로 하루 밀리지 않는다', async () => {
    // UTC 로는 10월 11일 15:30 이지만 한국은 10월 12일 00:30 이다.
    expect((await calendarFor(WS, {}, new Date('2026-10-11T15:30:00Z'), NO_DB)).today).toBe('2026-10-12');
    // UTC 로는 10월 12일 14:59 이고 한국은 아직 10월 12일 23:59 다.
    expect((await calendarFor(WS, {}, new Date('2026-10-12T14:59:00Z'), NO_DB)).today).toBe('2026-10-12');
    expect((await calendarFor(WS, {}, new Date('2026-12-31T15:00:00Z'), NO_DB)).today).toBe('2027-01-01');
  });

  it('today 를 주면 그 날짜로 센다(서버 시각을 보지 않는다)', async () => {
    const got = await calendarFor(WS, { today: '2027-02-28' }, NOON, NO_DB);
    expect(got.today).toBe('2027-02-28');
    expect(got.anniversaries[0]).toMatchObject({ month: 2, day: 29, next: '2027-02-28', daysUntil: 0 });
  });

  it('오늘이 2199년을 넘으면 받지 않는다(다음 해를 다룰 수 없다)', async () => {
    await expect(calendarFor(WS, { today: '2200-01-01' }, NOON, NO_DB)).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect((await calendarFor(WS, { today: '2199-12-31' }, NOON, NO_DB)).anniversaries.every((a) => a.next.startsWith('2200-') || a.next === '2199-12-31')).toBe(true);
  });
});

describe('기념일 목록만', () => {
  it('날짜도 기념일도 안 고르면 목록과 다음 날짜만 돌려주고 상품을 읽지 않는다', async () => {
    const got = await calendarFor(WS, { today: '2026-10-12' }, NOON, NO_DB);
    expect(CalendarResponseSchema.safeParse(got).success).toBe(true);
    expect(got).toMatchObject({ today: '2026-10-12', eventDate: null, anniversary: null, items: [], counts: { open: 0, closing: 0, late: 0, unknown: 0 } });
    expect(got.anniversaries).toHaveLength(anniversaryList().length);
    // 가까운 것부터다.
    const days = got.anniversaries.map((a) => a.daysUntil);
    expect(days).toEqual([...days].sort((a, b) => a - b));
    expect(got.anniversaries[0]).toMatchObject({ next: '2026-10-24', daysUntil: 12 });
  });

  it('모르는 기념일 번호는 NOT_FOUND 다(상품을 읽기 전에 안다)', async () => {
    await expect(calendarFor(WS, { anniversary: 'ann-99', today: '2026-10-12' }, NOON, NO_DB)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('GET /api/calendar', () => {
  it('주소 값이 없으면 기념일 목록만 준다(200)', async () => {
    const got = await get('/api/calendar?today=2026-10-12');
    expect(got.status).toBe(200);
    const body = CalendarResponseSchema.parse(got.body) as CalendarResponse;
    expect(body).toMatchObject({ today: '2026-10-12', eventDate: null, items: [] });
    expect(body.anniversaries.length).toBeGreaterThanOrEqual(12);
  });

  it('date 와 anniversary 를 함께 주면 400', async () => {
    const got = await get('/api/calendar?date=2027-03-09&anniversary=ann-04');
    expect(got.status).toBe(400);
    expect(ApiErrorBodySchema.parse(got.body).code).toBe('BAD_INPUT');
  });

  it('달력에 없는 날짜와 꼴이 틀린 날짜는 400', async () => {
    for (const query of ['date=2027-02-29', 'date=2027-3-9', 'today=2026-13-01', 'date=2027-03-09&today=어제', 'anniversary=ANN 01']) {
      const got = await get(`/api/calendar?${encodeURI(query)}`);
      expect([query, got.status]).toEqual([query, 400]);
    }
  });

  it('모르는 기념일은 404', async () => {
    const got = await get('/api/calendar?anniversary=ann-99');
    expect(got.status).toBe(404);
    expect(ApiErrorBodySchema.parse(got.body).code).toBe('NOT_FOUND');
  });

  it('공간 번호의 꼴이 틀리면 400', async () => {
    expect((await get('/api/calendar', { [WORKSPACE_HEADER]: 'not-a-uuid' })).status).toBe(400);
  });
});
