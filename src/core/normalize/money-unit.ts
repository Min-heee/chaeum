// 글에 선언된 금액 단위 찾기. "(단위: 천원)" → 1단위 = 1,000원.
// 확실한 꼴만 선언으로 본다. 애매하면 선언이 아닌 것으로 둔다(짐작해서 단위를 바꾸지 않는다).
// 선언은 가까이 있는 금액에만 건다: 같은 줄, 같은 단락의 아래 줄, 표 머리라면 바로 다음 단락.
import { plain, squash } from '../text';

const KO_MULT: Record<string, number> = { 천: 1e3, 만: 1e4, 십만: 1e5, 백만: 1e6, 천만: 1e7, 억: 1e8 };
const ZH_MULT: Record<string, number> = { 千: 1e3, 万: 1e4, 萬: 1e4 };
const EN_MULT: Record<string, number> = { thousand: 1e3, million: 1e6 };
const KO_BIG = '십만|백만|천만|만|천|억';

/** "단위" 바로 앞에 와도 되는 낱말. 다른 낱말이 붙어 있으면("주문 단위", "판매 단위") 금액 단위가 아니다. */
const MONEY_WORD = /^(?:금액|가격|요금|비용|단가|견적|광고비|화폐|통화|prices?)(?:의|표)?$/;
/** "unit:" 바로 앞에 와도 되는 낱말. "per unit:", "order unit:" 은 낱개 값이나 묶음 크기다. */
const EN_MONEY_WORD = /^(?:currency|monetary|money|amounts?)$/;
const ZH_MONEY_WORD = /(?:金额|金額|价格|價格|货币|貨幣|费用|費用|报价|報價)$/;
/**
 * 단위 낱말 뒤에 와도 되는 것: 줄 끝, 닫는 괄호·쉼표 같은 부호, "입니다", "기준", 부가세 안내.
 * 그 밖의 말이 이어지면("천원 미만 절사", "만원 이상 주문", "천원 아님", "천원 → 만원") 선언이 아니다.
 */
const TAIL = /^\s*(?:$|[)\]】〕,.;。·|\/※(]|입니|이며|이고|임(?![가-힣])|이에|이구|(?:으)?로\s?(?:표기|적|기재|작성)|기준|vat|부가세|부가가치세|세금|tax)/;
/** "(천원 단위)" 뒤에 이런 말이 오면 묶음 크기나 끝수 처리다. */
const BRACKET_NOT = /^\s?(?:으?로|절사|씩|마다|이상|이하|미만|올림|내림|반올림|버림|에서)/;
/** 여러 줄 표현을 조각으로 나누는 자리. 따지기의 rawInSource 와 같다. */
const PIECE_BREAK = /[\n/|;·]|,\s/;
/** 한두 글자는 어디에나 있어서 자리를 못 정한다. */
const MIN_NEAR_CHARS = 2;

interface Unit {
  unit: number;
  length: number;
}

/** "1,000" → 1000. 1, 10, 100 … 같은 10의 거듭제곱만 단위로 받는다. */
function powerOfTen(text: string): number | null {
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)$/.test(text)) return null;
  const n = Number(text.replace(/,/g, ''));
  return /^10*$/.test(String(n)) ? n : null;
}

/** 글머리에서 단위 낱말 하나를 읽는다. 원 단위가 아니면 null. 뒤에 무엇이 오는지는 부르는 쪽이 본다. */
function readUnit(rest: string): Unit | null {
  let m: RegExpExecArray | null;
  // "천원", "만 원", "원", "원화"
  if ((m = new RegExp(`^(${KO_BIG})?\\s?원화?`).exec(rest))) {
    return { unit: m[1] ? KO_MULT[m[1]]! : 1, length: m[0].length };
  }
  // "1,000원", "1천원", "10,000 krw"
  if ((m = new RegExp(`^(\\d[\\d,]*\\d|\\d)\\s?(${KO_BIG})?\\s?(?:원|krw|won)`).exec(rest))) {
    const n = powerOfTen(m[1]!);
    return n === null ? null : { unit: n * (m[2] ? KO_MULT[m[2]]! : 1), length: m[0].length };
  }
  // "krw 1,000", "₩1,000", "krw", "krw thousands"
  if ((m = /^(?:krw|won|₩)(?:\s?(\d[\d,]*\d|\d))?/.exec(rest))) {
    const tail = rest.slice(m[0].length);
    if (/^[.,]?\d/.test(tail)) return null;
    if (m[1]) {
      const n = powerOfTen(m[1]);
      return n === null ? null : { unit: n, length: m[0].length };
    }
    const word = /^\s?(thousand|million)s?/.exec(tail);
    return { unit: word ? EN_MULT[word[1]!]! : 1, length: m[0].length + (word ? word[0].length : 0) };
  }
  // "thousand won", "thousands of krw"
  if ((m = /^(thousand|million)s?\s(?:of\s)?(?:korean\s)?(?:krw|won)/.exec(rest))) {
    return { unit: EN_MULT[m[1]!]!, length: m[0].length };
  }
  // "千韩元", "韩元"
  if ((m = /^([千万萬])?\s?(?:韩元|韩币|韓元|韓幣)/.exec(rest))) {
    return { unit: m[1] ? ZH_MULT[m[1]]! : 1, length: m[0].length };
  }
  return null;
}

/**
 * 선언 머리말 바로 뒤의 글에서 단위를 읽는다. "원, 천원"처럼 여럿을 나열했으면 모두 낸다.
 * 뒤에 선언답지 않은 말이 이어지면 null.
 */
function readDeclared(rest: string): { units: number[]; length: number } | null {
  const first = readUnit(rest);
  if (!first) return null;
  const units = [first.unit];
  let pos = first.length;
  for (;;) {
    const sep = /^\s?[,/·]\s?/.exec(rest.slice(pos));
    const next = sep && readUnit(rest.slice(pos + sep[0].length));
    if (!sep || !next) break;
    units.push(next.unit);
    pos += sep[0].length + next.length;
  }
  return TAIL.test(rest.slice(pos)) ? { units, length: pos } : null;
}

interface LineUnits {
  units: number[];
  /** 선언 말고는 숫자가 없는 줄인가(표 머리로 볼 수 있는가) */
  headerLike: boolean;
}

/** 한 줄에서 선언을 찾는다. 줄이 바뀌면 잇지 않는다. */
function unitsInLine(line: string): LineUnits {
  const t = plain(line);
  const units: number[] = [];
  const spans: [number, number][] = [];
  const take = (from: number, headLength: number) => {
    const got = readDeclared(t.slice(from + headLength));
    if (!got) return;
    units.push(...got.units);
    spans.push([from, from + headLength + got.length]);
  };

  for (const m of t.matchAll(/단위\s*(?:[:=]|[은는])?\s*/g)) {
    const word = /[가-힣a-z0-9]*$/.exec(t.slice(0, m.index).trimEnd())![0];
    if (word === '' || MONEY_WORD.test(word)) take(m.index, m[0].length);
  }
  // "(천원 단위)". 괄호 없이 쓴 "만원 단위로"는 묶음 크기를 뜻할 수 있어 읽지 않는다.
  for (const m of t.matchAll(new RegExp(`[(\\[]\\s?(${KO_BIG})?\\s?원\\s?단위\\s?[)\\]]`, 'g'))) {
    if (BRACKET_NOT.test(t.slice(m.index + m[0].length))) continue;
    units.push(m[1] ? KO_MULT[m[1]]! : 1);
    spans.push([m.index, m.index + m[0].length]);
  }
  for (const m of t.matchAll(/units?\s*[:=]\s*/g)) {
    const word = /[a-z]*$/.exec(t.slice(0, m.index).trimEnd())![0];
    if (word === '' || EN_MONEY_WORD.test(word)) take(m.index, m[0].length);
  }
  // "prices in thousand won", "(in krw thousands)". 문장 속의 "in thousand won-style"은 읽지 않는다.
  const inHead = /(?:^|[(\[]|(?:prices?|amounts?|figures|rates|fees|costs|values)\s(?:are\s)?(?:all\s)?(?:(?:quoted|stated|shown|listed|given|expressed)\s)?)\s*in\s+(?=thousand|million|(?:krw|won)\s?(?:thousand|million))/g;
  for (const m of t.matchAll(inHead)) take(m.index, m[0].length);
  for (const m of t.matchAll(/(?:单位|單位)\s*[:=]?\s*/g)) {
    const before = t.slice(0, m.index).trimEnd();
    if (/[一-鿿]$/.test(before) && !ZH_MONEY_WORD.test(before)) continue;
    take(m.index, m[0].length);
  }

  let rest = t;
  for (const [from, to] of spans) rest = rest.slice(0, from) + ' '.repeat(to - from) + rest.slice(to);
  return { units, headerLike: units.length > 0 && !/\d/.test(rest) };
}

/** near 의 구절이 놓인 줄 번호들. 앞의 구절부터 보고, 글에서 찾은 첫 구절의 자리를 쓴다. 못 찾으면 빈 묶음. */
function linesNear(lines: readonly string[], near: readonly (string | null)[]): Set<number> {
  const starts: number[] = [];
  let hay = '';
  for (const line of lines) {
    starts.push(hay.length);
    hay += squash(line);
  }
  const lineAt = (pos: number) => {
    let i = starts.length - 1;
    while (starts[i]! > pos) i -= 1;
    return i;
  };
  const found = new Set<number>();
  const mark = (needle: string): boolean => {
    let hit = false;
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
      hit = true;
      for (let i = lineAt(at); i <= lineAt(at + needle.length - 1); i += 1) found.add(i);
    }
    return hit;
  };
  for (const phrase of near) {
    if (phrase === null) continue;
    const whole = squash(phrase);
    if (whole.length < MIN_NEAR_CHARS) continue;
    if (mark(whole)) return found;
    // 표의 여러 줄을 " / " 나 쉼표로 이어 붙인 표현은 조각마다 찾는다.
    const pieces = phrase.split(PIECE_BREAK).map(squash).filter((p) => p.length >= MIN_NEAR_CHARS);
    if (pieces.length > 1 && pieces.every((p) => hay.includes(p))) {
      for (const p of pieces) mark(p);
      return found;
    }
  }
  return found;
}

/**
 * 글에 선언된 금액 단위를 찾아 "1단위가 몇 원인가"로 낸다. 같은 단위는 하나로 합치고 작은 것부터.
 * - 빈 목록: 선언이 없다. 하나: 단위 없는 금액은 그 단위다. 둘 이상: 어느 것인지 모른다.
 * - near 를 주면(근거 구절, 원문 표현) 그 자리에 걸리는 선언만 낸다:
 *   선언과 같은 줄, 같은 단락에서 선언 아래의 줄, 선언 줄이 단락의 끝이고 다른 숫자가 없으면(표 머리) 바로 다음 단락.
 *   멀리 있는 선언("매출 (단위: 백만원)")은 다른 단락의 금액에 걸지 않는다. 자리를 못 찾으면 빈 목록.
 * - 읽는 꼴: "단위: 천원", "(단위 : 만원)", "단위=원", "금액 단위는 천원", "(천원 단위)",
 *   "unit: KRW 1,000", "prices in thousand won", "单位: 千韩元".
 * - 읽지 않는 꼴: "최소 주문 단위: 100개", "판매 단위는 박스", "만원 단위로 주문", "단위: 천원 미만 절사",
 *   "per unit: KRW 1,000"(금액의 단위가 아니거나 애매함).
 */
export function declaredMoneyUnits(sourceText: string, near?: readonly (string | null)[]): number[] {
  const lines = sourceText.split(/\r?\n/);
  const blank = lines.map((line) => squash(line) === '');
  const at = near === undefined ? null : linesNear(lines, near);
  const found = new Set<number>();
  for (const [d, line] of lines.entries()) {
    const { units, headerLike } = unitsInLine(line);
    if (units.length === 0) continue;
    // 이 선언이 걸리는 줄: 선언 줄부터 단락 끝까지. 표 머리면 다음 단락까지.
    let end = d;
    while (end < lines.length && !blank[end]) end += 1;
    if (headerLike && end === d + 1) {
      while (end < lines.length && blank[end]) end += 1;
      while (end < lines.length && !blank[end]) end += 1;
    }
    const covers = at === null || [...at].some((i) => i >= d && i < end);
    if (covers) for (const unit of units) found.add(unit);
  }
  return [...found].sort((a, b) => a - b);
}
