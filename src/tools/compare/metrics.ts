// 상품 하나에서 견줄 값을 낸다. 순수 함수다(시계·난수·DB 없음).
// 읽는 것은 본체가 채운 칸 그대로다. 값이 없으면 없음이고(까닭을 함께 낸다), 다른 칸에서 짐작해 채우지 않는다.
// 돈은 상품에 적힌 그대로다. 부가세를 더하지도 빼지도 않는다.
import { HoursSchema, PeriodOptionSchema, QuantityOptionSchema, SizeMSchema, type FieldKey } from '@/contract/fields';
import {
  COMPARE_METRIC_DEFS,
  type CompareBasis,
  type CompareMetric,
  type CompareMissingReason,
  type CompareOption,
  type CompareProduct,
  type CompareRow,
  type CompareValue,
} from '@/contract/tools/compare';

const posInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const nonNegInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

export const found = (value: number, basis: CompareBasis, rounded = false): CompareValue => ({ value, rounded, basis, missing: null });
export const none = (reason: CompareMissingReason, fields: readonly FieldKey[] = []): CompareValue => ({
  value: null,
  rounded: false,
  basis: null,
  missing: { reason, fields: [...fields] },
});

/**
 * 정수 나눗셈을 원 단위로 반올림한다(반은 올린다). 나누어떨어지지 않았으면 rounded 가 참이다.
 * 정수로만 센다(소수 오차가 끼지 않는다). 나누는 수가 0 이하거나 다룰 수 없이 큰 수면 null.
 */
export function roundDiv(numerator: number, denominator: number): { value: number; rounded: boolean } | null {
  if (!nonNegInt(numerator) || !posInt(denominator)) return null;
  const rest = numerator % denominator;
  const whole = (numerator - rest) / denominator;
  return { value: rest * 2 >= denominator ? whole + 1 : whole, rounded: rest !== 0 };
}

interface SizedOption {
  size: number;
  price_krw: number;
}

/**
 * 상품의 옵션을 읽는다. 광고는 기간 옵션(일수), 케이터링은 수량 옵션(수량). 작은 것부터(같으면 값이 작은 것부터).
 * listed: 적힌 옵션 수. usable: 일수(수량)와 값이 모두 0보다 큰 정수인 것만.
 */
export function readOptions(product: Pick<CompareProduct, 'type' | 'options'>): { listed: number; usable: SizedOption[] } {
  if (product.type === 'goods') return { listed: 0, usable: [] };
  const usable = product.options.flatMap((o): SizedOption[] => {
    if (product.type === 'ad') {
      const parsed = PeriodOptionSchema.safeParse(o);
      return parsed.success && posInt(parsed.data.days) && posInt(parsed.data.price_krw) ? [{ size: parsed.data.days, price_krw: parsed.data.price_krw }] : [];
    }
    const parsed = QuantityOptionSchema.safeParse(o);
    return parsed.success && posInt(parsed.data.qty) && posInt(parsed.data.price_krw) ? [{ size: parsed.data.qty, price_krw: parsed.data.price_krw }] : [];
  });
  usable.sort((a, b) => a.size - b.size || a.price_krw - b.price_krw);
  return { listed: product.options.length, usable };
}

/**
 * 대표 옵션: 가장 짧은 기간(가장 적은 수량) 옵션. 본체의 대표 판매가가 그 옵션의 값이다.
 * 같은 일수(수량)의 옵션이 둘 이상이면 대표 판매가와 값이 같은 것을 고른다(화면의 판매가와 다른 값에서 나누지 않게).
 * 판매가와 같은 것이 없으면 값이 작은 쪽이다.
 */
function representative(usable: readonly SizedOption[], price_krw: number): SizedOption | undefined {
  const first = usable[0];
  if (!first) return undefined;
  return usable.find((o) => o.size === first.size && o.price_krw === price_krw) ?? first;
}

/** 가장 긴 기간(가장 많은 수량) 옵션. 같은 것이 둘 이상이면 값이 작은 쪽이다(대표 옵션과 같은 규칙). */
function largest(usable: readonly SizedOption[]): SizedOption | undefined {
  const last = usable[usable.length - 1];
  return last ? usable.find((o) => o.size === last.size) : undefined;
}

/** 옵션마다 값 ÷ 일수(수량). 옵션에 적힌 값만 쓴다. 없는 기간·수량의 값을 지어내지 않는다. */
export function optionValues(product: Pick<CompareProduct, 'type' | 'options'>): CompareOption[] {
  const kind = product.type === 'ad' ? 'period' : 'quantity';
  return readOptions(product).usable.flatMap((o): CompareOption[] => {
    const each = roundDiv(o.price_krw, o.size);
    return each ? [{ kind, size: o.size, price_krw: o.price_krw, each: each.value, rounded: each.rounded }] : [];
  });
}

/** 적혀 있지만 쓸 수 없어 계산에서 뺀 옵션 수(일수·수량·값이 0 이하이거나 꼴이 틀린 것). 말없이 버리지 않고 줄에 함께 낸다. */
export function skippedOptions(product: Pick<CompareProduct, 'type' | 'options'>): number {
  const { listed, usable } = readOptions(product);
  return listed - usable.length;
}

/** 옵션이 없을 때의 까닭. 하나도 안 적혀 있으면 기간(수량)을 모르는 것이고, 적혀 있는데 쓸 수 없으면 값이 틀린 것이다. */
function noOption(listed: number, reason: 'no_period' | 'no_quantity', field: FieldKey): CompareValue {
  return listed === 0 ? none(reason, [field]) : none('bad_value', [field]);
}

/** 하루당 값: 가장 짧은 기간 옵션의 값 ÷ 그 옵션의 일수. 기간 옵션이 없으면 판매가가 있어도 내지 않는다(기간을 모른다). */
export function perDay(product: CompareProduct): CompareValue {
  const { listed, usable } = readOptions(product);
  const shortest = representative(usable, product.price_krw);
  if (!shortest) return noOption(listed, 'no_period', 'period_options');
  const each = roundDiv(shortest.price_krw, shortest.size);
  if (!each) return none('bad_value', ['period_options']);
  return found(each.value, { kind: 'period_option', days: shortest.size, price_krw: shortest.price_krw }, each.rounded);
}

/**
 * 하루 유동인구 1,000명당 값: 가장 짧은 기간 옵션의 값 × 1,000 ÷ (일수 × 하루 유동인구).
 * 반올림한 하루당 값을 다시 나누지 않고 한 번에 나눈다(반올림이 두 번 쌓이지 않는다). 하루당 값과 유동인구가 둘 다 있을 때만 낸다.
 */
export function perThousandFootfall(product: CompareProduct): CompareValue {
  const { listed, usable } = readOptions(product);
  const footfall = product.spec.footfall_per_day;
  const shortest = representative(usable, product.price_krw);
  if (!shortest) {
    const lacking = noOption(listed, 'no_period', 'period_options');
    return footfall === undefined || footfall === null ? none(lacking.missing!.reason, ['period_options', 'footfall_per_day']) : lacking;
  }
  if (footfall === undefined || footfall === null) return none('no_value', ['footfall_per_day']);
  if (!posInt(footfall)) return none('bad_value', ['footfall_per_day']);
  const numerator = shortest.price_krw * 1000;
  const denominator = shortest.size * footfall;
  const each = Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator) ? roundDiv(numerator, denominator) : null;
  if (!each) return none('bad_value', ['period_options', 'footfall_per_day']);
  return found(each.value, { kind: 'per_footfall', days: shortest.size, price_krw: shortest.price_krw, footfall }, each.rounded);
}

/** 한 개당 값: 가장 적은(또는 가장 많은) 수량 옵션의 값 ÷ 그 수량. 옵션이 하나뿐이면 둘이 같은 옵션이다. */
export function perUnit(product: CompareProduct, which: 'min' | 'max'): CompareValue {
  const { listed, usable } = readOptions(product);
  const picked = which === 'min' ? representative(usable, product.price_krw) : largest(usable);
  if (!picked) return noOption(listed, 'no_quantity', 'quantity_options');
  const each = roundDiv(picked.price_krw, picked.size);
  if (!each) return none('bad_value', ['quantity_options']);
  return found(each.value, { kind: 'quantity_option', qty: picked.size, price_krw: picked.price_krw }, each.rounded);
}

/** 소수를 정수와 자릿수로 나눈다(1.005 → 1005 와 3). 글자로 읽어 소수 오차가 끼지 않는다. 지수 꼴이거나 너무 크면 null. */
function decimalParts(n: number): { digits: number; scale: number } | null {
  const text = String(n);
  if (!/^[0-9]+(\.[0-9]+)?$/.test(text)) return null;
  const [whole = '0', frac = ''] = text.split('.');
  const digits = Number(whole + frac);
  return Number.isSafeInteger(digits) ? { digits, scale: frac.length } : null;
}

/** 넓이는 소수 넷째 자리까지 낸다. 그보다 잘게 나오면 넷째 자리로 반올림하고 그렇다고 알린다. */
const AREA_DECIMALS = 4;

/**
 * 화면 넓이(m²) = 가로 × 세로. 적힌 숫자를 정수로 바꿔 곱한다(0.1 × 0.2 = 0.02, 1.005 × 2 = 2.01. 소수 오차가 끼지 않는다).
 * 소수 넷째 자리 안에서 떨어지면 그대로이고, 넘으면 넷째 자리로 반올림하고 rounded 로 알린다.
 */
export function screenArea(spec: Record<string, unknown>): CompareValue {
  const raw = spec.size_m;
  if (raw === undefined || raw === null) return none('no_value', ['size_m']);
  const parsed = SizeMSchema.safeParse(raw);
  if (!parsed.success) return none('bad_value', ['size_m']);
  const { width, height } = parsed.data;
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) return none('bad_value', ['size_m']);
  const w = decimalParts(width);
  const h = decimalParts(height);
  if (!w || !h) return none('bad_value', ['size_m']);
  const product = w.digits * h.digits;
  const scale = w.scale + h.scale;
  if (!Number.isSafeInteger(product)) return none('bad_value', ['size_m']);
  const basis: CompareBasis = { kind: 'size', width, height };
  if (scale <= AREA_DECIMALS) return found(product / 10 ** scale, basis);
  const cut = roundDiv(product, 10 ** (scale - AREA_DECIMALS));
  if (!cut) return none('bad_value', ['size_m']);
  return found(cut.value / 10 ** AREA_DECIMALS, basis, cut.rounded);
}

const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const DAY_MINUTES = 24 * 60;

/**
 * 하루 운영 시간(분). 같은 날이면 끝 − 시작, 다음 날로 넘어가면 끝 + 24시간 − 시작.
 * 시작과 끝이 같고 다음 날이면 24시간이다. 0분 이하이거나 하루를 넘으면 계산하지 않는다(값이 틀린 것이다).
 */
export function openMinutes(spec: Record<string, unknown>, field: 'hours' | 'service_hours'): CompareValue {
  const raw = spec[field];
  if (raw === undefined || raw === null) return none('no_value', [field]);
  const parsed = HoursSchema.safeParse(raw);
  if (!parsed.success) return none('bad_value', [field]);
  const { open, close, nextDay } = parsed.data;
  const minutes = minutesOf(close) - minutesOf(open) + (nextDay ? DAY_MINUTES : 0);
  if (minutes <= 0 || minutes > DAY_MINUTES) return none('bad_value', [field]);
  return found(minutes, { kind: 'hours', open, close, nextDay });
}

/** 칸의 정수를 그대로 읽는다. 비었으면 없음, 꼴이 틀리면(음수 등) 값이 틀린 것이다. */
function readInt(spec: Record<string, unknown>, field: FieldKey, allowZero: boolean): CompareValue {
  const raw = spec[field];
  if (raw === undefined || raw === null) return none('no_value', [field]);
  if (!nonNegInt(raw) || (!allowZero && raw === 0)) return none('bad_value', [field]);
  return found(raw, { kind: 'field', field });
}

/** 하루 노출 시간(초) = 하루 송출 횟수 × 한 번 길이. 둘 다 있을 때만. */
export function exposureSeconds(spec: Record<string, unknown>): CompareValue {
  const plays = readInt(spec, 'plays_per_day', false);
  const seconds = readInt(spec, 'spot_seconds', false);
  if (plays.value === null || seconds.value === null) {
    const lacking = [plays, seconds].filter((v) => v.missing !== null);
    const reason = lacking.some((v) => v.missing?.reason === 'bad_value') ? 'bad_value' : 'no_value';
    return none(reason, lacking.flatMap((v) => v.missing?.fields ?? []) as FieldKey[]);
  }
  const total = plays.value * seconds.value;
  if (!Number.isSafeInteger(total)) return none('bad_value', ['plays_per_day', 'spot_seconds']);
  return found(total, { kind: 'exposure', plays: plays.value, seconds: seconds.value });
}

function valueOf(metric: CompareMetric, product: CompareProduct): CompareValue {
  const { spec } = product;
  switch (metric) {
    case 'per_day_krw':
      return perDay(product);
    case 'per_1000_footfall_krw':
      return perThousandFootfall(product);
    case 'footfall_per_day':
      return readInt(spec, 'footfall_per_day', false);
    case 'area_m2':
      return screenArea(spec);
    case 'open_minutes':
      return openMinutes(spec, product.type === 'catering' ? 'service_hours' : 'hours');
    case 'plays_per_day':
      return readInt(spec, 'plays_per_day', false);
    case 'spot_seconds':
      return readInt(spec, 'spot_seconds', false);
    case 'exposure_seconds':
      return exposureSeconds(spec);
    case 'booking_deadline_days':
    case 'material_deadline_days':
    case 'refund_full_days':
    case 'design_deadline_days':
    case 'lead_time_days':
      return readInt(spec, metric, true);
    case 'unit_krw_min_qty':
      return perUnit(product, 'min');
    case 'unit_krw_max_qty':
      return perUnit(product, 'max');
    case 'price_krw':
      return posInt(product.price_krw) ? found(product.price_krw, { kind: 'field', field: 'price_krw' }) : none('bad_value', ['price_krw']);
    case 'min_order_qty':
      return readInt(spec, 'min_order_qty', false);
  }
}

/** 상품의 위치(광고)·출장 지역(케이터링). 굿즈는 없다. */
export function regionOf(product: Pick<CompareProduct, 'type' | 'spec'>): string | null {
  const raw = product.type === 'ad' ? product.spec.region : product.type === 'catering' ? product.spec.service_region : null;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

/** 상품 하나의 견줄 값 전부. 그 종류에 없는 잣대는 "해당 없음"이다. 차례는 아직 없다(rank 는 null). */
export function compareRow(product: CompareProduct): CompareRow {
  const values = {} as Record<CompareMetric, CompareValue>;
  for (const def of COMPARE_METRIC_DEFS) {
    values[def.key] = def.types.includes(product.type) ? valueOf(def.key, product) : none('not_applicable');
  }
  return {
    productId: product.id,
    name: product.name,
    type: product.type,
    subtype: product.subtype,
    region: regionOf(product),
    vatIncluded: typeof product.vat_included === 'boolean' ? product.vat_included : null,
    values,
    options: optionValues(product),
    optionsSkipped: skippedOptions(product),
    rank: null,
    rankType: null,
    rankGroup: null,
  };
}
