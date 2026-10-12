// 금액 맞추기. 원문 표현 → 원 단위 정수.
// 부가세를 더하거나 빼지 않는다. 적힌 금액 그대로다.
import type { NormalizeResult } from '@/contract/core-api';
import type { ReasonCode } from '@/contract/reasons';
import { findNumberChunks, hasNumberRange } from '../numbers';
import { asInt, plain, read, unread } from '../text';

/** 원이 아닌 돈. 환율을 짐작해 바꾸지 않고 못 읽은 것으로 둔다. */
const FOREIGN = /[¥$€£]|元|圓|円|위안|人民币|rmb|cny|jpy|usd|eur|달러|dollar|유로|[\d억만천백십]\s*(?:엔|동|불)(?![가-힣])/;
export const WON_AFTER = /^\s?(?:원|韩元|韩币|won|krw)/;
export const WON_BEFORE = /(?:₩|krw)\s?$/;
/** 수 바로 뒤에 붙으면 돈이 아닌 것("1주", "10%", "10만명", "2면"). */
export const COUNTER_AFTER = /^(?:[a-z%]|주|일|개|명|회|잔|부(?!터)|장|매|인|초|분|시|면|번|호|층|년|월|차|종|건|세트|박|배)/;
/** 단위 없이 숫자만 적혔을 때 이 값보다 작으면 "만원"이 빠진 것으로 본다. */
const BARE_MAN_BELOW = 10_000;

/**
 * "150만원", "1,500,000원", "1.5천만", "150"(만원 생략) → 원.
 * - 원이 아닌 돈, 범위("150~200만원"), 서로 다른 금액 둘 이상은 못 읽은 것으로 둔다.
 * - 단위 없는 작은 숫자는 만원으로 짐작하고 UNIT_CONVERTED 를 붙인다.
 */
export function normalizeMoney(raw: string): NormalizeResult<number> {
  let t = plain(raw);
  if (!t) return unread();
  if (FOREIGN.test(t.replace(/韩元|韩币|韓元/g, '원'))) return unread();
  if (hasNumberRange(t)) return unread();
  // 영어 표기는 원 표시가 함께 있을 때만 읽는다. "1.5 million won", "1500k krw"
  if (/₩|krw|won/.test(t)) {
    t = t
      .replace(/(\d)\s?(?:million|mil)(?![a-z])/g, '$1백만')
      .replace(/(\d)\s?m(?=\s?(?:krw|won))/g, '$1백만')
      .replace(/(\d)\s?k(?![a-z])/g, '$1천');
  }

  const priced: number[] = [];
  const bare: number[] = [];
  for (const c of findNumberChunks(t)) {
    const after = t.slice(c.end);
    const before = t.slice(0, c.start);
    // 덩어리가 수의 일부만 집었으면 쉼표·점을 잘못 찍은 글이다("1,50만원", "1.500.000원", "1 500 000원").
    if (/[\d.,]$/.test(before) || /^(?:\d|[.,]\d|\s\d[\d,.]*(?:\s|원|$))/.test(after)) return unread();
    const won = WON_AFTER.test(after) || WON_BEFORE.test(before);
    if (!won && (COUNTER_AFTER.test(after) || /[a-z#]$/.test(before))) continue;
    if (c.value === null) return unread();
    (won || c.hasUnit ? priced : bare).push(c.value);
  }

  const reasons: ReasonCode[] = [];
  let value: number;
  if (priced.length > 0) {
    if (new Set(priced).size !== 1) return unread();
    value = priced[0]!;
  } else {
    if (bare.length !== 1) return unread();
    value = bare[0]!;
    if (value < BARE_MAN_BELOW) {
      value *= 10_000;
      reasons.push('UNIT_CONVERTED');
    }
  }
  const won = asInt(value);
  return won === null ? unread() : read(won, reasons);
}

const TAX_WORD = /부가세|부가가치세|vat|v\.a\.t|세금|tax|税/;
/** 뒤집는 말. "포함되어 있지 않습니다", "포함 아님", "포함 안 됨" */
const NOT_TAIL = String.raw`[^\s,./]{0,4}\s?(?:있지\s?)?(?:않|아님|아닙|아니[며고라]|안\s?[됨되돼])`;
const NOT_INCLUDED = new RegExp(`포함${NOT_TAIL}`, 'g');
const NOT_EXCLUDED = new RegExp(`(?:별도|제외)${NOT_TAIL}`);

/**
 * "부가세 별도" → false, "VAT 포함" → true, "부가세는 포함되어 있지 않습니다" → false.
 * 못 읽은 것으로 두는 것: 세금 낱말이 없음("배송비 포함"), 묻는 말("포함 여부 문의"),
 * 두 번 뒤집은 말("별도가 아닙니다"), 포함과 별도가 함께 보임.
 */
export function normalizeVat(raw: string): NormalizeResult<boolean> {
  const t = plain(raw);
  if (!TAX_WORD.test(t)) return unread();
  if (/여부|인지|[?？]/.test(t) || NOT_EXCLUDED.test(t)) return unread();
  const denied = t.search(NOT_INCLUDED) >= 0;
  const rest = t.replace(NOT_INCLUDED, ' ');
  const no = denied || /별도|미\s?포함|불\s?포함|제외|excl|not\s+included|\+\s?vat|vat\s?\+|不含|未含/.test(rest);
  const yes = /포함|incl|含/.test(rest.replace(/미\s?포함|불\s?포함|not\s+included|不含|未含/g, ''));
  if (no === yes) return unread();
  return read(yes);
}
