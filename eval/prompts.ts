// 평가가 아는 뽑기 프롬프트 판. --prompts v1,v2 로 판을 견줄 때 이 표에서 찾는다.
// 새 판(src/llm/prompts/extract.vN.ts)을 만들면 여기에 한 줄 더한다.
import type { Extraction } from '@/contract/fields';
import type { LlmRequest } from '@/contract/llm-types';
import { buildExtractRequest } from '@/llm';
import { buildExtractRequestV1 } from '@/llm/prompts/extract.v1';
import { buildExtractRequestV2 } from '@/llm/prompts/extract.v2';
import { buildExtractRequestV3 } from '@/llm/prompts/extract.v3';
import { buildExtractRequestV4 } from '@/llm/prompts/extract.v4';

export type ExtractBuilder = (cleanText: string) => LlmRequest<Extraction>;

export const EXTRACT_PROMPTS: Record<string, ExtractBuilder> = {
  /** 지금 파이프라인이 쓰는 판(src/llm/index.ts 가 고른 것) */
  current: buildExtractRequest,
  v1: buildExtractRequestV1,
  /** 시도 2: 갈래를 닫힌 목록 안에서만 고른다. 재 보고 버린 판이다(docs/EVAL-LOG.md 시도 2). 견줄 때만 쓴다. 다음 판은 v1 에서 만든다. */
  v2: buildExtractRequestV2,
  /** 시도 3: 기간·수량에 따른 값이 하나뿐이어도 옵션 칸에 한 줄짜리 목록으로 적는다. v1 에서 만들었다. 재 보고 버린 판이다(docs/EVAL-LOG.md 시도 3). 견줄 때만 쓴다. */
  v3: buildExtractRequestV3,
  /** 시도 4: 원문 표현(raw)에는 값의 글자만 적는다(이름표·머리말·문장째 금지, 섞인 언어에서도 상품 이름은 원문 그대로). v1 에서 만들었다. 재 보고 버린 판이다(docs/EVAL-LOG.md 시도 4). 견줄 때만 쓴다. */
  v4: buildExtractRequestV4,
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
