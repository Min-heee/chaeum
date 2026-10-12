// 3) 글 만들기. 길을 고른 뒤 src/content 의 generateContent 를 약속 시그니처로 부른다.
// 글 만들기는 모델을 두 번까지 부른다(걸린 검사를 알려 준 다시 하기). 호출마다 길을 다시 고른다:
// 첫 요청의 녹화만 있고 다시 한 요청의 녹화가 없을 수 있고, 실제 호출이면 호출마다 하루 자리를 하나씩 쓴다.
import type { ContentApi } from '@/contract/content';
import { isLlmUnavailable, LlmUnavailable, type LlmProvider, type LlmRequest, type LlmResult } from '@/contract/llm-types';
import { afterLlmFailure, type ContentStep, type LlmPick, type LlmRouter } from '@/contract/pipeline-api';
import { buildContentRequest, cacheKeyFor } from '@/llm';
import { chars, isRules, unavailableFor } from './call';

/**
 * 호출마다 길을 고르는 공급자. 첫 호출은 이미 고른 길을 쓴다.
 * 다시 한 호출(둘째부터)이 잠깐의 오류로 실패했는데 이번이 마지막 시도라면, 다시 해 볼 수 없는 오류로 바꿔 던진다.
 * 그러면 글 만들기가 첫 답에서 통과한 줄은 살리고 걸린 줄만 틀 문장으로 바꾼다(처음부터 전부 틀 문장이 되지 않는다).
 */
function routedProvider(router: LlmRouter, first: Exclude<LlmPick, { route: 'rules' }>, now: Date, attempt: number): LlmProvider {
  let used = false;
  return {
    name: first.provider.name,
    model: router.model,
    async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      if (!used) {
        used = true;
        return first.provider.complete(req);
      }
      const plain = req as LlmRequest<unknown>;
      const pick = await router.pick({ task: req.task, cacheKey: cacheKeyFor(plain, router.model), textChars: chars(JSON.stringify(req.input)), now });
      if (isRules(pick)) throw unavailableFor(pick.cause);
      try {
        return await pick.provider.complete(req);
      } catch (err) {
        if (isLlmUnavailable(err) && err.retryable && afterLlmFailure(err.code, attempt) !== 'retry') {
          throw new LlmUnavailable('BAD_REQUEST', '마지막 시도에서 다시 한 호출이 잠깐의 오류로 실패했다');
        }
        throw err;
      }
    },
  };
}

/** 글 만들기 단계를 만든다. content 는 src/content 가 내보내는 것(시험에서는 가짜)이다. */
export function createContentStep(content: Pick<ContentApi, 'generateContent'>): ContentStep {
  return async (input, router) => {
    const req = buildContentRequest(input.generate.content);
    const pick = await router.pick({
      task: 'content',
      cacheKey: cacheKeyFor(req as LlmRequest<unknown>, router.model),
      textChars: chars(JSON.stringify(req.input)),
      now: input.now,
    });
    if (isRules(pick)) return content.generateContent(input.generate, null, pick.cause);

    try {
      return await content.generateContent(input.generate, routedProvider(router, pick, input.now, input.attempt));
    } catch (err) {
      if (!isLlmUnavailable(err)) throw err;
      const after = afterLlmFailure(err.code, input.attempt);
      if (after === 'retry') throw err;
      // 마지막 시도에서 첫 호출부터 잠깐의 오류였다. 살릴 답이 없으니 틀 문장으로 내려가고 그렇게 표시한다.
      return content.generateContent(input.generate, null, after);
    }
  };
}
