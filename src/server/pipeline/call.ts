// 단계 셋이 함께 쓰는 작은 것: 호출 기록 만들기, 실패를 규칙만 길의 원인으로 바꾸기.
import { LlmUnavailable, type LlmProvider, type LlmResult } from '@/contract/llm-types';
import type { LlmCallInfo, LlmPick, LlmRoute } from '@/contract/pipeline-api';
import type { LlmSkipCause } from '@/contract/reasons';
import { costUsd } from '@/llm';

/** 호출 한 번의 기록. 비용은 토큰 수와 단가로 낸다(녹화본이면 녹화할 때의 토큰 수라 그때의 비용이 된다). */
export function callInfo(route: Exclude<LlmRoute, 'rules'>, provider: LlmProvider, promptVersion: string, result: LlmResult<unknown>): LlmCallInfo {
  let cost = 0;
  try {
    cost = costUsd(provider.model, result.usage);
  } catch {
    // 단가를 모르는 모델이면 0 으로 둔다. 초안을 만드는 일을 이것 때문에 멈추지 않는다.
  }
  return {
    recorded: result.recorded,
    live: route === 'anthropic' && !result.recorded,
    model: provider.model,
    promptVersion,
    latencyMs: result.latencyMs,
    costUsd: cost,
  };
}

/** 규칙만 길의 원인을 공급자 오류로 바꾼다. 글 만들기에서 두 번째 호출의 길이 막혔을 때 쓴다. */
export function unavailableFor(cause: LlmSkipCause): LlmUnavailable {
  switch (cause) {
    case 'no_key':
      return new LlmUnavailable('NO_KEY', 'API 키가 없다');
    case 'cache_miss':
      return new LlmUnavailable('CACHE_MISS', '이 요청의 녹화가 없다');
    case 'refusal':
      return new LlmUnavailable('REFUSAL', '모델이 거절했다');
    default:
      return new LlmUnavailable('BAD_REQUEST', `실제 호출을 할 수 없다 (${cause})`);
  }
}

/** 고른 길이 규칙만인가. 타입을 좁힌다. */
export function isRules(pick: LlmPick): pick is Extract<LlmPick, { route: 'rules' }> {
  return pick.route === 'rules';
}

/** 글자 수. 이모지도 하나로 센다. */
export const chars = (text: string): number => [...text].length;
