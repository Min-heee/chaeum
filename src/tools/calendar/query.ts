// 화면에서 고른 값 → GET /api/calendar 에 보낼 주소 값. 순수 함수다(오늘은 인자로 받는다).
// 화면은 여기서 정한 대로 보내기만 한다. 주소 값의 약속은 src/contract/tools/calendar.ts 의 CalendarQuerySchema 다.
import type { CalendarQuery } from '@/contract/tools/calendar';
import { isRealDate } from '@/contract/tools/dates';
import { TODAY_MAX } from './occurrence';

/** 기준일을 무엇으로 정하나: 기념일 목록에서 고르기, 날짜 직접 넣기 */
export type CalendarBasis = 'anniversary' | 'date';

export interface CalendarChoice {
  basis: CalendarBasis;
  /** 고른 기념일의 번호. 아직 안 골랐으면 null */
  anniversaryId: string | null;
  /** 직접 넣은 날짜. 안 넣었으면 빈 글자 */
  date: string;
  /** 오늘. 아직 모르면 null */
  today: string | null;
}

/** 오늘로 받을 수 있는 날짜인가. 달력에 있는 날짜이고 TODAY_MAX 를 넘지 않아야 한다. */
export function isUsableToday(today: string | null): today is string {
  return today !== null && isRealDate(today) && today <= TODAY_MAX;
}

/**
 * 보낼 주소 값을 정한다.
 * - 오늘을 모르거나 받을 수 없는 날짜면 null(보내지 않는다).
 * - 기준일이 정해졌으면 date 나 anniversary 가운데 하나만 싣는다(둘 다 실으면 서버가 400 을 낸다).
 * - 기준일을 아직 못 정했으면(기념일을 안 골랐다, 날짜가 비었거나 달력에 없다) today 만 싣는다. 그러면 서버가 기념일 목록만 돌려준다.
 */
export function calendarQuery(choice: CalendarChoice): CalendarQuery | null {
  if (!isUsableToday(choice.today)) return null;
  const today = choice.today;
  if (choice.basis === 'date') return isRealDate(choice.date) ? { date: choice.date, today } : { today };
  return choice.anniversaryId ? { anniversary: choice.anniversaryId, today } : { today };
}

/** 주소 값이 마감을 세는 요청인가(기준일이 실려 있나). 아니면 기념일 목록만 받는 요청이다. */
export function isCounting(query: CalendarQuery): boolean {
  return query.date !== undefined || query.anniversary !== undefined;
}

/** 주소 값을 주소로. 늘 같은 순서(date, anniversary, today)로 적어서 같은 요청이면 같은 글자가 된다. */
export function calendarPath(query: CalendarQuery): string {
  const params = new URLSearchParams();
  if (query.date !== undefined) params.set('date', query.date);
  if (query.anniversary !== undefined) params.set('anniversary', query.anniversary);
  if (query.today !== undefined) params.set('today', query.today);
  const text = params.toString();
  return text === '' ? '/api/calendar' : `/api/calendar?${text}`;
}
