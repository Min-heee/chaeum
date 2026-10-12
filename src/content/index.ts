// 글 만들기의 문. 꼴은 src/contract/content.ts 의 ContentApi 에 있다.
// 이 폴더는 DB 를 모른다. 공급자와 용어집은 부르는 쪽이 넘기고, 저장도 부르는 쪽이 한다.
// 서버에서만 쓴다(모델을 부르는 코드가 딸려 온다). 브라우저 코드는 이 문을 가져오지 않는다.
//
//   상품의 글자 정보(종류, 갈래, 이름, 지역) + 용어집
//     → 모델 1회(영어·중국어 간체의 제목·요약, 숫자 자리는 {price} {days} {qty})
//     → 글 검사 → 걸리면 무엇이 걸렸는지 알려 1회만 다시
//     → 그래도 걸린 줄은 틀 문장(source 'template', needs_review)
//     → 코드가 언어별 서식으로 숫자를 넣는다
import type { ContentApi } from '@/contract/content';
import { fillPlaceholders } from './format';
import { generateContent } from './generate';
import { pickGlossary } from './glossary';
import { templateTexts } from './template';

export { fillPlaceholders, generateContent, pickGlossary, templateTexts };
export { formatCount, formatMoney, groupDigits, isUsableValue } from './format';
export { entriesIn, termsIn } from './glossary';
export { checkLine, lineRules, retryHintOf, usablePlaceholders, type LineRule } from './line-check';
export { checkTranslations } from './translation-check';

// 내보낸 것이 약속과 같은 꼴인지 타입 검사가 본다.
const api: ContentApi = { generateContent, templateTexts, fillPlaceholders, pickGlossary };
export default api;
