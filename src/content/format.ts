// 자리표시에 숫자를 넣는다. 숫자의 서식 규칙은 이 파일 한곳에만 둔다.
// 모델은 숫자를 모른다. {price} 같은 자리표시만 쓰고, 값은 여기서 들어간다.
import { PLACEHOLDER_PATTERN, PLACEHOLDERS, type Lang, type Placeholder, type PlaceholderValues } from '@/contract/content';

/** 넣을 수 있는 값인가. 0보다 큰 정수만 넣는다(값·일수·수량 모두 그렇다). */
export function isUsableValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** 세 자리마다 쉼표. 1500000 → "1,500,000" */
export function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 금액의 언어별 꼴. 통화 표시까지 여기서 붙인다. */
const MONEY: Record<Lang, (digits: string) => string> = {
  en: (digits) => `KRW ${digits}`,
  'zh-Hans': (digits) => `${digits}韩元`,
};

/** 1500000 → 영어 "KRW 1,500,000", 중국어 "1,500,000韩元" */
export function formatMoney(krw: number, lang: Lang): string {
  return MONEY[lang](groupDigits(krw));
}

/** 일수와 수량. 두 언어가 같다. 단위 낱말(days, 天)은 모델이나 틀 문장이 쓴다. */
export function formatCount(n: number): string {
  return groupDigits(n);
}

export function formatPlaceholder(name: Placeholder, value: number, lang: Lang): string {
  return name === 'price' ? formatMoney(value, lang) : formatCount(value);
}

function isPlaceholderName(name: string): name is Placeholder {
  return (PLACEHOLDERS as readonly string[]).includes(name);
}

// 통화 표시는 코드가 넣기로 했다. 모델이 {price} 바로 앞뒤에 또 적었으면("₩{price}", "{price} KRW") 겹치지 않게 뺀다.
const CURRENCY_BEFORE_PRICE = /(?:KRW|₩|￦|韩元|韩币)[ \t]*(?=\{price\})/gi;
const CURRENCY_AFTER_PRICE = /(\{price\})[ \t]*(?:KRW|won|₩|￦|韩元|韩币)(?![A-Za-z'’])/gi;

/**
 * 자리표시에 숫자를 넣는다.
 * 값이 없거나 넣을 수 없는 값(0 이하, 소수)이면 그 자리표시는 그대로 둔다. 숫자를 지어내지 않는다.
 * 모르는 이름의 자리표시도 그대로 둔다. 남은 중괄호는 글 검사가 잡는다.
 */
export function fillPlaceholders(text: string, values: PlaceholderValues, lang: Lang): string {
  let out = text;
  if (isUsableValue(values.price)) {
    out = out.replace(CURRENCY_BEFORE_PRICE, '').replace(CURRENCY_AFTER_PRICE, '$1');
  }
  return out.replace(PLACEHOLDER_PATTERN, (whole: string, name: string) => {
    if (!isPlaceholderName(name)) return whole;
    const value = values[name];
    return isUsableValue(value) ? formatPlaceholder(name, value, lang) : whole;
  });
}

/** 글에 중괄호가 남았는가(전각 중괄호도 본다). 숫자를 넣은 뒤에 남았으면 채우지 못한 자리표시다. */
export function hasBraces(text: string): boolean {
  return /[{}｛｝]/.test(text);
}
