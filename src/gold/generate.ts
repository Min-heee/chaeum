// 정답 100건을 만든다. 씨앗이 같으면 결과가 같다. 원문은 여기서 쓰지 않는다.
// 순서: 묶음별로 종류·꼴·함정을 나눈다 → 건마다 값을 뽑는다 → 값과 함께 "원문에 적을 표기"를 남긴다.
import {
  FIELDS_BY_TYPE,
  REQUIRED_BY_TYPE,
  fieldDef,
  type DocType,
  type FieldKey,
  type FieldValue,
  type ProductType,
} from '@/contract/fields';
import { GOLD_STYLES, type GoldStyle, type GoldTrap } from '@/contract/eval-types';
import {
  AD_BRANDS,
  AD_KINDS,
  AD_REGIONS,
  AD_WEEK_PRICE_MAN,
  CATERING_BRANDS,
  CATERING_PACKAGES,
  CATERING_UNIT_PRICE,
  CONFUSION_GOODS,
  CONFUSION_RECIPES,
  FAN_GROUPS,
  FILE_FORMAT_SETS,
  GOODS_ITEMS,
  GOODS_MAKERS,
  INSTRUCTION_SENTENCES,
  NOT_PRODUCT_TOPICS,
  PERIOD_SETS,
  PERIOD_WORDS,
  PLACEHOLDER_WORDS,
  QUANTITY_SETS,
  QUANTITY_UNITS,
  RESOLUTIONS,
  SERVICE_REGIONS,
  STATIC_FORMAT_SETS,
  type AdKind,
  type ConfusionRecipe,
  type GoodsItem,
  type NotProductTopic,
} from './catalog';
import { hashSeed, makeRng, type Rng } from './rng';
import { DEFAULT_SEED, type AbsentHint, type GoldSpec, type SurfaceHint } from './spec';

/**
 * 묶음별 건수. 연습과 안 여는 세트의 비율이 같다(2 : 3).
 * missing 은 "정가 말고도 없는 칸이 하나 이상"인 문서 수다(전체의 60%).
 * 정가는 따로 적힌 글이 드물어서 대부분 "없음"이고, 이 수에 넣지 않는다.
 */
export const PLAN = {
  dev: { total: 40, ad: 24, catering: 7, goods: 7, not_product: 2, missing: 24, unit: 16, price: 16, instruction: 1, confusion: 2 },
  test: { total: 60, ad: 36, catering: 10, goods: 11, not_product: 3, missing: 36, unit: 24, price: 24, instruction: 2, confusion: 3 },
} as const;

type Split = keyof typeof PLAN;

interface Slot {
  id: string;
  split: Split;
  type: DocType;
  style: GoldStyle;
  missing: boolean;
  unit: boolean;
  price: boolean;
  instruction: string | null;
  confusion: ConfusionRecipe | null;
  topic: NotProductTopic | null;
}

// ── 표기 만들기 ────────────────────────────────────────────

type MoneyForm = 'won' | 'plain' | 'man' | 'bare' | 'cheon' | 'man_dec';

const comma = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function showMoney(won: number, form: MoneyForm): string {
  switch (form) {
    case 'won':
      return `${comma(won)}원`;
    case 'plain':
      return `${won}원`;
    case 'man':
    case 'man_dec':
      return `${won / 10_000}만원`;
    case 'bare':
      return `${won / 10_000}`;
    case 'cheon':
      return `${won / 1_000}천원`;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (h: number, m = 0) => `${pad(h)}:${pad(m)}`;

/** 한 건을 채우는 동안 쓰는 그릇 */
class Draft {
  truth: Partial<Record<FieldKey, FieldValue | null>> = {};
  hints: SurfaceHint[] = [];
  absent: AbsentHint[] = [];
  detail: string[] = [];
  nulls = new Set<FieldKey>();

  put(field: FieldKey, value: FieldValue, show: string, tokens: string[], form: string, note?: string) {
    this.truth[field] = value;
    this.hints.push({ field, label: fieldDef(field).label, show, tokens, form, ...(note ? { note } : {}) });
  }

  none(field: FieldKey, how: 'omit' | 'placeholder', placeholder?: string, note?: string) {
    this.truth[field] = null;
    const label = fieldDef(field).label;
    this.absent.push({
      field,
      label,
      how,
      ...(placeholder ? { placeholder } : {}),
      note:
        note ??
        (how === 'placeholder'
          ? `"${label}" 자리에 값 대신 "${placeholder}"라고만 쓴다. 진짜 값은 쓰지 않는다.`
          : `"${label}"에 해당하는 정보를 글 어디에도 쓰지 않는다.`),
    });
  }
}

// ── 값 뽑기: 여러 종류가 함께 쓰는 것 ───────────────────────

function stepValue(r: Rng, [lo, hi, step]: readonly [number, number, number], skew = false): number {
  const steps = Math.round((hi - lo) / step);
  const u = skew ? r.next() ** 2 : r.next();
  return lo + step * Math.min(steps, Math.floor(u * (steps + 1)));
}

/** 칸별로 그럴듯한 일수 */
const DAY_PLAIN: Partial<Record<FieldKey, readonly number[]>> = {
  material_deadline_days: [3, 5, 7, 10],
  refund_full_days: [7, 10, 14, 20],
  booking_deadline_days: [7, 10, 14, 20],
  design_deadline_days: [5, 7, 10, 14],
  lead_time_days: [5, 7, 10, 14],
};
const DAY_WEEKLY: readonly (readonly [number, string])[] = [
  [7, '1주'],
  [14, '2주'],
  [21, '3주'],
  [30, '1개월'],
  [30, '한 달'],
];

/** 일수 칸 하나. weekly 면 "2주 전" 같은 표기를 쓴다. */
function putDays(d: Draft, r: Rng, field: FieldKey, weekly: boolean, phrase: (s: string) => string) {
  if (weekly) {
    const [days, word] = r.pick(DAY_WEEKLY);
    d.put(field, days, phrase(word), [word], 'days:week', '주·달 단위로 적는다. 일수로 바꿔 적지 않는다.');
  } else {
    const days = r.pick(DAY_PLAIN[field] ?? [7]);
    d.put(field, days, phrase(`${days}일`), [`${days}일`], 'days:day');
  }
}

function putVat(d: Draft, r: Rng, included: boolean) {
  const show = `${r.pick(['부가세', 'VAT'])} ${included ? '포함' : '별도'}`;
  d.put('vat_included', included, show, [show], 'bool');
}

type HoursStyle = 'plain' | 'over24' | 'night' | 'ampm';

/** 운영 시간. over24 는 "05시~25시"처럼 24시를 넘겨 적는 꼴이다. */
function putHours(d: Draft, r: Rng, field: 'hours' | 'service_hours', style: HoursStyle) {
  if (field === 'hours') {
    const open = r.pick([5, 6, 7, 8]);
    if (style === 'plain') {
      const close = r.pick([21, 22, 23]);
      const show = r.chance(0.5) ? `${hhmm(open)}~${hhmm(close)}` : `${pad(open)}시~${close}시`;
      d.put(field, { open: hhmm(open), close: hhmm(close), nextDay: false }, show, [show], 'hours:plain');
      return;
    }
    const variant = r.pick(['si25', 'si25', 'colon24', 'colon25', 'allday'] as const);
    if (variant === 'allday') {
      d.put(field, { open: '00:00', close: '00:00', nextDay: true }, '24시간', ['24시간'], 'hours:allday', '시작·끝 시각은 쓰지 않고 24시간 운영이라고만 쓴다.');
      return;
    }
    const over = variant === 'colon24' ? 24 : r.pick([24, 25, 26]);
    const show = variant === 'si25' ? `${pad(open)}시~${over}시` : `${hhmm(open)}~${over}:00`;
    d.put(field, { open: hhmm(open), close: hhmm(over - 24), nextDay: true }, show, [show], 'hours:over24', '끝 시각을 24시 넘는 수 그대로 적는다(다음 날 새벽이라고 풀어 쓰지 않는다).');
    return;
  }
  // 케이터링: 몇 시간만 머문다.
  if (style === 'plain') {
    const open = r.pick([8, 9, 10, 11, 12, 13]);
    const close = open + r.pick([2, 3, 4]);
    const show = `${hhmm(open)}~${hhmm(close)}`;
    d.put(field, { open: hhmm(open), close: hhmm(close), nextDay: false }, show, [show], 'hours:plain');
    return;
  }
  if (style === 'night') {
    const open = r.pick([21, 22, 23]);
    const over = open + r.pick([3, 4]);
    const show = r.chance(0.5) ? `${open}시~${over}시` : `${hhmm(open)}~${hhmm(over - 24)}`;
    d.put(field, { open: hhmm(open), close: hhmm(over - 24), nextDay: true }, show, [show], 'hours:night', '밤샘 촬영장 운영이다. 적힌 표기 그대로 쓴다.');
    return;
  }
  const open = r.pick([9, 10, 11]);
  const closePm = r.pick([1, 2, 3, 4]);
  const show = `오전 ${open}시~오후 ${closePm}시`;
  d.put(field, { open: hhmm(open), close: hhmm(closePm + 12), nextDay: false }, show, [show], 'hours:ampm', '오전·오후로 적는다.');
}

/** 고를 수 있는 변형에서 하나나 둘을 고른다. */
function pickVariants<T extends string>(r: Rng, on: boolean, pool: readonly T[]): Set<T> {
  if (!on) return new Set();
  return new Set(r.sample(pool, r.chance(0.4) ? 2 : 1));
}

/** 없는 칸 고르기. 함정이 쓰는 칸(protect)과 원래 없는 칸은 건드리지 않는다. */
function chooseNulls(
  r: Rng,
  type: ProductType,
  slot: Slot,
  protect: Set<FieldKey>,
  natural: readonly FieldKey[],
  optionField: FieldKey | null,
  canDropPrice: boolean,
): { nulls: Set<FieldKey>; placeholders: Map<FieldKey, string> } {
  const nulls = new Set<FieldKey>(natural);
  const placeholders = new Map<FieldKey, string>();
  if (!slot.missing) return { nulls, placeholders };

  const required = new Set<FieldKey>(REQUIRED_BY_TYPE[type]);
  const free = (k: FieldKey) => !protect.has(k) && !nulls.has(k) && k !== 'list_price_krw' && k !== 'price_krw' && k !== 'name' && k !== optionField;
  const optional = FIELDS_BY_TYPE[type].filter((k) => free(k) && !required.has(k));
  const requiredFree = FIELDS_BY_TYPE[type].filter((k) => free(k) && required.has(k));

  const roll = r.next();
  let count = roll < 0.5 ? 1 : roll < 0.85 ? 2 : 3;
  if (natural.length > 0) count = r.chance(0.4) ? 1 : 0;
  const picked = r.sample(optional, Math.min(count, optional.length));
  // 가끔은 필수 칸이 없다(필수 칸 빠짐 표시가 붙는지 본다).
  if (requiredFree.length > 0 && r.chance(0.15)) picked.push(r.pick(requiredFree));
  // 가끔은 값이 "문의"다. 값과 옵션이 함께 없다.
  if (canDropPrice && r.chance(0.1)) {
    picked.push('price_krw');
    if (optionField) picked.push(optionField);
    placeholders.set('price_krw', r.pick(['문의', '협의', '추후 안내']));
  }
  if (picked.length === 0 && natural.length === 0 && optional[0]) picked.push(optional[0]);

  for (const k of picked) {
    nulls.add(k);
    if (!placeholders.has(k) && k !== optionField && r.chance(0.25)) placeholders.set(k, r.pick(PLACEHOLDER_WORDS));
  }
  return { nulls, placeholders };
}

/** 고른 "없는 칸"을 그릇에 적는다. */
function writeNulls(d: Draft, type: ProductType, nulls: Set<FieldKey>, placeholders: Map<FieldKey, string>, natural: readonly FieldKey[]) {
  // 값이 "문의"인 글에는 정가도 없다.
  if (!('list_price_krw' in d.truth)) d.none('list_price_krw', 'omit', undefined, '정가(할인 전 값)를 쓰지 않는다.');
  for (const k of FIELDS_BY_TYPE[type]) {
    if (!nulls.has(k) || k in d.truth) continue;
    const word = placeholders.get(k);
    if (word) d.none(k, 'placeholder', word);
    else if (natural.includes(k)) d.none(k, 'omit', undefined, `화면이 아닌 매체라서 "${fieldDef(k).label}"이 원래 없다. 쓰지 않는다.`);
    else d.none(k, 'omit');
    d.detail.push(`missing:${k}(${word ? 'placeholder' : 'omit'})`);
  }
  d.nulls = nulls;
}

/** 정가. 따로 적는 함정이 아니면 없다. */
function putListPrice(d: Draft, on: boolean, listWon: number, form: MoneyForm) {
  if (!on) {
    d.none('list_price_krw', 'omit', undefined, '정가(할인 전 값)를 따로 쓰지 않는다. 값은 하나만 나온다.');
    return;
  }
  const show = showMoney(listWon, form);
  d.put('list_price_krw', listWon, show, [show], `money:${form}`, '할인 전 값이라는 것을 밝힌다(정가, 원래 값 등). 판매가와 함께 나온다.');
}

function moneyNote(form: MoneyForm, r: Rng): string | undefined {
  if (form !== 'bare') return undefined;
  return r.chance(0.7)
    ? '금액은 만원 단위 숫자만 적는다("만원"을 붙이지 않는다). 글 어딘가에 "단위: 만원"이라고 한 번 밝힌다.'
    : '금액은 만원 단위 숫자만 적는다("만원"을 붙이지 않는다). 단위를 따로 밝히지 않는다.';
}

// ── 광고 지면 ──────────────────────────────────────────────

const AD_SUBTYPE_WEIGHTS: readonly ('전광판' | '지하철' | '버스')[] = ['전광판', '전광판', '전광판', '전광판', '전광판', '지하철', '지하철', '지하철', '버스', '버스'];
const AD_STATIC_NULLS: readonly FieldKey[] = ['resolution_px', 'spot_seconds', 'plays_per_day'];

export interface AdChoice {
  subtype: '전광판' | '지하철' | '버스';
  kind: AdKind;
}

function chooseAd(r: Rng, slot: Slot): AdChoice {
  if (slot.confusion) {
    const subtype = slot.confusion.subtype as AdChoice['subtype'];
    const base = AD_KINDS[subtype].find((k) => k.digital) as AdKind;
    return { subtype, kind: { ...base, name: slot.confusion.itemName } };
  }
  const subtype = r.pick(AD_SUBTYPE_WEIGHTS);
  return { subtype, kind: r.pick(AD_KINDS[subtype]) };
}

function buildAd(r: Rng, slot: Slot, choice: AdChoice, takeName: (make: () => string) => string): Draft {
  const d = new Draft();
  const { subtype, kind } = choice;
  const unit = pickVariants(r, slot.unit, ['hours_over24', 'footfall_period', 'size_unit', 'money_short', 'days_week'] as const);
  const price = pickVariants(r, slot.price, ['list_and_sale', 'vat_excluded', 'price_table'] as const);
  for (const v of unit) d.detail.push(`unit:${v}`);
  for (const v of price) d.detail.push(`price:${v}`);

  const dayFields: FieldKey[] = ['material_deadline_days', 'refund_full_days', 'booking_deadline_days'];
  const weeklyDays = new Set<FieldKey>(unit.has('days_week') ? r.sample(dayFields, r.chance(0.5) ? 2 : 1) : []);

  const protect = new Set<FieldKey>(weeklyDays);
  if (unit.has('hours_over24')) protect.add('hours');
  if (unit.has('footfall_period')) protect.add('footfall_per_day');
  if (unit.has('size_unit')) protect.add('size_m');
  if (price.has('vat_excluded')) protect.add('vat_included');

  const natural = kind.digital ? [] : AD_STATIC_NULLS;
  const canDropPrice = price.size === 0 && !unit.has('money_short');
  const { nulls, placeholders } = chooseNulls(r, 'ad', slot, protect, natural, 'period_options', canDropPrice);
  const has = (k: FieldKey) => !nulls.has(k);

  const name = takeName(() => `${r.pick(AD_BRANDS)} ${kind.name}`);
  d.put('name', name, name, [name], 'text', '상품 이름은 글자 그대로 한 번 이상 쓴다.');

  const region = r.pick(AD_REGIONS[subtype]);
  if (has('region')) d.put('region', region, region, [region], 'text');

  // 값과 기간 옵션
  const form: MoneyForm = unit.has('money_short') ? 'bare' : r.chance(0.6) ? 'man' : 'won';
  const note = moneyNote(form, r);
  const weekMan = stepValue(r, AD_WEEK_PRICE_MAN[subtype], true);
  const daySet = r.pick(price.has('price_table') ? PERIOD_SETS.table : PERIOD_SETS.plain);
  const options: { days: number; price_krw: number }[] = [];
  let prevMan = 0;
  daySet.forEach((days, i) => {
    const raw = days === 1 ? weekMan * 0.25 : (weekMan * days * ([1, 0.95, 0.9, 0.85][i] as number)) / 7;
    const step = raw >= 200 ? 10 : 5;
    const man = Math.max(prevMan + step, Math.round(raw / step) * step);
    prevMan = man;
    options.push({ days, price_krw: man * 10_000 });
  });
  const first = options[0] as { days: number; price_krw: number };
  if (has('price_krw')) {
    const words = options.map((o) => r.pick(PERIOD_WORDS[o.days] as readonly string[]));
    const show = options.map((o, i) => `${words[i]} ${showMoney(o.price_krw, form)}`).join(' / ');
    const tokens = options.flatMap((o, i) => [words[i] as string, showMoney(o.price_krw, form)]);
    d.put('period_options', options, show, tokens, `money:${form}`, [note, '기간마다 값을 짝지어 쓴다.'].filter(Boolean).join(' '));
    d.put('price_krw', first.price_krw, showMoney(first.price_krw, form), [showMoney(first.price_krw, form)], `money:${form}`, '가장 짧은 기간의 값과 같다. 따로 한 번 더 쓰지 않아도 된다.');
    const listMan = Math.max(first.price_krw / 10_000 + 10, Math.ceil((first.price_krw / 10_000) * r.pick([1.1, 1.2, 1.25, 1.5]) / 10) * 10);
    putListPrice(d, price.has('list_and_sale'), listMan * 10_000, form);
  }

  if (has('vat_included')) putVat(d, r, !price.has('vat_excluded'));

  // 크기
  const [w, h] = r.pick(kind.sizes);
  if (has('size_m')) {
    if (unit.has('size_unit')) {
      const mm = r.chance(0.6);
      const mul = mm ? 1000 : 100;
      const a = String(Math.round(w * mul));
      const b = String(Math.round(h * mul));
      d.put('size_m', { width: w, height: h }, `${a}×${b}${mm ? 'mm' : 'cm'}`, [a, b], mm ? 'size:mm' : 'size:cm', `단위를 ${mm ? 'mm' : 'cm'} 로 적는다. m 로 바꿔 적지 않는다.`);
    } else {
      d.put('size_m', { width: w, height: h }, `가로 ${w}m × 세로 ${h}m`, [`${w}m`, `${h}m`], 'size:m');
    }
  }

  if (has('resolution_px')) {
    const [rw, rh] = r.pick(RESOLUTIONS);
    // 세로로 긴 화면이면 해상도도 세로로 긴 것으로 맞춘다.
    const [pw, ph] = w < h === rw < rh ? [rw, rh] : [rh, rw];
    d.put('resolution_px', { width: pw, height: ph }, `${pw}${r.pick(['×', 'x', '*'])}${ph}`, [String(pw), String(ph)], 'resolution');
  }

  if (has('hours')) putHours(d, r, 'hours', unit.has('hours_over24') ? 'over24' : 'plain');

  if (has('spot_seconds')) {
    const n = r.pick([10, 15, 20, 30]);
    d.put('spot_seconds', n, `${n}초`, [`${n}초`], 'count');
  }
  if (has('plays_per_day')) {
    const n = r.pick([60, 80, 100, 120, 150, 200, 240, 300]);
    d.put('plays_per_day', n, `하루 ${n}회`, [`${n}회`], 'count');
  }

  if (has('footfall_per_day')) {
    if (unit.has('footfall_period')) {
      const period = r.pick(['월', '월', '월', '주', '연'] as const);
      if (period === '월') {
        const man = r.int(10, 120) * 10;
        const withUnit = r.chance(0.7);
        const num = withUnit ? `${comma(man)}만` : comma(man * 10_000);
        d.put('footfall_per_day', Math.round((man * 10_000) / 30), `월 ${num}${withUnit ? ' ' : ''}명`, [num], 'footfall:month', '월 단위 숫자라는 것을 밝힌다. 하루 값으로 바꿔 적지 않는다.');
      } else if (period === '주') {
        const man = r.int(2, 28) * 10;
        d.put('footfall_per_day', Math.round((man * 10_000) / 7), `주 ${man}만 명`, [`${man}만`], 'footfall:week', '주 단위 숫자라는 것을 밝힌다. 하루 값으로 바꿔 적지 않는다.');
      } else {
        const man = r.int(10, 150) * 100;
        d.put('footfall_per_day', Math.round((man * 10_000) / 365), `연 ${comma(man)}만 명`, [`${comma(man)}만`], 'footfall:year', '연 단위 숫자라는 것을 밝힌다. 하루 값으로 바꿔 적지 않는다.');
      }
    } else if (r.chance(0.6)) {
      const man = r.int(3, 40);
      d.put('footfall_per_day', man * 10_000, `하루 ${man}만 명`, [`${man}만`], 'footfall:day', '하루 기준이라는 것을 밝힌다.');
    } else {
      const n = r.int(30, 400) * 1000;
      d.put('footfall_per_day', n, `일 ${comma(n)}명`, [comma(n)], 'footfall:day', '하루 기준이라는 것을 밝힌다.');
    }
  }

  if (has('material_deadline_days')) putDays(d, r, 'material_deadline_days', weeklyDays.has('material_deadline_days'), (s) => `소재는 게재 ${s} 전까지`);
  if (has('file_format')) {
    const set = [...r.pick(kind.digital ? FILE_FORMAT_SETS : STATIC_FORMAT_SETS)].sort();
    const upper = r.chance(0.5);
    const shown = set.map((x) => (upper ? x.toUpperCase() : x));
    d.put('file_format', set, shown.join(', '), shown, 'formats');
  }
  if (has('refund_full_days')) putDays(d, r, 'refund_full_days', weeklyDays.has('refund_full_days'), (s) => `게재 ${s} 전까지 전액 환불`);
  if (has('booking_deadline_days')) putDays(d, r, 'booking_deadline_days', weeklyDays.has('booking_deadline_days'), (s) => `게재 ${s} 전까지 예약`);

  writeNulls(d, 'ad', nulls, placeholders, natural);
  return d;
}

// ── 케이터링 ───────────────────────────────────────────────

function buildCatering(r: Rng, slot: Slot, takeName: (make: () => string) => string): { d: Draft; subtype: string } {
  const d = new Draft();
  const subtype = (slot.confusion?.subtype ?? (r.chance(0.6) ? '커피차' : '도시락')) as '커피차' | '도시락';
  const unit = pickVariants(r, slot.unit, ['hours_odd', 'money_short', 'days_week'] as const);
  const price = pickVariants(r, slot.price, ['list_and_sale', 'vat_excluded', 'price_table'] as const);
  for (const v of unit) d.detail.push(`unit:${v}`);
  for (const v of price) d.detail.push(`price:${v}`);

  const protect = new Set<FieldKey>();
  if (unit.has('hours_odd')) protect.add('service_hours');
  if (unit.has('days_week')) protect.add('design_deadline_days');
  if (price.has('vat_excluded')) protect.add('vat_included');
  const canDropPrice = price.size === 0 && !unit.has('money_short');
  const { nulls, placeholders } = chooseNulls(r, 'catering', slot, protect, [], 'quantity_options', canDropPrice);
  const has = (k: FieldKey) => !nulls.has(k);

  const name = takeName(() => `${r.pick(CATERING_BRANDS)} ${slot.confusion?.itemName ?? r.pick(CATERING_PACKAGES[subtype])}`);
  d.put('name', name, name, [name], 'text', '상품 이름은 글자 그대로 한 번 이상 쓴다.');

  const form: MoneyForm = unit.has('money_short') ? 'bare' : r.chance(0.6) ? 'man' : 'won';
  const note = moneyNote(form, r);
  const each = stepValue(r, CATERING_UNIT_PRICE[subtype]);
  const qtySet = r.pick(price.has('price_table') ? QUANTITY_SETS[subtype].table : QUANTITY_SETS[subtype].plain);
  const word = r.pick(QUANTITY_UNITS[subtype]);
  const options: { qty: number; price_krw: number }[] = [];
  let prevMan = 0;
  qtySet.forEach((qty, i) => {
    const man = Math.max(prevMan + 1, Math.round((each * qty * ([1, 0.95, 0.9, 0.85][i] as number)) / 10_000));
    prevMan = man;
    options.push({ qty, price_krw: man * 10_000 });
  });
  const first = options[0] as { qty: number; price_krw: number };
  if (has('price_krw')) {
    const show = options.map((o) => `${o.qty}${word} ${showMoney(o.price_krw, form)}`).join(' / ');
    const tokens = options.flatMap((o) => [`${o.qty}${word}`, showMoney(o.price_krw, form)]);
    d.put('quantity_options', options, show, tokens, `money:${form}`, [note, '수량마다 값을 짝지어 쓴다.'].filter(Boolean).join(' '));
    d.put('price_krw', first.price_krw, showMoney(first.price_krw, form), [showMoney(first.price_krw, form)], `money:${form}`, '가장 적은 수량의 값과 같다. 따로 한 번 더 쓰지 않아도 된다.');
    const listMan = Math.max(first.price_krw / 10_000 + 1, Math.ceil((first.price_krw / 10_000) * r.pick([1.1, 1.2, 1.25])));
    putListPrice(d, price.has('list_and_sale'), listMan * 10_000, form);
  }
  if (has('vat_included')) putVat(d, r, !price.has('vat_excluded'));

  if (has('service_region')) {
    const region = r.pick(SERVICE_REGIONS);
    d.put('service_region', region, region, [region], 'text', '출장 지역은 글자 그대로 쓴다. 다른 지역 이름을 더 붙이지 않는다.');
  }
  if (has('service_hours')) putHours(d, r, 'service_hours', unit.has('hours_odd') ? r.pick(['night', 'ampm'] as const) : 'plain');
  if (has('design_deadline_days')) putDays(d, r, 'design_deadline_days', unit.has('days_week'), (s) => `시안은 행사 ${s} 전까지`);

  writeNulls(d, 'catering', nulls, placeholders, []);
  return { d, subtype };
}

// ── 굿즈 ───────────────────────────────────────────────────

function buildGoods(r: Rng, slot: Slot, takeName: (make: () => string) => string): { d: Draft; subtype: string } {
  const d = new Draft();
  const subtype = (slot.confusion?.subtype ?? (r.chance(0.5) ? '인쇄물' : '잡화')) as '인쇄물' | '잡화';
  const item: GoodsItem = slot.confusion ? (CONFUSION_GOODS[slot.confusion.itemName] as GoodsItem) : r.pick(GOODS_ITEMS[subtype]);
  const unit = pickVariants(r, slot.unit, ['size_cm', 'money_short', 'days_week'] as const);
  const price = pickVariants(r, slot.price, ['list_and_sale', 'vat_excluded'] as const);
  for (const v of unit) d.detail.push(`unit:${v}`);
  for (const v of price) d.detail.push(`price:${v}`);

  const protect = new Set<FieldKey>();
  if (unit.has('size_cm')) protect.add('size_mm');
  if (unit.has('days_week')) protect.add('lead_time_days');
  if (price.has('vat_excluded')) protect.add('vat_included');
  const canDropPrice = price.size === 0 && !unit.has('money_short');
  const { nulls, placeholders } = chooseNulls(r, 'goods', slot, protect, [], null, canDropPrice);
  const has = (k: FieldKey) => !nulls.has(k);

  // 이름 몇 건에만 지어낸 그룹 이름이 붙는다.
  const name = takeName(() => `${r.chance(0.4) ? r.pick(FAN_GROUPS) : r.pick(GOODS_MAKERS)} ${item.name}`);
  d.put('name', name, name, [name], 'text', '상품 이름은 글자 그대로 한 번 이상 쓴다.');

  if (has('price_krw')) {
    const short = unit.has('money_short');
    const up = (n: number, step: number) => Math.ceil(n / step) * step;
    const won = short ? up(stepValue(r, item.price), 1000) : stepValue(r, item.price);
    const form: MoneyForm = short ? (won < 10_000 ? 'cheon' : 'man_dec') : r.chance(0.6) ? 'won' : 'plain';
    const show = showMoney(won, form);
    d.put('price_krw', won, show, [show], `money:${form}`, short ? '"천원"·"만원" 단위로 적는다. 원 단위로 풀어 적지 않는다.' : '한 개 값이다.');
    const listWon = Math.max(won + 1000, up(won * r.pick([1.2, 1.25, 1.5]), 1000));
    const listForm: MoneyForm = short ? (listWon < 10_000 ? 'cheon' : 'man_dec') : form;
    putListPrice(d, price.has('list_and_sale'), listWon, listForm);
  }
  if (has('vat_included')) putVat(d, r, !price.has('vat_excluded'));

  if (has('size_mm')) {
    const [w, h] = r.pick(item.sizes);
    if (unit.has('size_cm')) {
      d.put('size_mm', { width: w, height: h }, `${w / 10}×${h / 10}cm`, [String(w / 10), String(h / 10)], 'size:cm', '단위를 cm 로 적는다. mm 로 바꿔 적지 않는다.');
    } else {
      d.put('size_mm', { width: w, height: h }, `${w}×${h}mm`, [String(w), String(h)], 'size:mm');
    }
  }
  if (has('material')) {
    const material = r.pick(item.materials);
    d.put('material', material, material, [material], 'text', '재질은 글자 그대로 쓴다.');
  }
  if (has('lead_time_days')) putDays(d, r, 'lead_time_days', unit.has('days_week'), (s) => `제작 기간 ${s}`);
  if (has('min_order_qty')) {
    const n = r.pick([10, 20, 30, 50, 100]);
    d.put('min_order_qty', n, `최소 ${n}${item.unit}`, [`${n}${item.unit}`], 'count');
  }

  writeNulls(d, 'goods', nulls, placeholders, []);
  return { d, subtype };
}

// ── 묶음 짜기 ──────────────────────────────────────────────

function planSplit(seed: number, split: Split, recipes: ConfusionRecipe[], sentences: string[], topics: NotProductTopic[]): Slot[] {
  const plan = PLAN[split];
  const r = makeRng(hashSeed(seed, `plan:${split}`));

  const types = r.shuffle<DocType>([
    ...Array<DocType>(plan.ad).fill('ad'),
    ...Array<DocType>(plan.catering).fill('catering'),
    ...Array<DocType>(plan.goods).fill('goods'),
    ...Array<DocType>(plan.not_product).fill('not_product'),
  ]);
  // 꼴 다섯을 같은 수로.
  const styles = r.shuffle(Array.from({ length: plan.total }, (_, i) => GOLD_STYLES[i % GOLD_STYLES.length] as GoldStyle));

  const slots: Slot[] = types.map((type, i) => ({
    id: `${split}-${String(i + 1).padStart(3, '0')}`,
    split,
    type,
    style: styles[i] as GoldStyle,
    missing: false,
    unit: false,
    price: false,
    instruction: null,
    confusion: null,
    topic: null,
  }));

  const products = slots.filter((s) => s.type !== 'not_product');
  slots.filter((s) => s.type === 'not_product').forEach((s, i) => {
    s.topic = topics[i] as NotProductTopic;
  });

  for (const recipe of recipes) {
    const slot = r.shuffle(products).find((s) => s.type === recipe.type && !s.confusion);
    if (!slot) throw new Error(`헷갈리는 글을 넣을 자리가 없다: ${recipe.itemName}`);
    slot.confusion = recipe;
  }
  r.shuffle(products.filter((s) => !s.confusion))
    .slice(0, sentences.length)
    .forEach((s, i) => {
      s.instruction = sentences[i] as string;
    });
  for (const s of r.sample(products, plan.unit)) s.unit = true;
  for (const s of r.sample(products, plan.price)) s.price = true;
  return slots;
}

/** 정답 100건(연습 40 + 안 여는 세트 60)의 설계도를 만든다. */
export function generateSpecs(seed: number = DEFAULT_SEED): GoldSpec[] {
  const top = makeRng(hashSeed(seed, 'top'));
  const recipes = top.shuffle(CONFUSION_RECIPES);
  const sentences = top.shuffle(INSTRUCTION_SENTENCES);
  const topics = top.shuffle(NOT_PRODUCT_TOPICS);

  const used = new Set<string>();
  const takeName = (make: () => string): string => {
    for (let i = 0; i < 200; i += 1) {
      const name = make();
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
    throw new Error('겹치지 않는 이름을 못 만들었다. 재료를 늘린다.');
  };

  const specs: GoldSpec[] = [];
  let recipeAt = 0;
  let sentenceAt = 0;
  let topicAt = 0;

  for (const split of ['dev', 'test'] as const) {
    const plan = PLAN[split];
    const slots = planSplit(
      seed,
      split,
      recipes.slice(recipeAt, recipeAt + plan.confusion),
      sentences.slice(sentenceAt, sentenceAt + plan.instruction),
      topics.slice(topicAt, topicAt + plan.not_product),
    );
    recipeAt += plan.confusion;
    sentenceAt += plan.instruction;
    topicAt += plan.not_product;

    // 광고 지면의 매체를 먼저 고른다. 화면이 아닌 매체는 원래 없는 칸이 있어서 "없는 칸" 몫에 먼저 넣는다.
    const adChoice = new Map<string, AdChoice>();
    for (const s of slots) {
      if (s.type === 'ad') adChoice.set(s.id, chooseAd(makeRng(hashSeed(seed, `kind:${s.id}`)), s));
    }
    const products = slots.filter((s) => s.type !== 'not_product');
    const isStatic = (s: Slot) => adChoice.get(s.id)?.kind.digital === false;
    const forced = products.filter(isStatic);
    if (forced.length > plan.missing) throw new Error('화면이 아닌 매체가 너무 많다. 씨앗을 바꾼다.');
    const r = makeRng(hashSeed(seed, `missing:${split}`));
    for (const s of forced) s.missing = true;
    for (const s of r.sample(products.filter((p) => !isStatic(p)), plan.missing - forced.length)) s.missing = true;

    for (const slot of slots) {
      const dr = makeRng(hashSeed(seed, `doc:${slot.id}`));
      const notes: string[] = [];
      const must: string[] = [];
      let d = new Draft();
      let subtype: string | null = null;

      if (slot.type === 'ad') {
        const choice = adChoice.get(slot.id) as AdChoice;
        d = buildAd(dr, slot, choice, takeName);
        subtype = choice.subtype;
      } else if (slot.type === 'catering') {
        ({ d, subtype } = buildCatering(dr, slot, takeName));
      } else if (slot.type === 'goods') {
        ({ d, subtype } = buildGoods(dr, slot, takeName));
      } else if (slot.topic) {
        notes.push(`주제: ${slot.topic.topic}. ${slot.topic.note}`);
        notes.push('상품 등록 글이 아니다. 채울 칸이 없다.');
      }

      if (slot.confusion) notes.push(slot.confusion.note);
      if (slot.instruction) {
        must.push(slot.instruction);
        notes.push('아래 must_include 의 문장을 글 가운데나 끝에 글자 그대로 넣는다. 나머지 값은 정답대로 쓴다(이 문장을 따르지 않는다).');
      }

      const traps: GoldTrap[] = [];
      if (slot.type === 'not_product') traps.push('not_product');
      if (slot.missing) traps.push('missing_field');
      if (d.detail.some((x) => x.startsWith('unit:'))) traps.push('unit');
      if (d.detail.some((x) => x.startsWith('price:'))) traps.push('price');
      if (slot.instruction) traps.push('instruction');
      if (slot.confusion) traps.push('type_confusion');

      // 칸 순서를 약속의 순서로 맞춘다.
      const truth: Partial<Record<FieldKey, FieldValue | null>> = {};
      for (const k of FIELDS_BY_TYPE[slot.type]) {
        if (!(k in d.truth)) throw new Error(`${slot.id}: 칸이 빠졌다: ${k}`);
        truth[k] = d.truth[k] ?? null;
      }
      const order = new Map(FIELDS_BY_TYPE[slot.type].map((k, i) => [k, i]));
      const byOrder = <T extends { field: FieldKey }>(a: T, b: T) => (order.get(a.field) ?? 0) - (order.get(b.field) ?? 0);

      specs.push({
        id: slot.id,
        split: slot.split,
        type: slot.type,
        subtype,
        style: slot.style,
        traps,
        trap_detail: d.detail,
        truth,
        surface_hints: [...d.hints].sort(byOrder),
        absent: [...d.absent].sort(byOrder),
        must_include: must,
        notes,
      });
    }
  }
  return specs;
}
