// 평가가 아는 뽑기 프롬프트 판. --prompts v1,v2 로 판을 견줄 때 이 표에서 찾는다.
// 새 판(src/llm/prompts/extract.v2.ts)을 만들면 여기에 한 줄 더한다.
import type { Extraction } from '@/contract/fields';
import type { LlmRequest } from '@/contract/llm-types';
import { buildExtractRequest } from '@/llm';
import { buildExtractRequestV1 } from '@/llm/prompts/extract.v1';

export type ExtractBuilder = (cleanText: string) => LlmRequest<Extraction>;

export const EXTRACT_PROMPTS: Record<string, ExtractBuilder> = {
  /** 지금 파이프라인이 쓰는 판(src/llm/index.ts 가 고른 것) */
  current: buildExtractRequest,
  v1: buildExtractRequestV1,
};

/** "v1,current" 같은 글을 판 목록으로. 모르는 판이면 오류. */
export function pickPrompts(raw: string | undefined): { name: string; build: ExtractBuilder }[] {
  const names = (raw ?? 'current').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(names)].map((name) => {
    const build = EXTRACT_PROMPTS[name];
    if (!build) throw new Error(`모르는 프롬프트 판: ${name} (아는 판: ${Object.keys(EXTRACT_PROMPTS).join(', ')})`);
    return { name, build };
  });
}
