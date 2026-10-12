// 유동인구 맞추기. 월·주·연 단위를 하루로 바꾼다. 월 ÷ 30, 주 ÷ 7, 연 ÷ 365, 소수는 반올림.
import type { NormalizeResult } from '@/contract/core-api';
import { findNumberChunks, hasNumberRange } from '../numbers';
import { plain, read, unread } from '../text';

type Per = 'day' | 'week' | 'month' | 'year';
const DIVISOR: Record<Per, number> = { day: 1, week: 7, month: 30, year: 365 };

// 낱글자 "일", "월"은 앞뒤가 비어 있을 때만 단위로 본다("평일", "월요일"을 단위로 읽지 않으려고).
const lone = (ch: string) => String.raw`(?<![가-힣a-z\d])${ch}(?=\s|\d|약|[):\]]|$)`;
const PER: [Per, RegExp][] = [
  ['day', new RegExp(String.raw`하루|일일|일\s*평균|1\s*일|매일|daily|per\s*day|a\s*day|\/\s*day|\/\s*일|日均|每日|每天|${lone('일')}`, 'g')],
  ['week', new RegExp(String.raw`주간|주\s*평균|1\s*주|매주|weekly|per\s*week|\/\s*주|每周|${lone('주')}`, 'g')],
  ['month', new RegExp(String.raw`월간|월\s*평균|한\s*달|1\s*개월|매월|monthly|per\s*month|\/\s*월|\/\s*month|月均|每月|${lone('월')}`, 'g')],
  ['year', new RegExp(String.raw`연간|연\s*평균|1\s*년|매년|yearly|annual(?:ly)?|per\s*year|\/\s*년|每年|${lone('연')}|${lone('년')}`, 'g')],
];

/** 기준을 나타내는 말 전부. 규칙만으로 뽑기가 원문 표현의 앞머리를 찾을 때 쓴다. */
export const PER_ANY = PER.map(([, re]) => re.source).join('|');

/**
 * "월 300만명" → 100000 + UNIT_CONVERTED. "일 평균 10만명" → 100000.
 * 기준(하루·주·월·연)이 안 적혔거나 둘 이상이면 못 읽은 것으로 둔다. 짐작하지 않는다.
 */
export function normalizeFootfall(raw: string): NormalizeResult<number> {
  let t = plain(raw);
  if (hasNumberRange(t)) return unread();

  const found: Per[] = [];
  for (const [per, re] of PER) {
    if (t.search(re) >= 0) found.push(per);
    t = t.replace(re, ' ');
  }
  if (found.length !== 1) return unread();

  const chunks = findNumberChunks(t);
  if (chunks.length !== 1 || chunks[0]!.value === null) return unread();
  const perDay = Math.round(chunks[0]!.value / DIVISOR[found[0]!]);
  return read(perDay, found[0] === 'day' ? [] : ['UNIT_CONVERTED']);
}
