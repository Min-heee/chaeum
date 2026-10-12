// 날짜 세기. 견적과 달력이 함께 쓴다(같은 판단을 두 군데서 하지 않는다).
// 순수 함수다. 지금 시각을 읽지 않는다. 오늘은 'YYYY-MM-DD'(한국 날짜)로 받는다.
// 날짜는 시각 없는 달력 날짜로만 다룬다. 안에서는 UTC 자정의 날 번호로 바꿔 더하고 뺀다(시간대와 서머타임이 끼어들지 않는다).
import { DEADLINE_FIELDS, DEADLINE_RULES, isRealDate, type Deadline, type DeadlineKind, type DeadlineStatus } from '@/contract/tools/dates';
import type { FieldKey, ProductType } from '@/contract/fields';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' → 1970-01-01 부터의 날 수. 달력에 없는 날짜면 오류. */
export function dayNumber(date: string): number {
  if (!isRealDate(date)) throw new Error(`날짜의 꼴이 틀렸다: ${date}`);
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

/** 날 수 → 'YYYY-MM-DD'. */
export function dateOfDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** 날짜에 days 일을 더한다(음수면 뺀다). 달과 해가 바뀌는 것, 윤년의 2월 29일이 그대로 맞는다. */
export function addDays(date: string, days: number): string {
  if (!Number.isInteger(days)) throw new Error('더할 날 수는 정수여야 한다');
  return dateOfDayNumber(dayNumber(date) + days);
}

/** to − from (일). to 가 앞이면 음수. */
export function diffDays(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** 남은 날로 상태를 정한다. 음수면 이미 늦음, 0 ~ closingWithinDays 면 곧 마감(마감 당일 포함), 그보다 많으면 아직 됨. */
export function deadlineStatus(daysLeft: number): DeadlineStatus {
  if (daysLeft < 0) return 'late';
  return daysLeft <= DEADLINE_RULES.closingWithinDays ? 'closing' : 'open';
}

/**
 * 마감 하나를 센다. 마감일 = 기준일 − days, 남은 날 = 마감일 − 오늘.
 * days 는 상품에 적힌 "며칠 전까지"다. 0 이면 기준일 당일이 마감이다. 음수나 정수가 아닌 값은 오류(그런 값은 상품이 될 수 없다).
 */
export function countDeadline(kind: DeadlineKind, field: string, days: number, eventDate: string, today: string): Deadline {
  if (!Number.isInteger(days) || days < 0) throw new Error(`마감 일수가 틀렸다: ${days}`);
  const date = addDays(eventDate, -days);
  const daysLeft = diffDays(today, date);
  return { kind, field, days, date, daysLeft, status: deadlineStatus(daysLeft) };
}

/**
 * 상품의 규격 칸에서 그 종류의 마감을 모두 센다.
 * - deadlines: 일수가 적힌 마감만. 마감일이 이른 것부터(같으면 DEADLINE_FIELDS 의 순서).
 * - missing: 일수가 비었거나 0 이상의 정수가 아니라 세지 못한 마감의 갈래.
 */
export function countDeadlines(
  type: ProductType,
  spec: Record<string, unknown>,
  eventDate: string,
  today: string,
): { deadlines: Deadline[]; missing: DeadlineKind[] } {
  const deadlines: Deadline[] = [];
  const missing: DeadlineKind[] = [];
  for (const { kind, field } of DEADLINE_FIELDS[type] as readonly { kind: DeadlineKind; field: FieldKey }[]) {
    const days = spec[field];
    if (typeof days === 'number' && Number.isInteger(days) && days >= 0) deadlines.push(countDeadline(kind, field, days, eventDate, today));
    else missing.push(kind);
  }
  deadlines.sort((a, b) => dayNumber(a.date) - dayNumber(b.date));
  return { deadlines, missing };
}

/** 다룰 수 있는 가장 이른 날짜(날짜의 약속 IsoDateSchema 의 아래 끝). */
export const EARLIEST_DATE = '1900-01-01';

/**
 * 마감일이 다룰 수 있는 날짜 앞으로 나가는 일수 칸을 뺀다(10만 일 같은 값, 1900년 초의 기준일). 뺀 마감은 "세지 못함"(missing)이 된다.
 * 이런 상품이나 날짜 하나 때문에 달력과 견적이 오류로 죽지 않게 하려는 것이다. 달력과 견적이 같이 쓴다.
 */
export function countableSpec(type: ProductType, spec: Record<string, unknown>, eventDate: string): Record<string, unknown> {
  const room = dayNumber(eventDate) - dayNumber(EARLIEST_DATE);
  const out = { ...spec };
  for (const { field } of DEADLINE_FIELDS[type] as readonly { field: FieldKey }[]) {
    const days = out[field];
    if (typeof days === 'number' && days > room) delete out[field];
  }
  return out;
}

/** 여러 마감 가운데 가장 급한 상태(late > closing > open). 마감이 없으면 null. */
export function worstStatus(deadlines: readonly Pick<Deadline, 'status'>[]): DeadlineStatus | null {
  if (deadlines.length === 0) return null;
  if (deadlines.some((d) => d.status === 'late')) return 'late';
  return deadlines.some((d) => d.status === 'closing') ? 'closing' : 'open';
}
