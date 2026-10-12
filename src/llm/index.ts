// LLM 자리의 문. 꼴은 src/contract/llm-types.ts 에 있다.
// 이 폴더는 DB 를 모른다. 장부를 읽고 쓰는 자리(LlmCallStore)는 부르는 쪽이 넘긴다.
import type { LlmApi } from '@/contract/llm-types';
import { cacheKeyFor } from './keys';
import { costUsd, priceOf } from './pricing';
import { buildContentRequestV1 } from './prompts/content.v1';
import { buildExtractRequestV1 } from './prompts/extract.v1';
import { createProvider } from './provider';

// 지금 쓰는 프롬프트 버전. 새 버전을 채택하면 여기 두 줄만 바꾼다.
export const buildExtractRequest: LlmApi['buildExtractRequest'] = buildExtractRequestV1;
export const buildContentRequest: LlmApi['buildContentRequest'] = buildContentRequestV1;

export { cacheKeyFor, costUsd, createProvider, priceOf };
export { providerFromEnv } from './provider';
export { JsonlCallStore, MemoryCallStore } from './stores';

// 내보낸 것이 약속과 같은 꼴인지 타입 검사가 본다.
const api: LlmApi = { createProvider, cacheKeyFor, buildExtractRequest, buildContentRequest, costUsd, priceOf };
export default api;
