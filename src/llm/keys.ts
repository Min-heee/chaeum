// 요청에서 장부 키를 만든다. 답의 꼴은 프롬프트 버전별 등록(wire.ts)에서 가져온다.
import type { LlmRequest } from '@/contract/llm-types';
import { cacheKey } from './cache-key';
import { jsonSchemaOf, LLM_EFFORT, wireFor } from './wire';

/**
 * 버전 이름뿐 아니라 시스템 글과 보내는 스키마 자체가 키에 들어간다.
 * 약속 파일에서 칸을 더하거나 설명을 고치면 프롬프트와 스키마가 바뀌므로 키도 바뀌고,
 * 녹화 재생은 옛 답을 내주지 않고 "녹화 없음"으로 멈춘다.
 */
export function cacheKeyFor(req: LlmRequest<unknown>, model: string): string {
  const wire = wireFor(req);
  return cacheKey({
    task: req.task,
    model,
    promptVersion: req.promptVersion,
    schemaVersion: wire.schemaVersion,
    system: req.system,
    wireSchema: jsonSchemaOf(wire.wire),
    effort: LLM_EFFORT,
    input: req.input,
  });
}
