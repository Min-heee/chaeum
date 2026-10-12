// 글 만들기 시험: 검사 → 한 번 다시 → 틀 문장. 모델은 정해 둔 답을 내주는 가짜다.
import { describe, expect, it } from 'vitest';
import type { ContentDraft } from '@/contract/content';
import { LlmUnavailable, type LlmUnavailableCode } from '@/contract/llm-types';
import type { ContentFailCode, LlmSkipCause } from '@/contract/reasons';
import { createProvider } from '@/llm';
import {
  AD,
  AD_VALUES,
  CATERING,
  CATERING_VALUES,
  GOOD_AD,
  GOOD_CATERING,
  GOOD_GOODS,
  GOODS,
  GOODS_VALUES,
  inputOf,
  scripted,
  withLine,
} from './fixtures';
import { hasBraces } from './format';
import api, { generateContent, templateTexts } from './index';

const retryHintIn = (req: { input: unknown } | undefined): string | undefined => (req?.input as { retryHint?: string } | undefined)?.retryHint;

describe('글 만들기: 통과하는 답', () => {
  it('모델을 한 번만 부르고, 네 줄 모두 모델 글에 숫자를 넣어 낸다', async () => {
    const { provider, requests } = scripted([GOOD_AD]);
    const out = await generateContent(inputOf(AD, AD_VALUES), provider);

    expect(requests).toHaveLength(1);
    expect(out.skipCause).toBeNull();
    expect(out.calls).toEqual([{ attempt: 1, recorded: false, latencyMs: 12, usage: { inputTokens: 100, outputTokens: 50 } }]);
    expect(out.texts).toEqual([
      { field: 'title', lang: 'en', text: 'Haneulbit Digital Billboard', source: 'llm', status: 'ok', failCodes: [], withPlaceholders: 'Haneulbit Digital Billboard' },
      {
        field: 'summary', lang: 'en', source: 'llm', status: 'ok', failCodes: [],
        text: 'A digital billboard at Gangnam Station Exit 11, from KRW 1,500,000 for 7 days.',
        withPlaceholders: 'A digital billboard at Gangnam Station Exit 11, from {price} for {days} days.',
      },
      { field: 'title', lang: 'zh-Hans', text: 'Haneulbit 电子屏', source: 'llm', status: 'ok', failCodes: [], withPlaceholders: 'Haneulbit 电子屏' },
      {
        field: 'summary', lang: 'zh-Hans', source: 'llm', status: 'ok', failCodes: [],
        text: '江南站11号出口的电子屏广告位，7天1,500,000韩元起。',
        withPlaceholders: '江南站11号出口的电子屏广告位，{days}天{price}起。',
      },
    ]);
  });

  it('모델에게 가는 입력에는 글자 정보만 있고 숫자 값은 없다', async () => {
    const { provider, requests } = scripted([GOOD_AD]);
    const input = inputOf(AD, AD_VALUES);
    await generateContent(input, provider);
    expect(requests[0]!.input).toEqual(input.content);
    expect(JSON.stringify(requests[0]!.input)).not.toMatch(/1500000|1,500,000/);
    expect(requests[0]!).toMatchObject({ task: 'content', promptVersion: 'content-v1' });
  });

  it('케이터링은 수량, 굿즈는 값만 들어간다', async () => {
    const catering = await generateContent(inputOf(CATERING, CATERING_VALUES), scripted([GOOD_CATERING]).provider);
    expect(catering.texts[1]!.text).toBe('A coffee truck serving the Hapjeong Station area, from KRW 800,000 for 100 cups.');
    expect(catering.texts[3]!.text).toBe('可前往合井站一带的咖啡车，100杯800,000韩元起。');

    const goods = await generateContent(inputOf(GOODS, GOODS_VALUES), scripted([GOOD_GOODS]).provider);
    expect(goods.texts.map((t) => t.source)).toEqual(['llm', 'llm', 'llm', 'llm']);
    expect(goods.texts[1]!.text).toBe('A set of printed photocards, from KRW 12,000.');
    expect(goods.texts[3]!.text).toBe('印刷小卡套装，12,000韩元起。');
  });

  it('앞뒤 공백은 떼고 쓴다', async () => {
    const out = await generateContent(inputOf(AD, AD_VALUES), scripted([withLine(GOOD_AD, 'en', 'title', '  Haneulbit Digital Billboard\n')]).provider);
    expect(out.texts[0]).toMatchObject({ text: 'Haneulbit Digital Billboard', source: 'llm' });
  });

  it('문(기본 내보내기)으로 불러도 같다', async () => {
    const out = await api.generateContent(inputOf(AD, AD_VALUES), scripted([GOOD_AD]).provider);
    expect(out.texts.every((t) => t.source === 'llm')).toBe(true);
  });
});

/** 망가뜨린 글 6종. 영어 요약 한 줄만 망가뜨린다. */
const BROKEN_EN: [label: string, text: string, code: ContentFailCode][] = [
  ['자리표시 지움', 'A digital billboard at Gangnam Station Exit 11, from {price}.', 'PLACEHOLDER_LOST'],
  ['자리표시 밖 숫자', `${GOOD_AD.en.summary} Seen by 300,000 people a day.`, 'STRAY_NUMBER'],
  ['한글 섞임', 'A digital billboard 전광판 at Gangnam Station Exit 11, from {price} for {days} days.', 'HANGUL_IN_TEXT'],
  ['빈 글', ' ... ', 'EMPTY_TEXT'],
  ['혼잣말·머리말 흔적', `Here is the summary: ${GOOD_AD.en.summary}`, 'MONOLOGUE'],
  ['용어집 표기 어긋남', GOOD_AD.en.summary.replace('digital billboard', 'LED screen'), 'GLOSSARY_MISS'],
];

/** 같은 6종을 중국어 요약에. */
const BROKEN_ZH: [label: string, text: string, code: ContentFailCode][] = [
  ['자리표시 지움', '江南站11号出口的电子屏广告位，{price}起。', 'PLACEHOLDER_LOST'],
  ['자리표시 밖 숫자', '江南站11号出口的电子屏广告位，每天播放100次，{days}天{price}起。', 'STRAY_NUMBER'],
  ['한글 섞임', '江南站11号出口的电子屏(전광판)广告位，{days}天{price}起。', 'HANGUL_IN_TEXT'],
  ['빈 글', '。', 'EMPTY_TEXT'],
  ['혼잣말·머리말 흔적', `好的，以下是摘要：${GOOD_AD['zh-Hans'].summary}`, 'MONOLOGUE'],
  ['용어집 표기 어긋남', GOOD_AD['zh-Hans'].summary.replace('电子屏', '大屏幕'), 'GLOSSARY_MISS'],
];

describe.each([
  ['en', BROKEN_EN],
  ['zh-Hans', BROKEN_ZH],
] as const)('글 만들기: 망가진 글 6종 (%s 요약)', (lang, cases) => {
  const lineIndex = lang === 'en' ? 1 : 3;

  it.each(cases)('%s → 다시 불러 고친 글을 받는다', async (_label, text) => {
    const { provider, requests } = scripted([withLine(GOOD_AD, lang, 'summary', text), GOOD_AD]);
    const out = await generateContent(inputOf(AD, AD_VALUES), provider);

    // 두 번 불렀고, 두 번째 요청에는 걸린 줄을 알리는 말이 붙었다.
    expect(requests).toHaveLength(2);
    expect(retryHintIn(requests[0])).toBeUndefined();
    const hint = retryHintIn(requests[1])!;
    expect(hint).toContain(`- ${lang}.summary:`);
    expect(hint.split('\n')).toHaveLength(2);
    expect(out.calls.map((c) => c.attempt)).toEqual([1, 2]);

    expect(out.texts.map((t) => t.source)).toEqual(['llm', 'llm', 'llm', 'llm']);
    expect(out.texts.every((t) => t.status === 'ok' && t.failCodes.length === 0)).toBe(true);
    expect(out.skipCause).toBeNull();
  });

  it.each(cases)('%s → 다시 받은 글도 같으면 그 줄만 틀 문장이 되고 %s 가 남는다', async (_label, text, code) => {
    const broken = withLine(GOOD_AD, lang, 'summary', text);
    const { provider, requests } = scripted([broken, broken]);
    const input = inputOf(AD, AD_VALUES);
    const out = await generateContent(input, provider);

    // 딱 한 번만 다시 한다.
    expect(requests).toHaveLength(2);
    const template = templateTexts(input)[lineIndex]!;
    expect(out.texts[lineIndex]).toEqual({ ...template, failCodes: [code] });
    expect(out.texts[lineIndex]).toMatchObject({ source: 'template', status: 'needs_review' });
    // 통과한 나머지 세 줄은 모델 글 그대로다.
    const others = out.texts.filter((_, i) => i !== lineIndex);
    expect(others.map((t) => t.source)).toEqual(['llm', 'llm', 'llm']);
    expect(out.skipCause).toBeNull();
  });
});

describe('글 만들기: 다시 하기의 규칙', () => {
  const input = inputOf(AD, AD_VALUES);
  const brokenEn = withLine(GOOD_AD, 'en', 'summary', BROKEN_EN[0]![1]);

  it('걸린 코드가 여럿이면 모두 남긴다(약속한 순서)', async () => {
    const worst = withLine(GOOD_AD, 'en', 'summary', 'Sure! LED screen 전광판 for 7 days.');
    const out = await generateContent(input, scripted([worst, worst]).provider);
    expect(out.texts[1]!.failCodes).toEqual(['PLACEHOLDER_LOST', 'STRAY_NUMBER', 'HANGUL_IN_TEXT', 'MONOLOGUE', 'GLOSSARY_MISS']);
  });

  it('틀 문장의 failCodes 는 모델의 마지막 글이 걸린 코드다', async () => {
    const second = withLine(GOOD_AD, 'en', 'summary', BROKEN_EN[4]![1]);
    const out = await generateContent(input, scripted([brokenEn, second]).provider);
    expect(out.texts[1]).toMatchObject({ source: 'template', failCodes: ['MONOLOGUE'] });
  });

  it('다시 받은 답에서 걸렸어도 첫 답에서 통과했던 줄은 첫 답의 글을 쓴다', async () => {
    // 첫 답: 영어 요약만 걸림. 다시 받은 답: 영어 요약은 고쳤는데 중국어 제목이 새로 걸림.
    const second = withLine(GOOD_AD, 'zh-Hans', 'title', '하늘빛 电子屏');
    const out = await generateContent(input, scripted([brokenEn, second]).provider);
    expect(out.texts.map((t) => t.source)).toEqual(['llm', 'llm', 'llm', 'llm']);
    expect(out.texts[2]!.text).toBe('Haneulbit 电子屏');
    expect(out.texts[1]!.text).toBe('A digital billboard at Gangnam Station Exit 11, from KRW 1,500,000 for 7 days.');
  });

  it('두 답에서 모두 통과한 줄은 다시 받은(가장 최근) 글을 쓴다', async () => {
    const second = withLine(GOOD_AD, 'en', 'title', 'Haneulbit Digital Billboard at Gangnam Station');
    const out = await generateContent(input, scripted([brokenEn, second]).provider);
    expect(out.texts[0]).toMatchObject({ source: 'llm', text: 'Haneulbit Digital Billboard at Gangnam Station' });
  });

  it('다시 한 요청은 첫 요청과 같은 글자 정보에 걸린 까닭만 더한 것이다', async () => {
    const { provider, requests } = scripted([brokenEn, GOOD_AD]);
    await generateContent(input, provider);
    const { retryHint, ...rest } = requests[1]!.input as Record<string, unknown>;
    expect(rest).toEqual(requests[0]!.input);
    expect(retryHint).toBe(
      [
        '지난번 글이 검사에 걸렸다. 아래를 고쳐 네 글을 모두 다시 쓴다.',
        '- en.summary: 자리표시 {price}, {days} 를 중괄호째 그대로 모두 넣는다. 그 밖의 자리표시나 중괄호는 쓰지 않는다.',
      ].join('\n'),
    );
    expect(requests[1]!.system).toBe(requests[0]!.system);
  });

  it('네 줄이 모두 두 번 걸리면 네 줄 모두 틀 문장이다. 모델을 부르긴 했으므로 skipCause 는 null', async () => {
    const hangul: ContentDraft = {
      en: { title: '하늘빛 전광판', summary: '하늘빛 전광판, from {price}.' },
      'zh-Hans': { title: '하늘빛 전광판', summary: '하늘빛 전광판，{price}起。' },
    };
    const out = await generateContent(input, scripted([hangul, hangul]).provider);
    expect(out.texts.map((t) => t.source)).toEqual(['template', 'template', 'template', 'template']);
    expect(out.texts.map((t) => t.text)).toEqual(templateTexts(input).map((t) => t.text));
    expect(out.texts[0]!.failCodes).toEqual(['HANGUL_IN_TEXT', 'GLOSSARY_MISS']);
    expect(out.skipCause).toBeNull();
    expect(out.calls).toHaveLength(2);
  });

  it('시험용 구현의 기본 답은 이름을 한글 그대로 쓰므로 검사에 걸려 틀 문장이 된다', async () => {
    const out = await generateContent(input, createProvider({ kind: 'fake' }));
    expect(out.texts.map((t) => t.source)).toEqual(['template', 'template', 'template', 'template']);
    expect(out.texts.every((t) => t.failCodes.includes('HANGUL_IN_TEXT'))).toBe(true);
  });
});

describe('글 만들기: 자리표시가 없는 칸', () => {
  it('기간 옵션이 없는 상품은 {days} 없이 통과한다', async () => {
    const out = await generateContent(inputOf(GOODS, GOODS_VALUES), scripted([GOOD_GOODS]).provider);
    expect(out.calls).toHaveLength(1);
    expect(out.texts[1]).toMatchObject({ source: 'llm', text: 'A set of printed photocards, from KRW 12,000.' });
  });

  it('넣을 값이 없는 {days} 를 쓰면 걸리고, 다시 해도 같으면 틀 문장이 된다. 중괄호가 남은 글은 나가지 않는다', async () => {
    const withDays = withLine(GOOD_GOODS, 'en', 'summary', 'A set of printed photocards, from {price}, ready in {days} days.');
    const { provider, requests } = scripted([withDays, withDays]);
    const out = await generateContent(inputOf(GOODS, GOODS_VALUES), provider);

    expect(retryHintIn(requests[1])).toContain('- en.summary: 자리표시 {price} 를 중괄호째 그대로 모두 넣는다. 그 밖의 자리표시나 중괄호는 쓰지 않는다.');
    expect(out.texts[1]).toMatchObject({ source: 'template', failCodes: ['PLACEHOLDER_LOST'], text: 'Printed goods · photocard. Price from KRW 12,000.' });
    for (const t of out.texts) expect(hasBraces(t.text)).toBe(false);
  });

  it('이름은 알려 줬는데 값이 없는 자리표시도 같다(요구하지 않고, 쓰면 걸린다)', async () => {
    const full = inputOf(AD, AD_VALUES);
    const noDays = { ...full, values: { price: 1_500_000 } };
    const priceOnly = withLine(withLine(GOOD_AD, 'en', 'summary', 'A digital billboard at Gangnam Station Exit 11, from {price}.'), 'zh-Hans', 'summary', '江南站11号出口的电子屏广告位，{price}起。');

    const ok = await generateContent(noDays, scripted([priceOnly]).provider);
    expect(ok.texts.map((t) => t.source)).toEqual(['llm', 'llm', 'llm', 'llm']);

    const bad = await generateContent(noDays, scripted([GOOD_AD, GOOD_AD]).provider);
    expect(bad.texts.map((t) => t.source)).toEqual(['llm', 'template', 'llm', 'template']);
    for (const t of bad.texts) expect(hasBraces(t.text)).toBe(false);
  });

  it('값이 하나도 없어도 글은 나온다', async () => {
    const plain: ContentDraft = {
      en: { title: 'Byeolmuri Photocard Set', summary: 'A set of printed photocards.' },
      'zh-Hans': { title: 'Byeolmuri 小卡套装', summary: '印刷小卡套装。' },
    };
    const out = await generateContent(inputOf(GOODS, {}), scripted([plain]).provider);
    expect(out.texts.map((t) => t.text)).toEqual(['Byeolmuri Photocard Set', 'A set of printed photocards.', 'Byeolmuri 小卡套装', '印刷小卡套装。']);
  });

  it('전각 중괄호로 쓴 자리표시는 채울 수 없으므로 걸린다', async () => {
    const wide = withLine(GOOD_AD, 'zh-Hans', 'summary', '江南站11号出口的电子屏广告位，{days}天｛price｝起。');
    const out = await generateContent(inputOf(AD, AD_VALUES), scripted([wide, wide]).provider);
    expect(out.texts[3]).toMatchObject({ source: 'template', failCodes: ['PLACEHOLDER_LOST'] });
  });
});

describe('글 만들기: 모델을 못 불렀을 때', () => {
  const input = inputOf(AD, AD_VALUES);

  it.each<[LlmUnavailableCode, LlmSkipCause]>([
    ['CACHE_MISS', 'cache_miss'],
    ['NO_KEY', 'no_key'],
    ['REFUSAL', 'refusal'],
    ['MAX_TOKENS', 'error'],
    ['BAD_OUTPUT', 'error'],
    ['BAD_REQUEST', 'error'],
  ])('%s → 던지지 않고 네 줄 모두 틀 문장, 까닭은 %s', async (code, cause) => {
    const { provider, requests } = scripted([new LlmUnavailable(code)]);
    const out = await generateContent(input, provider);
    expect(requests).toHaveLength(1);
    expect(out.skipCause).toBe(cause);
    expect(out.calls).toEqual([]);
    expect(out.texts).toEqual(templateTexts(input));
    expect(out.texts.every((t) => t.source === 'template' && t.status === 'needs_review' && t.failCodes.length === 0)).toBe(true);
  });

  it('답은 못 썼어도 토큰이 나간 호출은 기록에 남는다', async () => {
    const usage = { inputTokens: 900, outputTokens: 40 };
    const out = await generateContent(input, scripted([new LlmUnavailable('REFUSAL', '거절', usage)]).provider);
    expect(out.calls).toEqual([{ attempt: 1, recorded: false, latencyMs: 0, usage }]);
    expect(out.skipCause).toBe('refusal');
  });

  it('잠깐의 오류는 그대로 던진다(작업 줄이 다시 한다)', async () => {
    const transient = new LlmUnavailable('TRANSIENT', 'HTTP 529');
    await expect(generateContent(input, scripted([transient]).provider)).rejects.toBe(transient);
  });

  it('다시 부르다 난 잠깐의 오류도 그대로 던진다', async () => {
    const transient = new LlmUnavailable('TRANSIENT');
    const brokenEn = withLine(GOOD_AD, 'en', 'summary', BROKEN_EN[0]![1]);
    await expect(generateContent(input, scripted([brokenEn, transient]).provider)).rejects.toBe(transient);
  });

  it('다시 부르다 실패하면(녹화 없음 등) 첫 답에서 통과한 줄은 살리고 걸린 줄만 틀 문장으로 바꾼다', async () => {
    const brokenEn = withLine(GOOD_AD, 'en', 'summary', BROKEN_EN[1]![1]);
    const out = await generateContent(input, scripted([brokenEn, new LlmUnavailable('CACHE_MISS')]).provider);
    expect(out.texts.map((t) => t.source)).toEqual(['llm', 'template', 'llm', 'llm']);
    expect(out.texts[1]!.failCodes).toEqual(['STRAY_NUMBER']);
    // 모델을 한 번은 불렀다.
    expect(out.skipCause).toBeNull();
    expect(out.calls.map((c) => c.attempt)).toEqual([1]);
  });

  it('모델과 상관없는 오류는 삼키지 않는다', async () => {
    const boom = new Error('연결이 끊겼다');
    await expect(generateContent(input, scripted([boom]).provider)).rejects.toBe(boom);
  });

  it('공급자가 없으면 부르지 않고 바로 틀 문장이다. 까닭은 부르는 쪽이 준 값', async () => {
    const out = await generateContent(input, null, 'daily_cap');
    expect(out).toEqual({ texts: templateTexts(input), calls: [], skipCause: 'daily_cap' });
  });

  it('공급자도 까닭도 없으면 "꺼져 있음"으로 적는다', async () => {
    expect((await generateContent(input, null)).skipCause).toBe('off');
  });

  it('공급자가 있으면 부르는 쪽이 준 까닭은 쓰지 않는다', async () => {
    const out = await generateContent(input, scripted([GOOD_AD]).provider, 'daily_cap');
    expect(out.skipCause).toBeNull();
  });
});
