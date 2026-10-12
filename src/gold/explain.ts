// 환산 한 줄: 원문 표기와 정답 값의 꼴이 다를 때, 어떻게 바뀌는지 칸 아래에 한 줄로 적는다.
// 화면이 값을 새로 정하지 않는다. 정답에서 거꾸로 셈해(정답 × 30, 정답 ÷ 10,000 …) 그 수가 표기에 글자로 있을 때만 적는다.
// 맞아떨어지지 않거나 확신이 없으면 아무것도 적지 않는다(null). 그러면 사람이 표기와 정답을 직접 견준다.
// 브라우저에서도 도는 순수 함수만 둔다.
import { fieldDef, type FieldKey, type FieldValue, type Hours } from '@/contract/fields';

export interface ExplainHint {
  /** 원문에 글자 그대로 들어간 조각들 */
  tokens: readonly string[];
  /** 수 옆에 단위를 붙이지 않는 표기에서 그 수의 단위("만원", "천원", "m", "cm", "mm") */
  unit?: string;
  /** 그 단위를 글 다른 곳에 밝혔는가. false 면 일부러 밝히지 않은 표기다. */
  declareUnit?: boolean;
}

/** 1500000 → "1,500,000". 소수는 그대로 둔다. */
export function comma(n: number): string {
  const [i, d] = String(n).split('.');
  return `${(i as string).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${d ? `.${d}` : ''}`;
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;

/** 표기 안의 수 하나 */
interface Num {
  n: number;
  /** 적힌 글자 그대로 */
  raw: string;
  start: number;
  end: number;
  /** 수 바로 뒤에 붙은 큰 단위(만, 천 …). 없으면 빈 글 */
  scale: string;
  /** 수와 큰 단위를 함께 적은 글자. "150만" */
  label: string;
}

const NUM_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
const SCALE_RE = /^\s*(억|백만|만|万|천|千|million)/i;
const MUL: Record<string, number> = { 억: 100_000_000, 백만: 1_000_000, million: 1_000_000, 만: 10_000, 万: 10_000, 천: 1_000, 千: 1_000 };

function numbersIn(text: string): Num[] {
  const out: Num[] = [];
  for (const m of text.matchAll(NUM_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    const scale = SCALE_RE.exec(text.slice(end));
    out.push({
      n: Number(m[0].replace(/,/g, '')),
      raw: m[0],
      start,
      end,
      scale: scale ? (scale[1] as string).toLowerCase() : '',
      label: scale ? text.slice(start, end + scale[0].length) : m[0],
    });
  }
  return out;
}

const scaled = (x: Num) => x.n * (MUL[x.scale] ?? 1);

// ── 금액 ───────────────────────────────────────────────────

/** 금액 하나가 표기에서 어떻게 원 단위가 되는지. 같은 꼴이거나 설명하지 못하면 null. */
function moneyPart(nums: readonly Num[], won: number, unit: string | undefined): string | null {
  if (unit === '만원' || unit === '천원') {
    const mul = unit === '만원' ? 10_000 : 1_000;
    const hit = nums.find((x) => x.scale === '' && near(x.n * mul, won));
    return hit ? `${hit.raw} × ${comma(mul)} = ${comma(won)}원` : null;
  }
  if (nums.some((x) => x.scale === '' && x.n === won)) return null;
  const one = nums.find((x) => x.scale !== '' && near(scaled(x), won));
  if (one) return `${one.label} = ${one.raw} × ${comma(MUL[one.scale] as number)} = ${comma(won)}원`;
  // "1만 2천원"처럼 큰 단위 둘을 이어 적은 꼴
  for (const a of nums) {
    if (a.scale !== '만' && a.scale !== '万') continue;
    const b = nums.find((x) => (x.scale === '천' || x.scale === '千') && x.start > a.end && near(scaled(a) + scaled(x), won));
    if (b) return `${a.label} ${b.label} = ${comma(scaled(a))} + ${comma(scaled(b))} = ${comma(won)}원`;
  }
  return null;
}

/** 수 옆에 단위가 없는 표기라는 것을 알리는 말 */
function bareNote(unit: string, declared: boolean | undefined): string {
  return declared === false ? `단위를 글에 밝히지 않은 수 — 정답은 ${unit} 단위로 읽음` : `수 옆에 단위가 없음 — 글 다른 곳에 밝힌 단위(${unit})로 읽음`;
}

// ── 일수 ───────────────────────────────────────────────────

/** 일수 하나가 표기에서 어떻게 날 수가 되는지. "7일"처럼 같은 꼴이거나 설명하지 못하면 null. */
function daysPart(text: string, nums: readonly Num[], days: number): string | null {
  const after = (x: Num) => text.slice(x.end);
  const dm = /D\s*-\s*(\d+)/.exec(text);
  if (dm && Number(dm[1]) === days) return `D-${days} = ${days}일 전`;
  const hour = nums.find((x) => x.n === days * 24 && /^\s*시간/.test(after(x)));
  if (hour) return `${hour.raw}시간 ÷ 24 = ${days}일`;
  const plain = nums.some((x) => x.n === days && /^\s*(영업일|일|天|days?)/i.test(after(x)));
  if (plain) return /영업일/.test(text) ? `영업일도 달력 날짜로 바꾸지 않고 적힌 수 그대로 ${days}일` : null;
  if (days % 7 === 0) {
    for (const x of nums) {
      const m = /^\s*(주일|주|周|weeks?)/i.exec(after(x));
      if (!m || x.n !== days / 7) continue;
      const label = text.slice(x.start, x.end + m[0].length);
      return x.n === 1 ? `${label} = 7일` : `${label} = ${x.raw} × 7일 = ${days}일`;
    }
  }
  if (days % 30 === 0) {
    for (const x of nums) {
      const m = /^\s*(개월|달|个月|months?)/i.exec(after(x));
      if (!m || x.n !== days / 30) continue;
      const label = text.slice(x.start, x.end + m[0].length);
      return x.n === 1 ? `${label} = 30일` : `${label} = ${x.raw} × 30일 = ${days}일`;
    }
  }
  if (days === 30 && /한\s*달/.test(text)) return '한 달 = 30일';
  if (days === 15 && /보름/.test(text)) return '보름 = 15일';
  return null;
}

// ── 하루 유동인구 ──────────────────────────────────────────

const PERIODS: readonly { days: number; word: RegExp; label: string }[] = [
  { days: 30, word: /월|달|month|月/i, label: '월' },
  { days: 7, word: /주|week|周/i, label: '주' },
  { days: 365, word: /연|년|year|年/i, label: '연' },
];

function footfallLine(text: string, nums: readonly Num[], perDay: number): string | null {
  const day = nums.find((x) => near(scaled(x), perDay));
  if (day) return day.scale === '' ? null : `${day.label} = ${day.raw} × ${comma(MUL[day.scale] as number)} = ${comma(perDay)}명`;
  for (const x of nums) {
    const total = Math.round(scaled(x));
    if (!near(total, scaled(x))) continue;
    for (const p of PERIODS) {
      if (!p.word.test(text) || Math.round(total / p.days) !== perDay) continue;
      const head = x.scale === '' ? '' : `${x.label} = ${comma(total)}명, `;
      const exact = total % p.days === 0;
      const result = exact ? comma(perDay) : `${comma(Math.trunc(total / p.days))}.${Math.trunc(((total / p.days) % 1) * 10)}… → 반올림 ${comma(perDay)}`;
      return `${head}${p.label} ${comma(total)} ÷ ${p.days} = ${result}명`;
    }
  }
  return null;
}

// ── 운영 시간 ──────────────────────────────────────────────

const PM_WORD = '오후|저녁|밤|PM|下午|晚上';

function hoursLine(text: string, nums: readonly Num[], v: Hours): string | null {
  const [oh, om] = v.open.split(':').map(Number) as [number, number];
  const [ch, cm] = v.close.split(':').map(Number) as [number, number];
  if (v.open === '00:00' && v.close === '00:00' && v.nextDay) return /24/.test(text) ? '24시간 운영 — 정답은 00:00 ~ 다음 날 00:00 으로 적음' : null;

  const parts: string[] = [];
  if (v.nextDay) {
    const over = cm === 0 ? nums.find((x) => x.n === ch + 24) : undefined;
    const mark = /익일|다음\s*날|next day|次日|翌日/i.exec(text);
    // 정답의 끝 시각이 표기에 그 수로 적혀 있을 때만 설명한다.
    const hasClose = nums.some((x) => x.n === ch);
    if (over) parts.push(`${over.raw}${/^\s*:/.test(text.slice(over.end)) ? ':00' : '시'} = 다음 날 ${v.close}`);
    else if (mark && hasClose) parts.push(`"${mark[0]}" = 끝 시각 ${v.close} 이 다음 날`);
    else if (v.close === '00:00' && /자정|midnight/i.test(text)) parts.push('자정 = 다음 날 00:00');
    else if (hasClose && nums.some((x) => x.n === oh) && ch * 60 + cm <= oh * 60 + om) parts.push(`끝(${v.close})이 시작(${v.open})보다 이르거나 같음 → 끝을 다음 날로 봄`);
    else return null;
  }
  // 오후·저녁·밤·PM 으로 적은 시각
  for (const [h, hhmm] of [[oh, v.open], [ch, v.close]] as const) {
    if (h < 13) continue;
    const h12 = h - 12;
    const pre = new RegExp(`(${PM_WORD})\\s*${h12}(?!\\d)`, 'i').exec(text);
    const post = new RegExp(`(?:^|[^\\d:])${h12}(?::00)?\\s*pm`, 'i').test(text);
    if (pre) parts.push(`${pre[1]} ${h12}시 = ${hhmm}`);
    else if (post) parts.push(`${h12} PM = ${hhmm}`);
  }
  return parts.length > 0 ? [...new Set(parts)].join(' · ') : null;
}

// ── 크기 ───────────────────────────────────────────────────

const WIDTH = /가로|폭|너비|宽|\bW\b|wide|width/;
const HEIGHT = /세로|높이|高|\bH\b|high|height|tall/;
const side = (s: string) => (WIDTH.test(s) && !HEIGHT.test(s) ? 'w' : HEIGHT.test(s) && !WIDTH.test(s) ? 'h' : '');

/** 표준 단위 1 이 적힌 단위로 몇인가 */
const PER_BASE: Record<'size_m' | 'size_mm', Record<string, number>> = {
  size_m: { m: 1, cm: 100, mm: 1000 },
  size_mm: { mm: 1, cm: 0.1, m: 0.001 },
};

function sizeLine(kind: 'size_m' | 'size_mm', text: string, nums: readonly Num[], v: { width: number; height: number }, hint: ExplainHint): string | null {
  const base = kind === 'size_m' ? 'm' : 'mm';
  const written = hint.unit ?? (/mm|㎜|毫米|밀리/i.test(text) ? 'mm' : /cm|㎝|厘米|센티/i.test(text) ? 'cm' : /\d\s*m(?![a-zA-Z])|미터|米/.test(text) ? 'm' : '');
  const per = PER_BASE[kind][written];
  if (per === undefined || nums.length !== 2) return null;
  const [first, second] = nums as [Num, Num];
  const [a, b] = [v.width * per, v.height * per];
  const forward = near(first.n, a) && near(second.n, b);
  const reversed = !forward && near(first.n, b) && near(second.n, a);
  if (!forward && !reversed) return null;
  const firstSide = side(text.slice(0, first.start)) || side(text.slice(first.end, second.start));
  // 낱말이 가리키는 쪽과 수의 차례가 어긋나면 설명하지 않는다.
  if (reversed !== (firstSide === 'h')) return null;

  const parts: string[] = [];
  if (written !== base) {
    const [x, y] = forward ? [v.width, v.height] : [v.height, v.width];
    parts.push(`${first.raw}${written} = ${comma(x)}${base}, ${second.raw}${written} = ${comma(y)}${base}`);
  }
  if (reversed) parts.push(`표기는 세로가 먼저 — 정답은 가로 ${comma(v.width)}, 세로 ${comma(v.height)}`);
  if (hint.unit) parts.push(bareNote(hint.unit, hint.declareUnit));
  return parts.length > 0 ? parts.join(' · ') : null;
}

// ── 그 밖 ──────────────────────────────────────────────────

function optionsLine(key: 'days' | 'qty', text: string, nums: readonly Num[], options: readonly { days?: number; qty?: number; price_krw: number }[], hint: ExplainHint): string | null {
  const spans = key === 'days' ? options.map((o) => daysPart(text, nums, o.days as number)) : [];
  const prices = options.map((o) => moneyPart(nums, o.price_krw, hint.unit));
  const parts = [...new Set([...spans, ...prices].filter((p): p is string => p !== null))];
  if (parts.length === 0) return null;
  if (hint.unit && prices.some((p) => p !== null)) parts.push(bareNote(hint.unit, hint.declareUnit));
  return parts.join(' · ');
}

function formatsLine(text: string, list: readonly string[]): string | null {
  const parts: string[] = [];
  if (list.includes('jpg') && /jpeg/i.test(text)) parts.push('JPEG 은 jpg 와 같은 형식 — 정답에는 jpg 로 적음');
  if (list.includes('tif') && /tiff/i.test(text)) parts.push('TIFF 는 tif 와 같은 형식 — 정답에는 tif 로 적음');
  return parts.length > 0 ? parts.join(' · ') : null;
}

function vatLine(text: string, included: boolean): string | null {
  if (!included) {
    const m = /미포함|excl\w*\.?|不含税?/i.exec(text);
    return m ? `"${m[0]}" = 별도` : null;
  }
  if (/미포함|별도|excl|不含/i.test(text)) return null;
  const m = /incl\w*\.?|含税?/i.exec(text);
  return m ? `"${m[0]}" = 포함` : null;
}

/**
 * 칸 하나의 환산 한 줄. 표기와 정답의 꼴이 같거나, 기계가 확신하지 못하면 null.
 * value 는 지금 화면에 보이는 정답 값이다.
 */
export function explainField(key: FieldKey, value: FieldValue | null | undefined, hint: ExplainHint | undefined): string | null {
  if (value === null || value === undefined || !hint || hint.tokens.length === 0) return null;
  const text = hint.tokens.join('\n');
  const nums = numbersIn(text);
  const unit = hint.unit;
  switch (fieldDef(key).kind) {
    case 'money': {
      const part = moneyPart(nums, value as number, unit);
      if (part === null) return null;
      return unit ? `${bareNote(unit, hint.declareUnit)}: ${part}` : part;
    }
    case 'days':
      return daysPart(text, nums, value as number);
    case 'footfall':
      return footfallLine(text, nums, value as number);
    case 'hours':
      return hoursLine(text, nums, value as Hours);
    case 'size_m':
      return sizeLine('size_m', text, nums, value as { width: number; height: number }, hint);
    case 'size_mm':
      return sizeLine('size_mm', text, nums, value as { width: number; height: number }, hint);
    case 'period_options':
      return optionsLine('days', text, nums, value as { days: number; price_krw: number }[], hint);
    case 'quantity_options':
      return optionsLine('qty', text, nums, value as { qty: number; price_krw: number }[], hint);
    case 'formats':
      return formatsLine(text, value as string[]);
    case 'bool':
      return vatLine(text, value as boolean);
    default:
      return null;
  }
}

// ── 늘 보이는 규칙 ─────────────────────────────────────────
// 사람이 헷갈리기 쉬운 일치 규칙을 칸 아래에 작은 글씨로 적는다. 글은 docs/EVAL-SPEC.md 5절(과 그 덧붙임)에 있는 것만 옮겼다.

const TEXT_RULE = '글자가 완전히 같아야 맞음. 한쪽이 다른 쪽을 품기만 해도(더 길거나 짧게 적은 것) 틀림. 띄어쓰기·괄호 글자·영문 대소문자는 지우고 견줌.';
const MONEY_RULE = '원문에 적힌 금액 그대로. 부가세를 더하거나 빼지 않음.';
const DAYS_RULE = '1주 = 7일, 1개월 = 30일.';
const PAIR_RULE = '쌍의 순서는 보지 않음. 쌍 안의 금액은 허용 오차 없음.';

export const FIELD_RULES: Partial<Record<FieldKey, string>> = {
  name: TEXT_RULE,
  region: TEXT_RULE,
  service_region: TEXT_RULE,
  material: TEXT_RULE,
  price_krw: `대표 판매가. 옵션이 있으면 가장 짧은 기간(가장 적은 수량) 옵션의 값. ${MONEY_RULE}`,
  list_price_krw: MONEY_RULE,
  vat_included: '부가세가 들었는지는 이 칸으로만 따로 봄. 금액 칸에는 더하거나 빼지 않음.',
  footfall_per_day: '하루 값으로 바꿈: 월 ÷ 30, 주 ÷ 7, 연 ÷ 365, 소수는 반올림.',
  period_options: `${DAYS_RULE} ${PAIR_RULE}`,
  quantity_options: PAIR_RULE,
  material_deadline_days: DAYS_RULE,
  refund_full_days: DAYS_RULE,
  booking_deadline_days: DAYS_RULE,
  design_deadline_days: DAYS_RULE,
  lead_time_days: DAYS_RULE,
  file_format: 'JPEG 과 jpg 는 같은 것으로 칩니다(소문자, jpeg → jpg). tiff 도 tif 로 칩니다. 앞의 점은 떼고, 순서는 보지 않음.',
};
