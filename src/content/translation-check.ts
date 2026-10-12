// 번역 검사: 이미 번역된 제목·요약(숫자가 들어간 끝 글)을 받아 글 검사 5종의 결과를 낸다.
// 모델을 부르지 않고 DB 를 쓰지 않는다. POST /api/content-checks 가 이 함수를 부르면 된다.
import type {
  CheckOutcome,
  CheckOutcomes,
  ContentCheckItem,
  ContentCheckRequest,
  ContentCheckResponse,
  ContentCheckResult,
  GlossaryEntry,
} from '@/contract/content';
import { CONTENT_FAIL_CODES, CONTENT_FAILS, type ContentCheck, type ContentFailCode } from '@/contract/reasons';
import { checkContent } from '@/core';
import { hasBraces } from './format';
import { termsIn, unique } from './glossary';
import { numberChunks } from './line-check';

/** 숫자를 견줄 때의 꼴. 쉼표를 뗀다. "1,500,000" 과 "1500000" 은 같은 수다. */
const bare = (n: string): string => n.normalize('NFKC').replace(/,/g, '').trim();

function checkOne(item: ContentCheckItem, index: number, glossary: readonly GlossaryEntry[]): ContentCheckResult {
  // 꼭 있어야 하는 표기: 한국어 원문에서 찾은 용어집 낱말 + 부르는 쪽이 직접 준 것.
  const terms = unique([...termsIn(item.sourceKo ?? null, glossary, item.lang), ...(item.requiredTerms ?? [])]);

  // 맞는 숫자를 안 줬으면 어느 숫자가 틀렸는지 알 수 없다. 숫자 검사는 건너뛴다(글의 숫자를 모두 허락한다).
  const inText = numberChunks(item.text);
  const allowed = item.allowedNumbers ? new Set(item.allowedNumbers.map(bare)) : null;
  const allowedNumbers = allowed ? inText.filter((n) => allowed.has(bare(n))) : inText;

  const fails = new Set<ContentFailCode>(
    checkContent({ lang: item.lang, field: item.field, text: item.text, requiredPlaceholders: [], requiredTerms: terms, allowedNumbers }),
  );
  const empty = fails.has('EMPTY_TEXT');
  // 끝 글에는 자리표시가 남아 있으면 안 된다.
  if (!empty && hasBraces(item.text)) fails.add('PLACEHOLDER_LOST');
  const failCodes = CONTENT_FAIL_CODES.filter((code) => fails.has(code));

  // 빈 글이면 나머지 검사는 돌지 않는다. 돌지 않은 검사는 통과가 아니라 "건너뜀"이다.
  const outcome = (check: ContentCheck, ran: boolean): CheckOutcome => {
    if (!ran) return 'skipped';
    return failCodes.some((code) => CONTENT_FAILS[code].check === check) ? 'fail' : 'pass';
  };
  const checks: CheckOutcomes = {
    placeholder: outcome('placeholder', !empty),
    number: outcome('number', !empty && allowed !== null),
    language: outcome('language', true),
    monologue: outcome('monologue', !empty),
    // 찾아볼 표기가 하나도 없으면 본 것이 없다.
    glossary: outcome('glossary', !empty && terms.length > 0),
  };
  return {
    id: item.id ?? null,
    index,
    lang: item.lang,
    field: item.field,
    status: failCodes.length === 0 ? 'ok' : 'needs_review',
    failCodes,
    checks,
  };
}

/** 요청의 글마다 검사 결과를 낸다. 순서는 요청과 같다. */
export function checkTranslations(request: ContentCheckRequest, glossary: readonly GlossaryEntry[]): ContentCheckResponse {
  const results = request.items.map((item, index) => checkOne(item, index, glossary));
  const ok = results.filter((r) => r.status === 'ok').length;
  const withSkipped = results.filter((r) => Object.values(r.checks).includes('skipped')).length;
  return { results, summary: { total: results.length, ok, needsReview: results.length - ok, withSkipped } };
}
