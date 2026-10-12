// 글 한 줄(언어 × 칸)마다 무엇을 볼지 정하고 검사한다. 검사 자체는 src/core 의 글 검사 5종이다.
import {
  LANGS,
  PLACEHOLDERS,
  TEXT_FIELDS,
  type GenerateContentInput,
  type Lang,
  type Placeholder,
  type PlaceholderValues,
  type TextField,
} from '@/contract/content';
import { CONTENT_FAIL_CODES, type ContentFailCode } from '@/contract/reasons';
import { checkContent } from '@/core';
import { fillPlaceholders, groupDigits, hasBraces, isUsableValue } from './format';
import { termsIn, unique } from './glossary';

/** 글 한 줄에 대고 보는 것. */
export interface LineRule {
  lang: Lang;
  field: TextField;
  /** 이 줄에 꼭 있어야 하는 자리표시 */
  requiredPlaceholders: Placeholder[];
  /** 이 언어 표기로 글에 그대로 있어야 하는 용어 */
  requiredTerms: string[];
  /** 이름·지역·용어집 표기에 원래 있어 글에 나와도 되는 숫자 */
  allowedNumbers: string[];
  /** 코드가 넣을 수 있는 값. 쓸 수 있는 자리표시의 값만 들어 있다. */
  values: PlaceholderValues;
}

/**
 * 이 상품의 글에 쓸 수 있는 자리표시. 모델에게 알려 준 이름(content.placeholders)이면서 넣을 값이 있는 것만이다.
 * 기간 옵션이 없는 상품은 {days} 를 쓸 수 없다. 썼다면 넣을 값이 없으므로 검사에 걸린다.
 */
export function usablePlaceholders(input: GenerateContentInput): Placeholder[] {
  return PLACEHOLDERS.filter((p) => input.content.placeholders.includes(p) && isUsableValue(input.values[p]));
}

/** 글 속의 숫자 덩어리. src/core/content-check.ts 가 숫자를 세는 꼴과 같다. */
export function numberChunks(text: string): string[] {
  return text.normalize('NFKC').match(/\d+(?:[.,]\d+)*/g) ?? [];
}

/** 같은 수의 다른 꼴까지 허락한다. 이름에 "1000매"가 있으면 글의 "1,000"도 봐준다. */
function numberForms(chunk: string): string[] {
  const bare = chunk.replace(/,/g, '');
  return /^\d+$/.test(bare) ? [chunk, bare, groupDigits(Number(bare))] : [chunk, bare];
}

/**
 * 글 네 줄의 규칙. LANGS × TEXT_FIELDS 순서(영어 제목, 영어 요약, 중국어 제목, 중국어 요약).
 * - 자리표시: 요약에는 쓸 수 있는 자리표시가 모두 있어야 한다. 제목에는 없어도 된다.
 * - 용어: 제목에는 이름 속 낱말의 표기가, 요약에는 이름과 지역 속 낱말의 표기가 있어야 한다.
 *   종류·갈래의 낱말은 모델에게 알려 주기만 하고 요구하지 않는다(요약이 갈래 낱말을 꼭 쓰지는 않는다).
 * - 숫자: 이름·지역·용어집 표기에 원래 있는 숫자만 자리표시 밖에 나올 수 있다.
 */
export function lineRules(input: GenerateContentInput): LineRule[] {
  const { content } = input;
  const usable = usablePlaceholders(input);
  const values: PlaceholderValues = {};
  for (const p of usable) values[p] = input.values[p];

  return LANGS.flatMap((lang) => {
    const nameTerms = termsIn(content.name, content.glossary, lang);
    const regionTerms = termsIn(content.region, content.glossary, lang);
    const numbered = [content.name, content.region ?? '', ...content.glossary.map((e) => e[lang])];
    const allowedNumbers = unique(numbered.flatMap(numberChunks).flatMap(numberForms));
    return TEXT_FIELDS.map((field): LineRule => ({
      lang,
      field,
      requiredPlaceholders: field === 'summary' ? usable : [],
      requiredTerms: field === 'summary' ? unique([...nameTerms, ...regionTerms]) : nameTerms,
      allowedNumbers,
      values,
    }));
  });
}

/**
 * 글 한 줄을 검사한다. 걸린 코드들(약속한 순서). 빈 배열이면 통과.
 * 글 검사 5종에 하나를 더 본다: 숫자를 넣어 보고도 중괄호가 남으면 채울 수 없는 자리표시다
 * (넣을 값이 없는 {days}, 전각 중괄호처럼 꼴이 다른 것). 그런 글은 PLACEHOLDER_LOST 로 건다.
 */
export function checkLine(rule: LineRule, text: string): ContentFailCode[] {
  const fails = new Set<ContentFailCode>(
    checkContent({
      lang: rule.lang,
      field: rule.field,
      text,
      requiredPlaceholders: rule.requiredPlaceholders,
      requiredTerms: rule.requiredTerms,
      allowedNumbers: rule.allowedNumbers,
    }),
  );
  if (!fails.has('EMPTY_TEXT') && hasBraces(fillPlaceholders(text, rule.values, rule.lang))) fails.add('PLACEHOLDER_LOST');
  return CONTENT_FAIL_CODES.filter((code) => fails.has(code));
}

// ── 다시 쓰라고 할 때 붙이는 말 ─────────────────────────────

const quote = (term: string): string => `"${term}"`;

/** 걸린 코드마다 "이렇게 고쳐라"를 한 문장으로. 무엇이 틀렸는지가 아니라 지켜야 할 것을 적는다. */
const FIX: Record<ContentFailCode, (rule: LineRule) => string> = {
  PLACEHOLDER_LOST: (rule) =>
    rule.requiredPlaceholders.length > 0
      ? `자리표시 ${rule.requiredPlaceholders.map((p) => `{${p}}`).join(', ')} 를 중괄호째 그대로 모두 넣는다. 그 밖의 자리표시나 중괄호는 쓰지 않는다.`
      : '넣을 값이 없는 자리표시와 중괄호는 쓰지 않는다.',
  STRAY_NUMBER: () => '숫자를 직접 쓰지 않는다. 값·일수·수량은 자리표시로만 적는다.',
  HANGUL_IN_TEXT: () => '한글을 쓰지 않는다. 용어집에 없는 고유한 이름은 로마자로 적는다.',
  EMPTY_TEXT: () => '글이 비었다. 글을 쓴다.',
  MONOLOGUE: () => '머리말·맺음말·설명·따옴표·꾸밈 표시 없이 글만 적는다.',
  GLOSSARY_MISS: (rule) => `용어집 표기 ${rule.requiredTerms.map(quote).join(', ')} 를 글자 그대로 넣는다.`,
};

/**
 * 걸린 줄을 알려 주는 말(프롬프트의 retryHint). 걸린 줄마다 한 줄이다.
 * 숫자 값은 넣지 않는다. 그래서 값만 다른 두 상품은 다시 한 요청도 같다.
 * 이 글을 고치면 다시 한 요청의 장부 키가 달라져, 받아 둔 "다시 한 답"은 맞지 않게 된다.
 */
export function retryHintOf(rules: readonly LineRule[], failCodes: readonly (readonly ContentFailCode[])[]): string {
  const lines = rules.flatMap((rule, i) => {
    const codes = failCodes[i] ?? [];
    if (codes.length === 0) return [];
    return [`- ${rule.lang}.${rule.field}: ${codes.map((code) => FIX[code](rule)).join(' ')}`];
  });
  return ['지난번 글이 검사에 걸렸다. 아래를 고쳐 네 글을 모두 다시 쓴다.', ...lines].join('\n');
}
