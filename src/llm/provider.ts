// 구현 셋 가운데 하나를 골라 끼운다.
import {
  DEFAULT_LLM_MODEL,
  llmKindFromEnv,
  type CreateProviderOptions,
  type LlmCallStore,
  type LlmProvider,
} from '@/contract/llm-types';
import { createAnthropicProvider } from './anthropic';
import { createFakeProvider } from './fake';
import { createReplayProvider } from './replay';

export function createProvider(options: CreateProviderOptions): LlmProvider {
  const model = options.model?.trim() || DEFAULT_LLM_MODEL;
  switch (options.kind) {
    case 'anthropic':
      return createAnthropicProvider({ model, apiKey: options.apiKey, store: options.store });
    case 'replay':
      return createReplayProvider({ model, store: options.store });
    case 'fake':
      return createFakeProvider({ model, store: options.store, fakeAnswer: options.fakeAnswer });
    default:
      throw new Error(`모르는 LLM 방식: ${String(options.kind)}`);
  }
}

/**
 * 환경 변수로 구현을 고른다.
 * LLM_PROVIDER(anthropic | replay | fake. 비우면 키가 있을 때 anthropic, 없을 때 replay), LLM_MODEL(비우면 가장 작은 모델).
 * 키는 여기서 읽어 넘기기만 하고 어디에도 찍지 않는다.
 */
export function providerFromEnv(env: Record<string, string | undefined>, store?: LlmCallStore): LlmProvider {
  return createProvider({
    kind: llmKindFromEnv(env),
    model: env.LLM_MODEL,
    apiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
    store,
  });
}
