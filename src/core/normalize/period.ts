// 기간별·수량별 값표 맞추기. "1주 150 2주 280" → [(7일, 150만원), (14일, 280만원)]
import type { NormalizeResult } from '@/contract/core-api';
import type { PeriodOption, QuantityOption } from '@/contract/fields';
import type { ReasonCode } from '@/contract/reasons';
import { plain, read, unread } from '../text';
import { DURATION, durationToDays } from './days';
import { normalizeMoney } from './money';

interface Key {
  start: number;
  end: number;
  key: number;
  approx: boolean;
}
interface Row {
  key: number;
  price: number;
}

/**
 * 값표를 읽는다. 열쇠(기간이나 수량)마다 그 옆의 금액 하나를 짝짓는다.
 * 금액이 열쇠 뒤에 오는 꼴("1주 150만원")과 앞에 오는 꼴("150만원/1주")을 모두 읽는다.
 * 짝이 안 맞거나, 같은 열쇠에 값이 둘이거나, 금액 하나라도 못 읽으면 통째로 못 읽은 것이다.
 * 낱개 값("1잔당")이나 범위 열쇠("1~2주")가 섞여도 그렇다.
 */
function readTable(t: string, found: Key[]): NormalizeResult<Row[]> {
  // 값표의 줄이 아닌 것이 섞였으면 통째로 못 읽은 것으로 둔다.
  // "1잔당 8,000원", "추가 1인당 5천원"(낱개 값), "2주차부터"(몇 번째), "1~2주"·"100~150잔"(범위).
  for (const k of found) {
    if (/^\s?(?:당|차|마다)/.test(t.slice(k.end))) return unread();
    if (/(?:추가|초과)\s?$|\d\s?[~∼〜\-–—]\s?$/.test(t.slice(0, k.start))) return unread();
  }
  // "4주(28일) 500만원" 처럼 같은 기간을 두 번 적은 것은 하나로 합친다.
  const keys: Key[] = [];
  for (const k of found) {
    const prev = keys[keys.length - 1];
    if (prev && !/\d/.test(t.slice(prev.end, k.start))) {
      if (prev.key !== k.key) return unread();
      prev.end = k.end;
    } else keys.push({ ...k });
  }
  if (keys.length === 0) return unread();

  const last = keys[keys.length - 1]!;
  const priceFirst = /\d/.test(t.slice(0, keys[0]!.start)) && !/\d/.test(t.slice(last.end));

  const reasons: ReasonCode[] = [];
  const rows = new Map<number, number>();
  for (const [i, k] of keys.entries()) {
    const segment = priceFirst
      ? t.slice(keys[i - 1]?.end ?? 0, k.start)
      : t.slice(k.end, keys[i + 1]?.start ?? t.length);
    const price = normalizeMoney(segment);
    if (price.value === null) return unread();
    if (rows.has(k.key) && rows.get(k.key) !== price.value) return unread();
    rows.set(k.key, price.value);
    reasons.push(...price.reasons);
    if (k.approx) reasons.push('UNIT_CONVERTED');
  }
  const sorted = [...rows].sort((a, b) => a[0] - b[0]).map(([key, price]) => ({ key, price }));
  return read(sorted, reasons);
}

/** "1주 150만원 / 2주 280만원" → 일수가 작은 것부터. 단위 없는 금액은 만원으로 짐작하고 UNIT_CONVERTED. */
export function normalizePeriodOptions(raw: string): NormalizeResult<PeriodOption[]> {
  const t = plain(raw);
  const keys: Key[] = [];
  for (const m of t.matchAll(new RegExp(DURATION, 'g'))) {
    const got = durationToDays(m);
    if (!got || /시간|hours?|hrs?|小时/.test(m[2] ?? '')) return unread();
    keys.push({ start: m.index, end: m.index + m[0].length, key: got.days, approx: got.approx });
  }
  const table = readTable(t, keys);
  if (table.value === null) return unread();
  return read(table.value.map((r) => ({ days: r.key, price_krw: r.price })), table.reasons);
}

const QUANTITY = /(\d{1,3}(?:,\d{3})+|\d+)\s*(?:잔|인분|인|명|개|세트|set|ea|cups?|pcs|份|杯|个)(?![a-z])/g;

/** "100잔 80만원 / 200잔 150만원" → 수량이 적은 것부터. */
export function normalizeQuantityOptions(raw: string): NormalizeResult<QuantityOption[]> {
  const t = plain(raw);
  const keys: Key[] = [...t.matchAll(QUANTITY)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    key: Number(m[1]!.replace(/,/g, '')),
    approx: false,
  }));
  const table = readTable(t, keys);
  if (table.value === null) return unread();
  return read(table.value.map((r) => ({ qty: r.key, price_krw: r.price })), table.reasons);
}
