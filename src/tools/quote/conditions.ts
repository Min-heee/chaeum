// 모델이 뽑은 것(QuoteExtraction)을 계산에 쓸 조건(QuoteConditions)으로 다듬는다. 순수 함수다.
// 여기서 하는 일은 셋이다: 예산 표현을 본체의 금액 맞추기로 다시 읽기, 날짜 조각을 실제 날짜 범위로 바꾸기, 범위 밖의 값 버리기.
// 모델이 낸 값은 그대로 믿지 않는다. 코드가 읽을 수 있는 것은 코드가 읽는다.
import { cleanShortText, PRODUCT_TYPES, SUBTYPES, type ProductType } from '@/contract/fields';
import { isRealDate } from '@/contract/tools/dates';
import type { QuoteConditions, QuoteExtraction } from '@/contract/tools/quote';
import { normalizeMoney } from '@/core/normalize/money';
import { diffDays } from '../shared/deadline';

/**
 * 원이 아닌 돈의 표시. 이런 표현의 예산은 환율로 바꿔 읽지 않는다(코드도, 모델이 읽은 값도 쓰지 않는다).
 * 영어 낱말은 낱말째로만 본다("europe" 의 eur 에 걸리지 않게). 숫자에 붙은 것("500usd")은 본다.
 */
const FOREIGN_MONEY = /[$€£¥]|(?<![a-z])(?:usd|dollars?|eur|euros?|jpy|yen|cny|rmb|yuan)(?![a-z])|달러|美元|美金|유로|欧元|엔화|日元|円|위안|人民币|(?<![韩韓])元/i;

/** 원화의 표시. */
const WON_MONEY = /원|₩|(?<![a-z])(?:won|krw)(?![a-z])|[韩韓]元|[韩韓]币/i;

/** 표현을 가르는 자리: 괄호, 빗금, 같음표, 뒤에 빈칸이 오는 쉼표(숫자 속 쉼표는 아니다). */
const BUDGET_SPLIT = /[()[\]/=≈]|[,;]\s+/;

/** 빼기 부호가 붙은 수("-300만원"). 범위의 줄표("100-150")는 앞이 숫자라 여기에 걸리지 않는다. */
const SIGNED_NUMBER = /(?<![\d\p{L}])[-−–]\s*\d/u;

/**
 * 원화와 다른 통화가 함께 적힌 표현("3000000 won (about $2,200)")에서 원화 조각만 뗀다.
 * 다른 통화가 없으면 받은 그대로. 원화 조각을 하나로 정하지 못하면(없거나, 둘 이상이거나, 한 조각에 두 통화가 섞였으면) null.
 */
function wonPart(text: string): string | null {
  if (!FOREIGN_MONEY.test(text)) return text;
  const parts = text.split(BUDGET_SPLIT).filter((part) => WON_MONEY.test(part) && !FOREIGN_MONEY.test(part));
  return parts.length === 1 ? parts[0]!.trim() : null;
}

/** 예산으로 받는 가장 큰 값(원). 이보다 크면 잘못 읽은 것으로 본다. */
export const BUDGET_MAX_KRW = 100_000_000_000;

const positiveInt = (n: number | null): number | null => (n !== null && Number.isSafeInteger(n) && n > 0 ? n : null);

/**
 * 예산. 적힌 표현을 본체의 금액 맞추기(normalizeMoney)로 읽는다.
 * - 코드가 단위까지 읽었으면 그 값이다(budgetBy 'code').
 * - 코드가 못 읽었거나 단위를 짐작해야 했으면("300", "3百万") 모델이 읽은 값을 쓴다(budgetBy 'model'. 화면이 표시한다).
 * - 원이 아닌 돈("$2,000", "5000元")이면 예산 조건은 없다. 환율을 짐작하지 않는다.
 *   원화가 함께 적혀 있으면("300만원 (약 $2,200)") 원화 조각만 읽는다.
 * - 빼기 부호가 붙은 표현("-300만원")도 예산 조건이 없다. 부호를 떼고 읽지 않는다.
 */
export function resolveBudget(raw: string | null, modelKrw: number | null): Pick<QuoteConditions, 'budgetKrw' | 'budgetBy'> {
  const none = { budgetKrw: null, budgetBy: null };
  const whole = raw?.normalize('NFKC').trim() ?? '';
  if (SIGNED_NUMBER.test(whole)) return none;
  const text = wonPart(whole);
  if (text === null) return none;
  if (text) {
    const read = normalizeMoney(text);
    const value = positiveInt(read.value);
    if (value !== null && value <= BUDGET_MAX_KRW && !read.reasons.includes('UNIT_CONVERTED')) return { budgetKrw: value, budgetBy: 'code' };
  }
  const model = positiveInt(modelKrw);
  if (model !== null && model <= BUDGET_MAX_KRW) return { budgetKrw: model, budgetBy: 'model' };
  return none;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const iso = (year: number, month: number, day: number) => `${pad(year, 4)}-${pad(month)}-${pad(day)}`;

/** 그 달의 날 수. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

type DateParts = NonNullable<QuoteExtraction['date']>;
type DateRange = { dateFrom: string; dateTo: string };

const intIn = (n: number | null, min: number, max: number): number | null => (n !== null && Number.isInteger(n) && n >= min && n <= max ? n : null);

/** 연도를 정한 날짜 조각 → 범위. 달력에 없는 날이면 null. */
function rangeInYear(year: number, month: number, parts: DateParts): DateRange | null {
  const last = daysInMonth(year, month);
  if (parts.day_from !== null) {
    const from = parts.day_from;
    const to = parts.day_to ?? from;
    if (to < from) return null;
    const range = { dateFrom: iso(year, month, from), dateTo: iso(year, month, to) };
    return isRealDate(range.dateFrom) && isRealDate(range.dateTo) ? range : null;
  }
  if (parts.week_of_month !== null) {
    // N째 주 = (N−1)×7+1 일부터 7일. 달을 넘지 않게 말일에서 자른다.
    const from = (parts.week_of_month - 1) * 7 + 1;
    if (from > last) return null;
    return { dateFrom: iso(year, month, from), dateTo: iso(year, month, Math.min(from + 6, last)) };
  }
  return { dateFrom: iso(year, month, 1), dateTo: iso(year, month, last) };
}

/** 연도 없는 2월 29일은 오늘부터 이 햇수 안에서 찾는다(다음 윤년까지 닿게). 그 밖의 날짜는 올해와 내년만 본다. */
const LEAP_DAY_YEARS_AHEAD = 8;

/** 범위가 오늘을 품으면 첫날을 오늘로 당긴다. 통째로 지났거나 아직 안 온 범위는 그대로다. */
function fromTodayOn(range: DateRange, today: string): DateRange {
  return diffDays(range.dateFrom, today) > 0 && diffDays(today, range.dateTo) >= 0 ? { dateFrom: today, dateTo: range.dateTo } : range;
}

/**
 * 날짜 조각 → 날짜 범위. 규칙은 약속(QuoteConditionsSchema 의 주석)에 있다.
 * 조각이 날짜를 가리키지 못하면(달이 없음, 2월 30일, 끝이 시작보다 앞, 그 달에 없는 주차) null.
 */
export function resolveDateRange(parts: DateParts | null, today: string): DateRange | null {
  if (!parts) return null;
  const month = intIn(parts.month, 1, 12);
  if (month === null) return null;
  const checked: DateParts = {
    year: parts.year,
    month,
    day_from: parts.day_from === null ? null : intIn(parts.day_from, 1, 31),
    day_to: parts.day_to === null ? null : intIn(parts.day_to, 1, 31),
    week_of_month: parts.week_of_month === null ? null : intIn(parts.week_of_month, 1, 5),
  };
  // 적혀 있었는데 범위 밖이면(0일, 32일, 6째 주) 날짜로 바꾸지 못한 것이다.
  if ((parts.day_from !== null && checked.day_from === null) || (parts.day_to !== null && checked.day_to === null)) return null;
  if (parts.week_of_month !== null && checked.week_of_month === null) return null;
  // 끝 날만 있고 시작이 없으면 하루짜리로 본다.
  if (checked.day_from === null && checked.day_to !== null) checked.day_from = checked.day_to;

  if (parts.year !== null) {
    const year = intIn(parts.year, 1900, 2200);
    const range = year === null ? null : rangeInYear(year, month, checked);
    return range && fromTodayOn(range, today);
  }
  // 연도가 없으면 오늘 이후로 처음 오는 그 달(그 날)이다. 범위가 통째로 지났으면 다음 해를 본다.
  const thisYear = Number(today.slice(0, 4));
  const leapDay = month === 2 && (checked.day_from === 29 || checked.day_to === 29);
  const byWeek = checked.day_from === null && checked.week_of_month !== null;
  for (let year = thisYear; year <= thisYear + (leapDay ? LEAP_DAY_YEARS_AHEAD : 1); year += 1) {
    // 그 달이 통째로 지난 해는 건너뛴다.
    if (diffDays(today, iso(year, month, daysInMonth(year, month))) < 0) continue;
    const range = rangeInYear(year, month, checked);
    // 주차는 처음 오는 그 달 하나만 본다. 그 달에 그 주가 없으면 여러 해를 뒤져 다른 날로 바꾸지 않는다.
    if (!range && byWeek) return null;
    if (range && diffDays(today, range.dateTo) >= 0) return fromTodayOn(range, today);
  }
  return null;
}

/** 갈래가 닫힌 목록에 있고, 종류가 정해졌으면 그 종류의 갈래일 때만 남긴다. */
function resolveSubtype(type: ProductType | null, subtype: string | null): string | null {
  const text = subtype?.trim();
  if (!text) return null;
  const owners = PRODUCT_TYPES.filter((t) => (SUBTYPES[t] as readonly string[]).includes(text));
  if (owners.length === 0) return null;
  return type === null || owners.includes(type) ? text : null;
}

/** 모델의 답을 계산에 쓸 조건으로 다듬는다. 오늘은 'YYYY-MM-DD'(한국 날짜). */
export function resolveConditions(extraction: QuoteExtraction, today: string): QuoteConditions {
  if (!isRealDate(today)) throw new Error(`오늘 날짜의 꼴이 틀렸다: ${today}`);
  const region = extraction.region === null ? '' : cleanShortText(extraction.region);
  const range = resolveDateRange(extraction.date, today);
  const dateMentioned = Boolean(extraction.date_raw?.trim()) || (extraction.date !== null && Object.values(extraction.date).some((v) => v !== null));
  return {
    lang: extraction.lang,
    ...resolveBudget(extraction.budget_raw, extraction.budget_krw),
    region: region === '' ? null : region,
    dateFrom: range?.dateFrom ?? null,
    dateTo: range?.dateTo ?? null,
    dateProblem: range === null && dateMentioned,
    type: extraction.type,
    subtype: resolveSubtype(extraction.type, extraction.subtype),
    qty: positiveInt(extraction.qty),
    days: positiveInt(extraction.days),
  };
}

/** 범위의 날 수(양 끝 포함). 화면이 "7일 동안"처럼 적을 때 쓴다. */
export function rangeDays(dateFrom: string, dateTo: string): number {
  return diffDays(dateFrom, dateTo) + 1;
}
