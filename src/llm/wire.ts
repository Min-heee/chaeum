// 프롬프트 버전별로 "모델에게 요구하는 답의 꼴"을 모아 둔다.
// 요청(LlmRequest)의 schema 는 받은 답을 다시 검사하는 데 쓰고, 여기의 wire 는 모델에게 보내는 데 쓴다.
import { z } from 'zod';
import { ContentDraftSchema } from '@/contract/content';
import type { LlmRequest } from '@/contract/llm-types';
import { CONTENT_PROMPT_VERSION, CONTENT_SCHEMA_VERSION } from './prompts/content.v1';
import { EXTRACT_PROMPT_VERSION, EXTRACT_SCHEMA_VERSION, ExtractWireSchema, extractWireToOutput, type ExtractWire } from './prompts/extract.v1';
import {
  EXTRACT_PROMPT_VERSION_V2,
  EXTRACT_SCHEMA_VERSION_V2,
  ExtractWireSchemaV2,
  extractWireToOutputV2,
  type ExtractWireV2,
} from './prompts/extract.v2';
import {
  EXTRACT_PROMPT_VERSION_V3,
  EXTRACT_SCHEMA_VERSION_V3,
  ExtractWireSchemaV3,
  extractWireToOutputV3,
  type ExtractWireV3,
} from './prompts/extract.v3';
import {
  EXTRACT_PROMPT_VERSION_V4,
  EXTRACT_SCHEMA_VERSION_V4,
  ExtractWireSchemaV4,
  extractWireToOutputV4,
  type ExtractWireV4,
} from './prompts/extract.v4';
import {
  TRANSCRIBE_PROMPT_VERSION,
  TRANSCRIBE_SCHEMA_VERSION,
  TranscribeWireSchema,
  transcribeWireToOutput,
  type TranscribeWire,
} from './prompts/transcribe.v1';

/** 생각을 얼마나 깊이 할지. 받아 적기, 뽑기, 짧은 글에는 가장 낮은 단계로 충분하다고 보고 시작한다. 장부 키에도 들어간다. */
export const LLM_EFFORT = 'low' as const;

export interface WireFormat {
  /** 장부 키에 들어간다. */
  schemaVersion: string;
  /** 모델에게 보내는 꼴. */
  wire: z.ZodType;
  /** 받은 답을 요청의 schema 가 검사할 꼴로 옮긴다. */
  toOutput(wire: unknown): unknown;
}

const BY_PROMPT_VERSION: Record<string, WireFormat> = {
  [TRANSCRIBE_PROMPT_VERSION]: {
    schemaVersion: TRANSCRIBE_SCHEMA_VERSION,
    wire: TranscribeWireSchema,
    toOutput: (w) => transcribeWireToOutput(w as TranscribeWire),
  },
  [EXTRACT_PROMPT_VERSION]: {
    schemaVersion: EXTRACT_SCHEMA_VERSION,
    wire: ExtractWireSchema,
    toOutput: (w) => extractWireToOutput(w as ExtractWire),
  },
  // 평가가 견주는 판. 파이프라인이 쓰는 판은 index.ts 가 고른다(지금은 v1).
  [EXTRACT_PROMPT_VERSION_V2]: {
    schemaVersion: EXTRACT_SCHEMA_VERSION_V2,
    wire: ExtractWireSchemaV2,
    toOutput: (w) => extractWireToOutputV2(w as ExtractWireV2),
  },
  [EXTRACT_PROMPT_VERSION_V3]: {
    schemaVersion: EXTRACT_SCHEMA_VERSION_V3,
    wire: ExtractWireSchemaV3,
    toOutput: (w) => extractWireToOutputV3(w as ExtractWireV3),
  },
  [EXTRACT_PROMPT_VERSION_V4]: {
    schemaVersion: EXTRACT_SCHEMA_VERSION_V4,
    wire: ExtractWireSchemaV4,
    toOutput: (w) => extractWireToOutputV4(w as ExtractWireV4),
  },
  [CONTENT_PROMPT_VERSION]: {
    schemaVersion: CONTENT_SCHEMA_VERSION,
    wire: ContentDraftSchema,
    toOutput: (w) => w,
  },
};

/** 등록되지 않은 프롬프트 버전이면 요청의 schema 를 그대로 보낸다. */
export function wireFor(req: LlmRequest<unknown>): WireFormat {
  return BY_PROMPT_VERSION[req.promptVersion] ?? { schemaVersion: 'plain-1', wire: req.schema, toOutput: (w) => w };
}

/** 구조화 출력이 받는 JSON 스키마 낱말. 이 밖의 것이 섞이면 API 가 400 을 낸다. */
export const SUPPORTED_SCHEMA_WORDS: readonly string[] = [
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', '$ref', '$defs', 'description',
];

/**
 * 모델에게 보낼 JSON 스키마를 만든다.
 * SDK 의 zod 도우미는 enum 을 설명 글로 내려 버려서(강제가 풀린다) 쓰지 않고, zod 가 만든 스키마를 그대로 보낸다.
 * 그래서 wire 스키마에는 길이·범위·정규식 같은 제약을 넣지 않는다(시험이 지켜본다).
 */
export function jsonSchemaOf(wire: z.ZodType): Record<string, unknown> {
  const { $schema: _dropped, ...schema } = z.toJSONSchema(wire) as Record<string, unknown>;
  void _dropped;
  return schema;
}
