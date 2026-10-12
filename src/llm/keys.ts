// 요청에서 장부 키를 만든다. 답의 꼴은 프롬프트 버전별 등록(wire.ts)에서 가져온다.
import { createHash } from 'node:crypto';
import type { LlmAttachment, LlmRequest } from '@/contract/llm-types';
import { cacheKey } from './cache-key';
import { jsonSchemaOf, LLM_EFFORT, wireFor } from './wire';

/**
 * 파일 바이트의 sha256(16진수). base64 글이 아니라 풀어낸 바이트로 낸다. source_docs.file_hash 와 같은 값이다.
 * 한 바이트만 달라도 값이 달라진다.
 */
export function attachmentHash(attachment: Pick<LlmAttachment, 'dataBase64'>): string {
  return createHash('sha256').update(Buffer.from(attachment.dataBase64, 'base64')).digest('hex');
}

/**
 * 키에 들어가는 입력. 첨부가 없으면 입력 그대로다(첨부가 생기기 전에 만든 키가 달라지지 않는다).
 * 첨부가 있으면 파일마다 종류·형식·해시를 함께 넣는다. 그림이 다르면 키가 다르다. 파일 자체는 넣지 않는다.
 */
function keyInput(req: LlmRequest<unknown>): unknown {
  if (!req.attachments || req.attachments.length === 0) return req.input;
  return {
    input: req.input,
    attachments: req.attachments.map((a) => ({ kind: a.kind, mediaType: a.mediaType, sha256: attachmentHash(a) })),
  };
}

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
    input: keyInput(req),
  });
}
