// LLM 길을 고르는 자리(약속의 LlmRouter)를 채운다.
// 고르는 규칙 자체는 순수 함수(planLlmRoute)이고, 여기는 그 재료를 모으는 얇은 층이다:
//   장부에 답이 있는가 · 환경 변수로 정해진 방식 · 키가 있는가 · 하루 상한 · 오늘 자리 잡기.
import { DEFAULT_LLM_MODEL, llmKindFromEnv, type LlmCallStore, type LlmProvider, type LlmProviderName, type LlmRequest } from '@/contract/llm-types';
import { LIVE_LLM, parseDailyCap, planLlmRoute, type LlmPick, type LlmRouter } from '@/contract/pipeline-api';
import { createProvider } from '@/llm';
import { getPool } from './db';
import { takeLiveLlmSlot } from './limits';
import { readCounter } from './repos/daily-counters';
import { PgLlmCallStore } from './repos/llm-calls';
import type { Db } from './types';

export interface LlmRouterConfig {
  /** 환경 변수로 정해진 방식 */
  providerKind: LlmProviderName;
  /** 비우면 가장 작은 모델 */
  model?: string;
  /** 없으면 실제 호출을 하지 않는다. 값은 어디에도 찍지 않는다. */
  apiKey?: string;
  /** 하루 실제 호출 상한. 0 이면 꺼짐. */
  dailyCap: number;
  /** 장부. 비우면 DB 의 llm_calls. */
  store?: LlmCallStore;
  /** 하루 자리를 세는 DB. 비우면 풀. */
  db?: Db;
  /** 시험용 방식(fake)일 때의 답 */
  fakeAnswer?: (req: LlmRequest<unknown>) => unknown;
  /** 시험용. 실제 호출 공급자를 바꿔 끼운다(네트워크 없이 실제 호출 길을 시험한다). */
  liveProvider?: LlmProvider;
}

/** 환경 변수에서 설정을 읽는다. LLM_PROVIDER 값이 틀렸으면 오류를 던진다. */
export function routerConfigFromEnv(env: Record<string, string | undefined>): LlmRouterConfig {
  return {
    providerKind: llmKindFromEnv(env),
    model: env.LLM_MODEL?.trim() || undefined,
    apiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
    dailyCap: parseDailyCap(env[LIVE_LLM.capEnv]),
  };
}

export function createLlmRouter(config: LlmRouterConfig): LlmRouter {
  const model = config.model?.trim() || DEFAULT_LLM_MODEL;
  const store = config.store ?? new PgLlmCallStore({ db: config.db });
  const db = () => config.db ?? getPool();
  const hasKey = Boolean(config.apiKey) || Boolean(config.liveProvider);

  // 공급자는 처음 쓸 때 한 번 만든다.
  const made: Partial<Record<LlmProviderName, LlmProvider>> = {};
  const providerOf = (kind: LlmProviderName): LlmProvider => {
    if (kind === 'anthropic' && config.liveProvider) return config.liveProvider;
    made[kind] ??= createProvider({ kind, model, store, apiKey: config.apiKey, fakeAnswer: config.fakeAnswer });
    return made[kind];
  };

  return {
    model,
    async pick({ cacheKey, textChars, now }): Promise<LlmPick> {
      // 시험용 방식이면 장부를 볼 것도 없다.
      const hasRecording = config.providerKind === 'fake' ? false : (await store.find(cacheKey)) !== null;
      const plan = planLlmRoute({ hasRecording, providerKind: config.providerKind, hasKey, dailyCap: config.dailyCap, textChars });
      if (plan.route === 'rules') return { route: 'rules', provider: null, cause: plan.cause };
      if (plan.route === 'anthropic') {
        // 부르기 전에 오늘 자리를 먼저 잡는다. 여럿이 한꺼번에 와도 상한을 넘지 않는다.
        const got = await takeLiveLlmSlot(db(), now, config.dailyCap);
        if (!got) return { route: 'rules', provider: null, cause: 'daily_cap' };
      }
      return { route: plan.route, provider: providerOf(plan.route) };
    },
  };
}

let fromEnv: LlmRouter | undefined;

/** 환경 변수로 만든 자리 하나. 서버가 도는 동안 같은 것을 쓴다. */
export function llmRouterFromEnv(): LlmRouter {
  fromEnv ??= createLlmRouter(routerConfigFromEnv(process.env));
  return fromEnv;
}

/** /health 가 보여 주는 것: 방식, 실제 호출이 열려 있는가, 모델, 오늘의 상한과 남은 수. */
export async function llmStatus(
  env: Record<string, string | undefined>,
  now: Date,
  db: Db = getPool(),
): Promise<{ provider: LlmProviderName | 'invalid'; live: boolean; model: string; liveCap: number; liveLeftToday: number }> {
  const model = env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;
  let config: LlmRouterConfig;
  try {
    config = routerConfigFromEnv(env);
  } catch {
    return { provider: 'invalid', live: false, model, liveCap: 0, liveLeftToday: 0 };
  }
  // 실제 호출이 열려 있다: 키가 있고, 방식이 녹화만으로 묶이지 않았고, 하루 상한이 0 보다 크다.
  const live = config.providerKind === 'anthropic' && Boolean(config.apiKey) && config.dailyCap > 0;
  const liveCap = live ? config.dailyCap : 0;
  const used = live ? await readCounter(db, 'live_llm', now) : 0;
  return { provider: config.providerKind, live, model, liveCap, liveLeftToday: Math.max(0, liveCap - used) };
}
