// 달력의 DB 일. 그 공간의 상품을 읽기만 한다(쓰지 않는다, 모델을 부르지 않는다).
// 날짜 세기는 src/tools/calendar 의 순수 함수가 한다. 여기서는 오늘을 정하고, 기념일을 고르고, 상품을 읽어 넘긴다.
import anniversariesJson from '../../data/seed/anniversaries.json';
import { kstDay } from '@/contract/api';
import type { Anniversary, CalendarQuery, CalendarResponse } from '@/contract/tools/calendar';
import { nextOccurrence, parseAnniversaries, planCalendar, TODAY_MAX, upcomingAnniversaries } from '@/tools/calendar';
import { getPool } from './db';
import { AppError } from './errors';
import { listProducts } from './repos/products';
import type { Db } from './types';

let cached: Anniversary[] | null = null;

/** 기념일 목록(data/seed/anniversaries.json). 가수와 그룹 이름은 전부 지어낸 것이다. 꼴이 틀리면 여기서 멈춘다. */
export function anniversaryList(): Anniversary[] {
  cached ??= parseAnniversaries(anniversariesJson);
  return cached;
}

/**
 * GET /api/calendar 의 응답을 만든다.
 * - 오늘: 주소 값의 today, 없으면 서버 시각의 한국 날짜.
 * - 기준일: 주소 값의 date, 또는 고른 기념일이 오늘 이후 처음 오는 날. 둘 다 없으면 기념일 목록만 돌려준다(상품을 읽지 않는다).
 * - 모르는 기념일 번호면 NOT_FOUND. 오늘이 2199년을 넘으면 BAD_INPUT(다음 해를 다룰 수 없다).
 * db 를 주면 그 연결(열어 둔 트랜잭션)로 읽는다. 안 주면 풀에서 읽는다.
 */
export async function calendarFor(workspaceId: string, query: CalendarQuery, now: Date, db?: Db): Promise<CalendarResponse> {
  const today = query.today ?? kstDay(now);
  if (today > TODAY_MAX) throw new AppError('BAD_INPUT', '오늘 날짜는 2199년까지만 받습니다.');

  const all = anniversaryList();
  const anniversary = query.anniversary ? (all.find((a) => a.id === query.anniversary) ?? null) : null;
  if (query.anniversary && !anniversary) throw new AppError('NOT_FOUND', '그런 기념일이 없습니다.');

  const eventDate = query.date ?? (anniversary ? nextOccurrence(anniversary.month, anniversary.day, today) : null);
  const anniversaries = upcomingAnniversaries(all, today);
  if (eventDate === null) {
    return { today, eventDate: null, anniversary: null, anniversaries, items: [], counts: { open: 0, closing: 0, late: 0, unknown: 0 } };
  }
  const products = await listProducts(db ?? getPool(), workspaceId);
  return { today, eventDate, anniversary, anniversaries, ...planCalendar(products, eventDate, today) };
}
