// 핵심 약속: 글 만들기 요청에는 숫자 값이 없다.
// 그래서 값을 고쳐 승인해도 장부 키가 같고, 받아 둔 답(녹화본)이 그대로 맞는다.
import { describe, expect, it } from 'vitest';
import type { ContentDraft, GenerateContentInput } from '@/contract/content';
import type { LlmCallRecord, LlmRequest } from '@/contract/llm-types';
import { buildContentRequest, cacheKeyFor, createProvider, MemoryCallStore } from '@/llm';
import { AD, AD_VALUES, GLOSSARY, GOOD_AD, inputOf, scripted, TEST_MODEL, withLine } from './fixtures';
import { generateContent } from './generate';
import { templateTexts } from './template';

const MODEL = 'model-for-replay';

/** generateContent 가 실제로 보낸 요청들의 장부 키. */
async function keysSent(input: GenerateContentInput, steps: readonly ContentDraft[]): Promise<string[]> {
  const { provider, requests } = scripted(steps);
  await generateContent(input, provider);
  return requests.map((req) => cacheKeyFor(req, TEST_MODEL));
}

/** 첫 요청의 키. 답이 검사에 걸려 한 번 더 부르더라도 첫 요청만 본다. */
async function firstKey(input: GenerateContentInput): Promise<string> {
  const keys = await keysSent(input, [GOOD_AD, GOOD_AD]);
  return keys[0]!;
}

/** 실제 호출이 장부에 적은 것과 같은 꼴의 줄. */
function recorded(req: LlmRequest<unknown>, response: unknown): LlmCallRecord {
  return {
    task: req.task, provider: 'anthropic', model: MODEL, promptVersion: req.promptVersion,
    cacheKey: cacheKeyFor(req, MODEL), response, stopReason: 'end_turn',
    inputTokens: 900, outputTokens: 200, costUsd: 0.0002, latencyMs: 1500, isRecorded: true,
  };
}

describe('글 만들기 요청의 장부 키', () => {
  const original = inputOf(AD, AD_VALUES);
  const repriced = inputOf(AD, { price: 990_000, days: 14 });

  it('값만 다른 두 상품은 요청 키가 같다', async () => {
    const a = await firstKey(original);
    const b = await firstKey(repriced);
    expect(a).toBe(b);
    // 처리기가 길을 고를 때 만드는 키(buildContentRequest(content))와도 같다.
    expect(a).toBe(cacheKeyFor(buildContentRequest(original.content) as LlmRequest<unknown>, TEST_MODEL));
  });

  it('이름이 다르면 키가 다르다', async () => {
    const a = await firstKey(original);
    const b = await firstKey(inputOf({ ...AD, name: '하늘빛 전광판 2호' }, AD_VALUES));
    expect(a).not.toBe(b);
  });

  it.each([
    ['갈래', { ...AD, subtype: '지하철' }],
    ['지역', { ...AD, region: '합정역' }],
    ['종류', { ...AD, type: 'goods' as const }],
  ])('%s가 다르면 키가 다르다', async (_label, facts) => {
    const a = await firstKey(original);
    const b = await firstKey(inputOf(facts, AD_VALUES));
    expect(a).not.toBe(b);
  });

  it('쓸 수 있는 자리표시가 다르면 키가 다르다(기간 옵션이 없어진 상품)', async () => {
    const a = await firstKey(original);
    const b = await firstKey(inputOf(AD, { price: 1_500_000 }));
    expect(a).not.toBe(b);
  });

  it('용어집에 상관없는 줄을 더하거나 줄 순서를 바꿔도 키가 같다', async () => {
    const more = [{ ko: '성수동', en: 'Seongsu-dong', 'zh-Hans': '圣水洞' }, ...[...GLOSSARY].reverse()];
    const a = await firstKey(original);
    const b = await firstKey(inputOf(AD, AD_VALUES, more));
    expect(a).toBe(b);
  });

  it('이 상품에 해당하는 용어의 표기를 고치면 키가 다르다', async () => {
    const edited = GLOSSARY.map((e) => (e.ko === '전광판' ? { ...e, en: 'LED billboard' } : e));
    const a = await firstKey(original);
    const b = await firstKey(inputOf(AD, AD_VALUES, edited));
    expect(a).not.toBe(b);
  });

  it('다시 한 요청도 값만 다르면 키가 같고, 첫 요청과는 다르다', async () => {
    const broken = withLine(GOOD_AD, 'en', 'summary', 'A digital billboard at Gangnam Station Exit 11, from 1,500,000 won.');
    const a = await keysSent(original, [broken, GOOD_AD]);
    const b = await keysSent(repriced, [broken, GOOD_AD]);
    expect(a).toHaveLength(2);
    expect(a).toEqual(b);
    expect(a[0]).not.toBe(a[1]);
  });
});

describe('받아 둔 답으로 다시 돌리기(녹화 재생)', () => {
  const original = inputOf(AD, AD_VALUES);
  const store = new MemoryCallStore([recorded(buildContentRequest(original.content) as LlmRequest<unknown>, GOOD_AD)]);
  const replay = createProvider({ kind: 'replay', model: MODEL, store });

  it('값을 고쳐 승인한 상품도 같은 녹화 답을 받고, 숫자만 새 값으로 들어간다', async () => {
    const out = await generateContent(inputOf(AD, { price: 990_000, days: 14 }), replay);
    expect(out.skipCause).toBeNull();
    expect(out.calls).toEqual([{ attempt: 1, recorded: true, latencyMs: 1500, usage: { inputTokens: 900, outputTokens: 200 } }]);
    expect(out.texts.map((t) => t.source)).toEqual(['llm', 'llm', 'llm', 'llm']);
    expect(out.texts[1]!.text).toBe('A digital billboard at Gangnam Station Exit 11, from KRW 990,000 for 14 days.');
    expect(out.texts[3]!.text).toBe('江南站11号出口的电子屏广告位，14天990,000韩元起。');
  });

  it('이름을 고친 상품은 녹화가 없으므로 틀 문장으로 내려가고 까닭이 남는다', async () => {
    const renamed = inputOf({ ...AD, name: '새하늘 전광판' }, AD_VALUES);
    const out = await generateContent(renamed, replay);
    expect(out.skipCause).toBe('cache_miss');
    expect(out.calls).toEqual([]);
    expect(out.texts).toEqual(templateTexts(renamed));
  });

  it('첫 답의 녹화만 있고 다시 한 답의 녹화가 없으면: 통과한 줄은 녹화 답, 걸린 줄만 틀 문장', async () => {
    const broken = withLine(GOOD_AD, 'zh-Hans', 'summary', '江南站11号出口的电子屏广告位，{price}起。');
    const firstOnly = new MemoryCallStore([recorded(buildContentRequest(original.content) as LlmRequest<unknown>, broken)]);
    const out = await generateContent(original, createProvider({ kind: 'replay', model: MODEL, store: firstOnly }));
    expect(out.texts.map((t) => t.source)).toEqual(['llm', 'llm', 'llm', 'template']);
    expect(out.texts[3]!.failCodes).toEqual(['PLACEHOLDER_LOST']);
    expect(out.skipCause).toBeNull();
    expect(out.calls).toHaveLength(1);
  });
});
