// 날짜 수 맞추기. "2주 전까지" → 14. 1주 = 7일, 1개월 = 30일.
import type { NormalizeResult } from '@/contract/core-api';
import type { ReasonCode } from '@/contract/reasons';
import { asInt, plain, read, unread } from '../text';

/** 기간 하나를 찾는 꼴. 기간 옵션 맞추기도 함께 쓴다. */
export const DURATION = String.raw`(\d+(?:\.\d+)?)\s*(영업일|주일|주간|주|일간|일|개월|달|시간|weeks?|wks?|days?|months?|hours?|hrs?|周|天|个月|小时)(?![a-z])|일주일|한\s*달|보름|하루`;

const WORD_DAYS: Record<string, number> = { 일주일: 7, 보름: 15, 하루: 1 };

/**
 * 찾은 기간 하나를 일수로 바꾼다.
 * approx: 정확한 환산이 아니다(1개월 = 30일, 시간 → 일).
 */
export function durationToDays(m: RegExpMatchArray): { days: number; approx: boolean } | null {
  if (m[1] === undefined) {
    const word = m[0].replace(/\s+/g, '');
    if (word === '한달') return { days: 30, approx: true };
    const days = WORD_DAYS[word];
    return days === undefined ? null : { days, approx: false };
  }
  const n = Number(m[1]);
  const unit = m[2]!;
  let days: number;
  let approx = false;
  if (/^(주일|주간|주|weeks?|wks?|周)$/.test(unit)) days = n * 7;
  else if (/^(개월|달|months?|个月)$/.test(unit)) [days, approx] = [n * 30, true];
  else if (/^(시간|hours?|hrs?|小时)$/.test(unit)) [days, approx] = [n / 24, true];
  else days = n;
  const whole = asInt(days);
  return whole === null ? null : { days: whole, approx };
}

/**
 * "2주 전", "10일", "D-7" → 일수.
 * 기간이 둘이거나 다른 숫자가 섞이면("7~10일", "10월 10일") 못 읽은 것으로 둔다.
 */
export function normalizeDays(raw: string): NormalizeResult<number> {
  const t = plain(raw);
  const dday = /^[^\d]*d\s*-\s*(\d+)[^\d]*$/.exec(t);
  if (dday) return read(Number(dday[1]));

  const found = [...t.matchAll(new RegExp(DURATION, 'g'))];
  if (found.length !== 1) return unread();
  if (/\d/.test(t.replace(found[0]![0], ''))) return unread();
  const got = durationToDays(found[0]!);
  if (!got) return unread();
  const reasons: ReasonCode[] = got.approx ? ['UNIT_CONVERTED'] : [];
  return read(got.days, reasons);
}
