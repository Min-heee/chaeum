// 값이 말이 되는지 본다.
import type { FieldReasons } from '@/contract/core-api';
import {
  fieldDef,
  FIELDS_BY_TYPE,
  type DocType,
  type FieldKey,
  type FieldKind,
  type FieldValues,
  type Hours,
} from '@/contract/fields';

/** 크기의 한 변이 이 범위를 벗어나면 단위를 잘못 읽은 것으로 본다(m 와 mm 를 뒤바꾸면 1000배가 된다). */
const SIDE_LIMITS: Partial<Record<FieldKind, { min: number; max: number }>> = {
  size_m: { min: 0.05, max: 300 },
  size_mm: { min: 1, max: 10_000 },
};

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** 운영 시간이 0 이하이거나 24시간을 넘는가. 24시간 운영(시작 = 끝, 다음 날)은 괜찮다. */
function badHours(h: Hours): boolean {
  const open = minutesOf(h.open);
  const close = minutesOf(h.close);
  return h.nextDay ? close > open : close <= open;
}

/** 열쇠(기간·수량)가 커지는데 총액이 작아지는 줄이 있는가. 값이 같은 것은 괜찮다. */
function cheaperForMore(rows: { key: number; price: number }[]): boolean {
  const sorted = [...rows].sort((a, b) => a.key - b.key);
  return sorted.some((row, i) => i > 0 && row.key > sorted[i - 1]!.key && row.price < sorted[i - 1]!.price);
}

function badValue(kind: FieldKind, value: unknown): boolean {
  switch (kind) {
    case 'money':
    case 'count':
    case 'days':
    case 'footfall':
      return isNum(value) && value <= 0;
    case 'size_m':
    case 'size_mm':
    case 'resolution': {
      const { width, height } = value as { width: unknown; height: unknown };
      // 해상도는 한계가 없다. 0 이하만 건다.
      const limit = SIDE_LIMITS[kind] ?? { min: Number.MIN_VALUE, max: Infinity };
      return [width, height].some((n) => !isNum(n) || n < limit.min || n > limit.max);
    }
    case 'hours':
      return badHours(value as Hours);
    case 'period_options':
    case 'quantity_options': {
      if (!Array.isArray(value)) return false;
      const rows = value.map((o: { days?: number; qty?: number; price_krw: number }) => ({
        key: (o.days ?? o.qty) as number,
        price: o.price_krw,
      }));
      return rows.some((r) => !(r.key > 0) || !(r.price > 0)) || cheaperForMore(rows);
    }
    default:
      return false;
  }
}

/**
 * 0 이하, 판매가 > 정가, 기간이 길수록(수량이 많을수록) 총액이 작아짐, 운영 0 이하·24시간 초과,
 * 크기가 터무니없음 → 그 칸에 OUT_OF_RANGE.
 */
export function checkRange(type: DocType, values: FieldValues): FieldReasons {
  const out: FieldReasons = {};
  const flag = (key: FieldKey) => (out[key] = ['OUT_OF_RANGE']);

  for (const key of FIELDS_BY_TYPE[type]) {
    const value = values[key];
    if (value === null || value === undefined) continue;
    try {
      if (badValue(fieldDef(key).kind, value)) flag(key);
    } catch {
      // 꼴이 깨진 값은 조용히 넘기지 않는다.
      flag(key);
    }
  }

  // 판매가가 정가보다 크면 둘 중 하나가 틀렸다. 어느 쪽인지는 모르므로 둘 다 표시한다.
  const { price_krw: price, list_price_krw: list } = values;
  if (FIELDS_BY_TYPE[type].length > 0 && isNum(price) && isNum(list) && price > list) {
    flag('price_krw');
    flag('list_price_krw');
  }
  return out;
}
