// 글 만들기 단계: 다시 한 호출이 잠깐의 오류로 실패했을 때. 진짜 글 만들기(src/content)에 정해 둔 답을 내주는 공급자를 끼운다.
import { describe, expect, it } from 'vitest';
import { QUEUE } from '@/contract/api';
import { LlmUnavailable } from '@/contract/llm-types';
import type { LlmPick, LlmRouter } from '@/contract/pipeline-api';
import content from '@/content';
import { AD, AD_VALUES, GOOD_AD, inputOf, scripted, TEST_MODEL, withLine } from '@/content/fixtures';
import { createContentStep } from '@/server/pipeline/content';

const NOW = new Date('2001-06-01T03:00:00Z');
/** 영어 요약만 검사에 걸리는 첫 답(자리표시 밖 숫자). 나머지 세 줄은 통과한다. */
const ONE_BAD = withLine(GOOD_AD, 'en', 'summary', `${GOOD_AD.en.summary} Seen by 300,000 people a day.`);

/** 언제나 같은 공급자를 내주는 길 고르기. */
function routerOf(provider: ReturnType<typeof scripted>['provider']): LlmRouter {
  return { model: TEST_MODEL, pick: async (): Promise<LlmPick> => ({ route: 'fake', provider }) };
}

describe('글 만들기 단계: 다시 한 호출의 잠깐 오류', () => {
  const step = createContentStep(content);
  const generate = inputOf(AD, AD_VALUES);

  it('마지막 시도면 첫 답에서 통과한 줄은 살리고 걸린 줄만 틀 문장이 된다. 첫 호출의 기록도 남는다', async () => {
    const { provider, requests } = scripted([ONE_BAD, new LlmUnavailable('TRANSIENT', '잠깐')]);
    const out = await step({ generate, attempt: QUEUE.maxAttempts, now: NOW }, routerOf(provider));

    expect(requests).toHaveLength(2);
    expect(out.skipCause).toBeNull();
    expect(out.texts.map((t) => t.source)).toEqual(['llm', 'template', 'llm', 'llm']);
    expect(out.texts[1]).toMatchObject({ status: 'needs_review', failCodes: ['STRAY_NUMBER'] });
    expect(out.calls.map((c) => c.attempt)).toEqual([1]);
  });

  it('시도가 남았으면 그대로 던져 작업 줄이 다시 하게 한다', async () => {
    const { provider } = scripted([ONE_BAD, new LlmUnavailable('TRANSIENT', '잠깐')]);
    const tried = step({ generate, attempt: 1, now: NOW }, routerOf(provider));
    await expect(tried).rejects.toMatchObject({ code: 'TRANSIENT', retryable: true });
  });

  it('마지막 시도에서 첫 호출부터 잠깐의 오류면 네 줄 모두 틀 문장이고 까닭이 남는다', async () => {
    const { provider } = scripted([new LlmUnavailable('TRANSIENT', '잠깐')]);
    const out = await step({ generate, attempt: QUEUE.maxAttempts, now: NOW }, routerOf(provider));
    expect(out.skipCause).toBe('error');
    expect(out.texts.every((t) => t.source === 'template' && t.status === 'needs_review')).toBe(true);
  });
});
