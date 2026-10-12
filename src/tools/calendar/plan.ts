// 기념일 날짜와 오늘로 상품(지면)마다 마감을 거꾸로 센다.
// 순수 함수다. 마감 일수는 본체가 채운 칸(상품의 spec)에서 그대로 읽고, 세는 일은 src/tools/shared/deadline.ts 가 한다(견적과 같은 함수).
//
// 기준일을 정하는 규칙(가장 단순한 것 하나):
//   기준일 = 기념일 당일.
//   - 광고 지면: 기념일에 게재를 시작한다고 본다. 기간 옵션이 7일이든 30일이든 시작일은 기념일이다.
//     그러면 기념일이 게재 기간의 첫날로 들어가고, 이때의 마감이 "늦어도 이 날까지"다.
//     기념일보다 앞서 시작하려면(그 주의 월요일부터 등) 시작하려는 날을 기준일로 넣어 센다. 앞당긴 날 수만큼 마감도 앞당겨진다.
//   - 케이터링: 기념일이 행사일이다.   - 굿즈: 기념일까지 다 만들어져야 한다(제작 기간만 센다. 배송에 걸리는 날은 칸이 없어 세지 않는다).
//   휴일과 영업일은 따지지 않는다. 달력 날짜로만 센다.
import type { CalendarItem, CalendarItemStatus, CalendarProduct, CalendarResponse } from '@/contract/tools/calendar';
import { DEADLINE_STATUS_LABELS } from '@/contract/tools/dates';
import { addDays, countableSpec, countDeadlines, worstStatus } from '@/tools/shared/deadline';

export const CALENDAR_STATUS_LABELS: Record<CalendarItemStatus, string> = { ...DEADLINE_STATUS_LABELS, unknown: '마감 일수 없음' };

/**
 * 상품 하나의 마감을 센다.
 * - status: 센 마감 가운데 가장 급한 것. 센 마감이 하나도 없으면 unknown.
 * - daysLeft: 가장 이른 마감까지 남은 날(마감 당일 0, 지났으면 음수). 세지 못했으면 null.
 */
export function planItem(product: CalendarProduct, eventDate: string, today: string): CalendarItem {
  const { deadlines, missing } = countDeadlines(product.type, countableSpec(product.type, product.spec, eventDate), eventDate, today);
  return {
    productId: product.id,
    name: product.name,
    type: product.type,
    subtype: product.subtype,
    deadlines,
    missing,
    status: worstStatus(deadlines) ?? 'unknown',
    // deadlines 는 마감일이 이른 것부터다.
    daysLeft: deadlines[0]?.daysLeft ?? null,
  };
}

const byId = (a: CalendarItem, b: CalendarItem) => a.productId - b.productId;

const URGENT_FIRST: Record<CalendarItemStatus, number> = { late: 0, closing: 1, open: 2, unknown: 3 };

/** 상품 목록 전체를 세고 급한 순서로 놓는다(late, closing, open, unknown). 같으면 남은 날이 적은 것부터, 그것도 같으면 번호 순. */
export function planCalendar(products: readonly CalendarProduct[], eventDate: string, today: string): Pick<CalendarResponse, 'items' | 'counts'> {
  const items = products
    .map((p) => planItem(p, eventDate, today))
    .sort((a, b) => URGENT_FIRST[a.status] - URGENT_FIRST[b.status] || (a.daysLeft ?? 0) - (b.daysLeft ?? 0) || byId(a, b));
  const counts: Record<CalendarItemStatus, number> = { open: 0, closing: 0, late: 0, unknown: 0 };
  for (const item of items) counts[item.status] += 1;
  return { items, counts };
}

/**
 * 화면의 순서: 되는 것 먼저.
 * 1) 아직 되는 것(곧 마감, 아직 됨)을 마감이 가까운 것부터  2) 이미 늦은 것을 방금 놓친 것부터  3) 일수가 없어 세지 못한 것.
 */
export function doableFirst(items: readonly CalendarItem[]): CalendarItem[] {
  const group = (item: CalendarItem) => (item.status === 'unknown' ? 2 : item.status === 'late' ? 1 : 0);
  return [...items].sort((a, b) => {
    const ga = group(a);
    if (ga !== group(b)) return ga - group(b);
    const byDays = (a.daysLeft ?? 0) - (b.daysLeft ?? 0);
    return (ga === 1 ? -byDays : byDays) || byId(a, b);
  });
}

/** 시작일부터 days 일 동안 걸리는 게재의 마지막 날. 7일 옵션이면 시작일 + 6일이다. */
export function lastDayOfRun(startDate: string, days: number): string {
  if (!Number.isInteger(days) || days < 1) throw new Error(`게재 일수가 틀렸다: ${days}`);
  return addDays(startDate, days - 1);
}
