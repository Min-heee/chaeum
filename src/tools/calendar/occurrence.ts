// 해마다 돌아오는 기념일(달·일)이 오늘 이후 처음 오는 날짜를 낸다.
// 순수 함수다. 지금 시각을 읽지 않는다. 오늘은 'YYYY-MM-DD'(한국 날짜)로 받는다.
// 날짜는 글자와 정수 일수로만 다룬다. 빼기는 src/tools/shared/deadline.ts 의 것을 쓴다(따로 세지 않는다).
import { AnniversaryFileSchema, type Anniversary, type CalendarResponse } from '@/contract/tools/calendar';
import { isRealDate } from '@/contract/tools/dates';
import { diffDays } from '@/tools/shared/deadline';

/**
 * 받을 수 있는 가장 늦은 오늘. 날짜의 약속(IsoDateSchema)은 2200년까지인데,
 * 오늘이 2200년이면 "다음에 오는 그 날"이 2201년이 되어 다룰 수 없다. 그래서 한 해 앞에서 끊는다.
 */
export const TODAY_MAX = '2199-12-31';

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** 달·일이 달력에 있는 짝인가. 2월 29일은 있는 날이다(윤년에 온다). 4월 31일, 13월 1일은 없다. */
export function isMonthDay(month: number, day: number): boolean {
  // 2000년은 윤년이다. 그 해에 있는 날이면 달력에 있는 달·일이다.
  return isRealDate(`2000-${pad(month, 2)}-${pad(day, 2)}`);
}

/**
 * 그 해의 그 달·일을 'YYYY-MM-DD' 로.
 * 2월 29일은 윤년이 아닌 해에는 2월 28일로 센다(그 해에 없는 날을 3월 1일로 넘기지 않는다. 2월 안에서 챙긴다).
 */
export function occurrenceIn(year: number, month: number, day: number): string {
  if (!isMonthDay(month, day)) throw new Error(`달력에 없는 달·일이다: ${month}월 ${day}일`);
  const exact = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
  if (isRealDate(exact)) return exact;
  const feb28 = `${pad(year, 4)}-02-28`;
  if (month === 2 && day === 29 && isRealDate(feb28)) return feb28;
  throw new Error(`다룰 수 없는 해다: ${year}`);
}

/** 오늘 이후(오늘 포함) 처음 오는 그 달·일. 오늘이 그 날이면 오늘이다. */
export function nextOccurrence(month: number, day: number, today: string): string {
  if (!isRealDate(today)) throw new Error(`날짜의 꼴이 틀렸다: ${today}`);
  const year = Number(today.slice(0, 4));
  const thisYear = occurrenceIn(year, month, day);
  return diffDays(today, thisYear) >= 0 ? thisYear : occurrenceIn(year + 1, month, day);
}

export type UpcomingAnniversary = CalendarResponse['anniversaries'][number];

/** 기념일마다 다음에 오는 날짜와 그때까지 남은 날을 붙인다. 가까운 것부터(같은 날이면 번호 순). */
export function upcomingAnniversaries(list: readonly Anniversary[], today: string): UpcomingAnniversary[] {
  return list
    .map((a) => {
      const next = nextOccurrence(a.month, a.day, today);
      return { ...a, next, daysUntil: diffDays(today, next) };
    })
    .sort((a, b) => a.daysUntil - b.daysUntil || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 기념일 목록 파일(data/seed/anniversaries.json)을 읽는다. 꼴이 틀리거나, 달력에 없는 날이거나, 번호가 겹치면 여기서 멈춘다. */
export function parseAnniversaries(raw: unknown): Anniversary[] {
  const list = AnniversaryFileSchema.parse(raw);
  const seen = new Set<string>();
  for (const a of list) {
    if (!isMonthDay(a.month, a.day)) throw new Error(`기념일 목록에 달력에 없는 날이 있다: ${a.id}`);
    if (seen.has(a.id)) throw new Error(`기념일 번호가 겹친다: ${a.id}`);
    seen.add(a.id);
  }
  return list;
}
