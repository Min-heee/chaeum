// LLM 자리의 문. 지금은 껍데기다. 꼴은 src/contract/llm-types.ts 에 있다.
// 이 폴더는 DB 를 모른다. 장부를 읽고 쓰는 자리(LlmCallStore)는 부르는 쪽이 넘긴다.
import type { LlmApi } from '@/contract/llm-types';

function notBuilt(name: string): never {
  throw new Error(`아직 안 만듦: llm.${name}`);
}

export const createProvider: LlmApi['createProvider'] = () => notBuilt('createProvider');
export const cacheKeyFor: LlmApi['cacheKeyFor'] = () => notBuilt('cacheKeyFor');
export const buildExtractRequest: LlmApi['buildExtractRequest'] = () => notBuilt('buildExtractRequest');
export const buildContentRequest: LlmApi['buildContentRequest'] = () => notBuilt('buildContentRequest');
export const costUsd: LlmApi['costUsd'] = () => notBuilt('costUsd');
export const priceOf: LlmApi['priceOf'] = () => notBuilt('priceOf');

// 내보낸 것이 약속과 같은 꼴인지 타입 검사가 본다.
const api: LlmApi = { createProvider, cacheKeyFor, buildExtractRequest, buildContentRequest, costUsd, priceOf };
export default api;
