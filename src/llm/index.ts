// LLM 자리의 문. 꼴은 src/contract/llm-types.ts 에 있다.
// 이 폴더는 DB 를 모른다. 장부를 읽고 쓰는 자리(LlmCallStore)는 부르는 쪽이 넘긴다.
import type { LlmApi } from '@/contract/llm-types';
import { cacheKeyFor } from './keys';
import { costUsd, priceOf } from './pricing';
import { buildContentRequestV1 } from './prompts/content.v1';
import { buildExtractRequestV1 } from './prompts/extract.v1';
import { buildQuoteExtractRequestV1 } from './prompts/quote-extract.v1';
import { buildQuoteReplyRequestV1 } from './prompts/quote-reply.v1';
import { buildTranscribeRequestV1 } from './prompts/transcribe.v1';
import { createProvider } from './provider';

// 지금 쓰는 프롬프트 버전. 새 버전을 채택하면 여기 세 줄만 바꾼다.
export const buildExtractRequest: LlmApi['buildExtractRequest'] = buildExtractRequestV1;
export const buildContentRequest: LlmApi['buildContentRequest'] = buildContentRequestV1;
export const buildTranscribeRequest: LlmApi['buildTranscribeRequest'] = buildTranscribeRequestV1;

// 견적 도구의 둘(조건 뽑기, 답장 초안). 요청 안에서 바로 부른다(작업 줄을 타지 않는다).
export const buildQuoteExtractRequest = buildQuoteExtractRequestV1;
export const buildQuoteReplyRequest = buildQuoteReplyRequestV1;

export { cacheKeyFor, costUsd, createProvider, priceOf };
export { checkAttachments } from './attachments';
export { attachmentHash } from './keys';
// 옮긴 글에서 "읽지 못함" 표시([안 보임])를 세는 데 쓴다. 글로 옮기기 프롬프트를 새 버전으로 바꾸면 이 줄도 본다.
export { countUnreadableMarks, UNREADABLE_MARK } from './prompts/transcribe.v1';
export { providerFromEnv } from './provider';
export { JsonlCallStore, MemoryCallStore } from './stores';

// 내보낸 것이 약속과 같은 꼴인지 타입 검사가 본다.
const api: LlmApi = { createProvider, cacheKeyFor, buildExtractRequest, buildContentRequest, buildTranscribeRequest, costUsd, priceOf };
export default api;
