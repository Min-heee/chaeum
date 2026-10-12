// 글 검사 5종. 모델이 쓴 다른 언어 글(제목·요약)을 숫자를 넣기 전에 본다.
import type { ContentCheckInput } from '@/contract/core-api';
import { PLACEHOLDER_PATTERN, PLACEHOLDERS } from '@/contract/content';
import { CONTENT_FAIL_CODES, type ContentFailCode } from '@/contract/reasons';

const HANGUL = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힯]/;
/** 글자·숫자가 하나도 없으면 빈 글이다(점·줄표뿐). */
const HAS_LETTER = /[\p{L}\p{N}]/u;

/** 모델의 혼잣말·머리말·꾸밈 표시가 글에 남은 꼴. */
const MONOLOGUE_PATTERNS: RegExp[] = [
  /^\s*(?:sure|certainly|of course|okay|alright|here(?:'s| is| are)|below (?:is|are))\b/i,
  /\b(?:here(?:'s| is| are) (?:the|a|your|my)|as an ai|i (?:have|will|would|can(?:not|'t)?|am)\b|i['’](?:ve|ll|m|d)\b|let me\b|hope this helps)/i,
  /^\s*(?:title|summary|translation|english|chinese|output|answer|note)\s*[:：]/im,
  /^\s*(?:好的|当然|以下是|以下为|下面是|这是)/,
  /(?:翻译如下|如下所示|希望(?:这|对您|能))/,
  /^\s*(?:标题|摘要|翻译|译文|英文|中文|注)\s*[:：]/m,
  /```|^\s*#{1,6}\s|\*\*|^\s*[-*]\s/m,
  /^\s*["“'「『].*["”'」』]\s*$/s,
];

/**
 * 걸린 코드들을 약속한 순서로 낸다. 빈 배열이면 통과.
 * - 자리표시: 꼭 있어야 하는 것이 빠졌거나, 모르는 자리표시·깨진 중괄호가 있다.
 * - 숫자: 자리표시 밖에 숫자가 있다(이름·지역에 원래 있던 숫자는 봐준다).
 * - 언어: 한글이 섞였다. 글이 비었다.
 * - 혼잣말, 용어집 표기.
 */
export function checkContent(input: ContentCheckInput): ContentFailCode[] {
  const text = input.text.normalize('NFKC');
  if (!HAS_LETTER.test(text.replace(PLACEHOLDER_PATTERN, ''))) return ['EMPTY_TEXT'];

  const fails = new Set<ContentFailCode>();

  const used = [...text.matchAll(PLACEHOLDER_PATTERN)].map((m) => m[1]!);
  const known: readonly string[] = PLACEHOLDERS;
  const missing = input.requiredPlaceholders.some((p) => !used.includes(p));
  const unknown = used.some((p) => !known.includes(p));
  const body = text.replace(PLACEHOLDER_PATTERN, ' ');
  if (missing || unknown || /[{}]/.test(body)) fails.add('PLACEHOLDER_LOST');

  // 숫자 덩어리째로 견준다. "4"가 허락됐다고 "14"가 통과하지 않는다.
  const allowed = new Set(input.allowedNumbers.map((n) => n.normalize('NFKC')));
  const numbers = body.match(/\d+(?:[.,]\d+)*/g) ?? [];
  if (numbers.some((n) => !allowed.has(n))) fails.add('STRAY_NUMBER');

  if (HANGUL.test(body)) fails.add('HANGUL_IN_TEXT');
  if (MONOLOGUE_PATTERNS.some((re) => re.test(text))) fails.add('MONOLOGUE');

  const lower = text.toLowerCase();
  if (input.requiredTerms.some((term) => !lower.includes(term.normalize('NFKC').toLowerCase()))) {
    fails.add('GLOSSARY_MISS');
  }
  return CONTENT_FAIL_CODES.filter((code) => fails.has(code));
}
