// 검산. 원문에 적을 표기(show)를 다시 읽어 표준 값으로 바꾼다.
// 정답을 만드는 쪽(forms.ts 의 꼴)과 다른 길로 계산한다: 꼴 이름을 보지 않고 글자만 읽는다.
// (단, 수 옆에 단위가 없는 꼴은 글 다른 곳에 밝힌 단위 hint.unit 을 받는다.)
// 표기와 정답 값이 어긋나면 시험이 잡는다. 맞추기 코어(src/core)와는 따로 둔 작은 함수다. 정답 도구만 쓴다.
import { fieldDef, type FieldValue, type Hours } from '@/contract/fields';
import type { SurfaceHint } from './spec';

const pad = (n: number) => String(n).padStart(2, '0');
const toNum = (s: string) => Number(s.replace(/,/g, ''));

/** 수 하나. "1,500,000" "8,000" "4.5" */
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const SCALED = String.raw`(${NUM})\s*(억|백만|만|万|천|千|million)?`;

function scale(unit: string | undefined): number {
  switch (unit?.toLowerCase()) {
    case '억':
      return 100_000_000;
    case '백만':
    case 'million':
      return 1_000_000;
    case '만':
    case '万':
      return 10_000;
    case '천':
    case '千':
      return 1_000;
    default:
      return 1;
  }
}

/** "1,500,000" "150만" "3,000만" "1.2억" "250万" "2.5 million" 같은 수를 읽는다. */
export function readNumber(text: string): number {
  const m = new RegExp(SCALED, 'i').exec(text);
  if (!m) throw new Error(`수를 못 읽음: ${text}`);
  return Math.round(toNum(m[1] as string) * scale(m[2]));
}

/** 금액 하나를 찾는 틀. "1만 2천원"처럼 큰 단위 뒤에 작은 단위가 이어지는 것까지 한 덩어리로 본다. */
const MONEY = String.raw`(?:₩|￦|KRW\s*)?(?:(?:${NUM})\s*억(?:[ ]?(?:${NUM})\s*만)?|(?:${NUM})\s*만(?:[ ]?\d\s*천)?|(?:${NUM})(?:\s*(?:백만|万|천|千|million))?)\s*(?:원|韩元|KRW|won)?`;

/**
 * 금액. unit 은 수 옆에 단위가 없는 꼴("150")에서 글 다른 곳에 밝힌 단위다("만원" | "천원").
 * 옛 이름 "money:bare" 도 만원 단위로 받는다.
 */
export function readMoney(show: string, unit?: string): number {
  const body = show.replace(/₩|￦|KRW|韩元|won/gi, ' ');
  const pieces = [...body.matchAll(new RegExp(SCALED, 'gi'))];
  if (pieces.length === 0) throw new Error(`금액을 못 읽음: ${show}`);
  if (!pieces.some((p) => p[2])) {
    if (pieces.length !== 1) throw new Error(`금액이 둘 이상: ${show}`);
    const mul = unit === '만원' || unit === 'money:bare' ? 10_000 : unit === '천원' ? 1_000 : 1;
    return Math.round(toNum(pieces[0]?.[1] as string) * mul);
  }
  // "1만 2천" → 12,000. 단위가 붙은 조각을 더한다.
  return Math.round(pieces.reduce((sum, p) => sum + toNum(p[1] as string) * scale(p[2]), 0));
}

const DAY_SPAN = String.raw`(\d+)\s*(영업일|일|天|days?|주일|주|周|weeks?|개월|달|个月|months?)`;

function spanDays(n: number, unit: string): number {
  const x = unit.toLowerCase();
  if (/^(영업일|일|天|days?)$/.test(x)) return n;
  if (/^(개월|달|个月|months?)$/.test(x)) return n * 30;
  return n * 7;
}

/**
 * "7일" "2주" "1개월" "한 달" "D-14" "72시간" "2 weeks" "提前7天" → 일수.
 * 1주 = 7일, 1개월 = 30일, 보름 = 15일. 시간은 24로 나누어떨어질 때만. 영업일은 적힌 수 그대로.
 */
export function readDays(show: string): number {
  const dm = /D\s*-\s*(\d+)/.exec(show);
  if (dm) return Number(dm[1]);
  const hm = /(\d+)\s*시간/.exec(show);
  if (hm) {
    const h = Number(hm[1]);
    if (h % 24 !== 0) throw new Error(`24로 나누어떨어지지 않는 시간: ${show}`);
    return h / 24;
  }
  if (/한\s*달/.test(show)) return 30;
  if (/보름/.test(show)) return 15;
  const m = new RegExp(DAY_SPAN, 'i').exec(show);
  if (!m) throw new Error(`기간을 못 읽음: ${show}`);
  return spanDays(Number(m[1]), m[2] as string);
}

const AM_WORDS = /^(오전|새벽|아침|am|早上|上午|凌晨)$/i;
const PM_WORDS = /^(오후|저녁|밤|pm|下午|晚上)$/i;
const NOON_WORDS = /^(낮|中午)$/;
const TIME = String.raw`(오전|오후|새벽|아침|낮|저녁|밤|AM|PM|早上|上午|中午|下午|晚上|凌晨)?\s*(?:(자정|midnight)|(정오|noon)|(\d{1,2})(?:\s*(?::|시|点)\s*(\d{2})?\s*분?)?\s*(AM|PM)?)`;

/**
 * 운영 시간 → 시작·끝·다음 날 여부.
 * "05시~25시" "06:00~24:00" "오전 10시~오후 2시" "05:00-01:00(익일)" "오전 5시부터 다음날 새벽 1시까지" "6am-10pm" "24시간"
 */
export function readHours(show: string): Hours {
  if (/24\s*(시간|H\b|hrs?\b|hours?\b|小时)/i.test(show)) return { open: '00:00', close: '00:00', nextDay: true };
  const found = [...show.matchAll(new RegExp(TIME, 'gi'))];
  if (found.length < 2) throw new Error(`시간을 못 읽음: ${show}`);
  const hourOf = (m: RegExpMatchArray, isClose: boolean): [number, number] => {
    if (m[2]) return [isClose ? 24 : 0, 0];
    if (m[3]) return [12, 0];
    const mark = m[1] ?? m[6] ?? '';
    let h = Number(m[4]);
    if (PM_WORDS.test(mark)) h = h === 12 && mark === '밤' ? 24 : h < 12 ? h + 12 : h;
    else if (AM_WORDS.test(mark)) h = h === 12 ? 0 : h;
    else if (NOON_WORDS.test(mark)) h = h < 6 ? h + 12 : h;
    return [h, Number(m[5] ?? 0)];
  };
  const [openH, openM] = hourOf(found[0] as RegExpMatchArray, false);
  const [rawCloseH, closeM] = hourOf(found[1] as RegExpMatchArray, true);
  let closeH = rawCloseH;
  let nextDay = /익일|다음\s*날|next day|次日|翌日/i.test(show);
  if (closeH >= 24) {
    closeH -= 24;
    nextDay = true;
  } else if (closeH * 60 + closeM <= openH * 60 + openM) {
    nextDay = true;
  }
  return { open: `${pad(openH)}:${pad(openM)}`, close: `${pad(closeH)}:${pad(closeM)}`, nextDay };
}

/** "월 250만 명" → 하루 값. 월은 30, 주는 7, 연은 365 로 나눠 반올림한다. */
export function readFootfall(show: string): number {
  // "1일 120,000명"의 1 은 사람 수가 아니다.
  const n = readNumber(show.replace(/(^|[^\d,.])1\s*(일|주|년|개월)/g, '$1$2'));
  if (/월|달|month|月/i.test(show)) return Math.round(n / 30);
  if (/주|week|周/i.test(show)) return Math.round(n / 7);
  if (/연|년|year|年/i.test(show)) return Math.round(n / 365);
  return n;
}

const WIDTH = /가로|폭|너비|宽|\bW\b|wide|width/;
const HEIGHT = /세로|높이|高|\bH\b|high|height|tall/;

/**
 * 크기 표기에서 가로·세로와 단위를 읽는다. 가로·세로를 가리키는 말이 있으면 그 말을 따르고, 없으면 앞이 가로다.
 * declared 는 수 옆에 단위가 없는 꼴("8X0.9")에서 글 다른 곳에 밝힌 단위다.
 */
export function readPair(show: string, declared = ''): { a: number; b: number; unit: string } {
  const nums = [...show.matchAll(new RegExp(NUM, 'g'))];
  if (nums.length !== 2) throw new Error(`수 둘을 못 읽음: ${show}`);
  const [n1, n2] = nums as [RegExpMatchArray, RegExpMatchArray];
  const before = show.slice(0, n1.index);
  const between = show.slice((n1.index as number) + n1[0].length, n2.index);
  const side = (s: string) => (WIDTH.test(s) && !HEIGHT.test(s) ? 'w' : HEIGHT.test(s) && !WIDTH.test(s) ? 'h' : '');
  // 말이 수 앞에 붙는 꼴("가로 8m × 세로 4.5m")이면 첫 수의 말은 맨 앞에, 뒤에 붙는 꼴("8m(W) × 4.5m(H)")이면 가운데에 있다.
  const first = side(before) || side(between);
  const unit = /mm|毫米|밀리/i.test(show) ? 'mm' : /cm|厘米|센티/i.test(show) ? 'cm' : /px|pixel|픽셀|像素/i.test(show) ? 'px' : /\d\s*m\b|미터|米/.test(show) ? 'm' : declared;
  const [x, y] = [toNum(n1[0]), toNum(n2[0])];
  return first === 'h' ? { a: y, b: x, unit } : { a: x, b: y, unit };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const PERIOD_WORD = String.raw`${DAY_SPAN}|한\s*달`;
const QTY_WORD = String.raw`(\d[\d,]*)\s*(?:잔|개|인분|cups?|boxes|servings?|杯|份)`;

/**
 * 값표. 기간(수량)을 적힌 차례로, 금액을 적힌 차례로 모아 같은 차례끼리 짝짓는다.
 * 그래서 "1주 150만원 / 2주 280만원", "150만원(1주) / 280만원(2주)", 기간 줄과 금액 줄이 따로인 표를 모두 읽는다.
 */
export function readOptions(show: string, unit: string | undefined, key: 'days' | 'qty') {
  const keys: number[] = [];
  const rest = show.replace(new RegExp(key === 'days' ? PERIOD_WORD : QTY_WORD, 'gi'), (hit) => {
    keys.push(key === 'days' ? readDays(hit) : readNumber(hit));
    return ' § ';
  });
  const prices = [...rest.matchAll(new RegExp(MONEY, 'gi'))].map((m) => readMoney(m[0], unit));
  if (keys.length === 0 || keys.length !== prices.length) throw new Error(`값표의 짝이 안 맞음: ${show}`);
  return keys.map((k, i) => (key === 'days' ? { days: k, price_krw: prices[i] as number } : { qty: k, price_krw: prices[i] as number }));
}

const FORMAT_ALIAS: Record<string, string> = { jpeg: 'jpg', tiff: 'tif' };

/** "JPG, MP4" ".jpg / .mp4" "JPEG 또는 MP4" → 소문자 확장자 목록(같은 형식의 다른 이름은 하나로) */
export function readFormats(show: string): string[] {
  const out = show
    .split(/[,/\s·、]+|또는|및/)
    .map((x) => x.replace(/^\*?\./, '').toLowerCase())
    .filter((x) => /^[a-z0-9]{2,4}$/.test(x) && x !== 'or' && x !== 'and')
    .map((x) => FORMAT_ALIAS[x] ?? x);
  return [...new Set(out)].sort();
}

/** 부가세가 들었는가. "별도" "미포함" "excl." "不含税" 은 아니다. */
export function readVat(show: string): boolean {
  if (/미포함|별도|excl|不含/i.test(show)) return false;
  if (/포함|incl|含/i.test(show)) return true;
  throw new Error(`부가세 표기를 못 읽음: ${show}`);
}

/** 횟수·개수. "1일 100회"의 1 은 횟수가 아니다. */
export function readCount(show: string): number {
  return readNumber(show.replace(/(^|[^\d,.])1\s*일/g, '$1일'));
}

/** 표기 하나를 표준 값으로. */
export function recalc(hint: SurfaceHint): FieldValue {
  const kind = fieldDef(hint.field).kind;
  const unit = hint.unit ?? (hint.form === 'money:bare' ? '만원' : undefined);
  switch (kind) {
    case 'text':
      return hint.show;
    case 'money':
      return readMoney(hint.show, unit);
    case 'bool':
      return readVat(hint.show);
    case 'count':
      return readCount(hint.show);
    case 'days':
      return readDays(hint.show);
    case 'footfall':
      return readFootfall(hint.show);
    case 'size_m': {
      const { a, b, unit: found } = readPair(hint.show, unit);
      const div = found === 'mm' ? 1000 : found === 'cm' ? 100 : 1;
      return { width: round2(a / div), height: round2(b / div) };
    }
    case 'size_mm': {
      const { a, b, unit: found } = readPair(hint.show, unit);
      const mul = found === 'cm' ? 10 : found === 'm' ? 1000 : 1;
      return { width: Math.round(a * mul), height: Math.round(b * mul) };
    }
    case 'resolution': {
      const { a, b } = readPair(hint.show);
      return { width: a, height: b };
    }
    case 'hours':
      return readHours(hint.show);
    case 'period_options':
      return readOptions(hint.show, unit, 'days') as FieldValue;
    case 'quantity_options':
      return readOptions(hint.show, unit, 'qty') as FieldValue;
    case 'formats':
      return readFormats(hint.show);
  }
}
