// 보기 글(data/seed/samples.json). 첫 줄이 첫 화면에 미리 들어가는 글이다.
// 보기 글의 AI 답은 미리 받아 둔 녹화본이다. 녹화본이 장부에 있는지도 함께 알려 준다.
import { z } from 'zod';
import { SampleSchema, type Sample, type SampleListResponse } from '@/contract/api';
import type { LlmCallStore, LlmRequest } from '@/contract/llm-types';
import { buildExtractRequest, cacheKeyFor } from '@/llm';
import samplesJson from '../../data/seed/samples.json';
import { cleanText } from './limits';
import { llmRouterFromEnv } from './llm-router';
import { PgLlmCallStore } from './repos/llm-calls';

/** 보기 글 전부. 꼴이 틀리면 여기서 멈춘다. */
export function seedSamples(): Sample[] {
  return z.array(SampleSchema).parse(samplesJson);
}

/** 이 글의 뽑기 요청이 장부에서 갖는 키. 접수 때와 같은 글 정리를 거친다. */
export function sampleCacheKey(text: string, model: string): string {
  return cacheKeyFor(buildExtractRequest(cleanText(text)) as LlmRequest<unknown>, model);
}

/** 보기 글 목록과 녹화본이 있는지. */
export async function sampleList(options: { store?: LlmCallStore; model?: string } = {}): Promise<SampleListResponse> {
  const store = options.store ?? new PgLlmCallStore();
  const model = options.model ?? llmRouterFromEnv().model;
  const items = [];
  for (const sample of seedSamples()) {
    items.push({ ...sample, recorded: (await store.find(sampleCacheKey(sample.text, model))) !== null });
  }
  return { items };
}
