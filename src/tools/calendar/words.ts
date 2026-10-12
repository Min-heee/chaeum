// 날짜와 남은 날을 사람이 읽는 말로 적는다. 화면이 쓴다. 순수 함수다(브라우저의 날짜 서식에 기대지 않아 어디서나 같은 글자가 나온다).
import { dayNumber } from '@/tools/shared/deadline';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;

/** 요일 한 글자. 1970-01-01 이 목요일이라는 데서 센다. */
export function weekdayOf(date: string): string {
  const index = (((dayNumber(date) + 4) % 7) + 7) % 7;
  return WEEKDAYS[index] as string;
}

/** '2027-03-09' → '2027년 3월 9일(화)' */
export function dateText(date: string): string {
  const weekday = weekdayOf(date);
  const [year, month, day] = date.split('-').map(Number);
  return `${year}년 ${month}월 ${day}일(${weekday})`;
}

export function monthDayText(month: number, day: number): string {
  return `${month}월 ${day}일`;
}

/** 남은 날을 말로. 마감 당일은 "오늘까지"(아직 된다), 지났으면 "○일 지남". */
export function daysLeftText(daysLeft: number): string {
  if (daysLeft === 0) return '오늘까지';
  return daysLeft > 0 ? `${daysLeft}일 남음` : `${-daysLeft}일 지남`;
}

/** 오늘부터 그 날까지를 말로. */
export function daysUntilText(days: number): string {
  if (days === 0) return '오늘';
  return days > 0 ? `${days}일 뒤` : `${-days}일 전`;
}
