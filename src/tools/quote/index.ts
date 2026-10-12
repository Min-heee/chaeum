// 견적의 판단 코드(순수 함수)의 문. 약속은 src/contract/tools/quote.ts 에 있다.
// 시계·난수·DB·네트워크를 쓰지 않는다(린트가 본다). 오늘 날짜는 인자로 받는다. 브라우저 코드도 이 문을 가져다 쓴다.
//
//   모델이 뽑은 것 → resolveConditions(조건) → matchQuote(맞는 상품·총액·마감, 빠진 까닭)
//     → replyValues(자리표시에 넣을 값) → fillReply(숫자와 날짜 넣기) · templateReply(모델 없이 쓰는 답장) · checkReply(글 검사)
import type { QuoteApi } from '@/contract/tools/quote';
import { resolveConditions } from './conditions';
import { matchQuote } from './match';
import { fillReply, replyValues, templateReply } from './reply';

export { resolveConditions, matchQuote, replyValues, fillReply, templateReply };
export { BUDGET_MAX_KRW, rangeDays, resolveBudget, resolveDateRange } from './conditions';
export { hasSearchCondition, pickOption, priceProduct, productRegion, regionCore, regionMatches } from './match';
export { askReply, checkReply, formatDate, formatTotal, hasLeftoverPlaceholder, localText, placeholdersOf, replyInputOf, replyRetryHint, requiredTermsOf, vatNote } from './reply';
export { QuoteSampleSchema, quoteSamples, SAMPLE_FIELD_LABELS, SAMPLE_FIELDS, SAMPLE_TODAY, scoreSample, type QuoteSample, type SampleField } from './samples';

// 내보낸 것이 약속과 같은 꼴인지 타입 검사가 본다.
const api: QuoteApi = { resolveConditions, matchQuote, replyValues, fillReply, templateReply };
export default api;
