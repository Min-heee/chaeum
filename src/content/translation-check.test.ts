// 번역 검사 시험. 이미 번역된 끝 글(숫자가 들어간 글)을 본다.
import { describe, expect, it } from 'vitest';
import { ContentCheckRequestSchema, ContentCheckResponseSchema, type ContentCheckItem } from '@/contract/content';
import { GLOSSARY } from './fixtures';
import { checkTranslations } from './translation-check';

const GOOD_EN = 'A digital billboard at Gangnam Station Exit 11, from KRW 1,500,000 for 7 days.';
const GOOD_ZH = '江南站11号出口的电子屏广告位，7天1,500,000韩元起。';

const one = (item: ContentCheckItem) => checkTranslations({ items: [item] }, GLOSSARY).results[0]!;
const en = (text: string, over: Partial<ContentCheckItem> = {}) =>
  one({ lang: 'en', field: 'summary', text, sourceKo: '강남역 11번 출구 전광판', allowedNumbers: ['11', '1500000', '7'], ...over });
const zh = (text: string, over: Partial<ContentCheckItem> = {}) =>
  one({ lang: 'zh-Hans', field: 'summary', text, sourceKo: '강남역 11번 출구 전광판', allowedNumbers: ['11', '1500000', '7'], ...over });

describe('번역 검사', () => {
  it('맞는 글은 다섯 검사를 모두 통과한다', () => {
    const pass = { placeholder: 'pass', number: 'pass', language: 'pass', monologue: 'pass', glossary: 'pass' };
    expect(en(GOOD_EN)).toEqual({ id: null, index: 0, lang: 'en', field: 'summary', status: 'ok', failCodes: [], checks: pass });
    expect(zh(GOOD_ZH)).toMatchObject({ status: 'ok', failCodes: [], checks: pass });
  });

  it('맞는 숫자를 안 주면 숫자 검사는 통과가 아니라 건너뜀이다', () => {
    const result = en(GOOD_EN, { allowedNumbers: undefined });
    expect(result.checks.number).toBe('skipped');
    expect(result).toMatchObject({ status: 'ok', failCodes: [] });
  });

  it('허락한 숫자 밖의 숫자가 있으면 STRAY_NUMBER', () => {
    expect(en(GOOD_EN.replace('1,500,000', '15,000,000'))).toMatchObject({ status: 'needs_review', failCodes: ['STRAY_NUMBER'], checks: { number: 'fail' } });
    expect(en(GOOD_EN, { allowedNumbers: [] })).toMatchObject({ failCodes: ['STRAY_NUMBER'] });
  });

  it('쉼표가 있는 꼴과 없는 꼴은 같은 수로 본다', () => {
    expect(en(GOOD_EN.replace('1,500,000', '1500000')).failCodes).toEqual([]);
    expect(en(GOOD_EN, { allowedNumbers: ['11', '1,500,000', '7'] }).failCodes).toEqual([]);
  });

  it('덩어리째 견준다. "7"을 허락했다고 "17"이 통과하지 않는다', () => {
    expect(en(GOOD_EN.replace('for 7 days', 'for 17 days')).failCodes).toEqual(['STRAY_NUMBER']);
  });

  it('끝 글에 자리표시가 남아 있으면 PLACEHOLDER_LOST', () => {
    const result = en('A digital billboard at Gangnam Station Exit 11, from {price} for 7 days.');
    expect(result).toMatchObject({ failCodes: ['PLACEHOLDER_LOST'], checks: { placeholder: 'fail' } });
    expect(zh('江南站11号出口的电子屏广告位，7天｛price｝起。').failCodes).toEqual(['PLACEHOLDER_LOST']);
  });

  it('한글이 섞이면 HANGUL_IN_TEXT', () => {
    expect(zh(GOOD_ZH.replace('电子屏', '电子屏(전광판)'))).toMatchObject({ failCodes: ['HANGUL_IN_TEXT'], checks: { language: 'fail' } });
  });

  it('혼잣말·머리말이 남으면 MONOLOGUE', () => {
    expect(en(`Here is the translation: ${GOOD_EN}`)).toMatchObject({ failCodes: ['MONOLOGUE'], checks: { monologue: 'fail' } });
    expect(zh(`好的，以下是翻译：${GOOD_ZH}`).failCodes).toEqual(['MONOLOGUE']);
  });

  it('한국어 원문의 낱말에 해당하는 용어집 표기가 글에 없으면 GLOSSARY_MISS', () => {
    expect(en(GOOD_EN.replace('digital billboard', 'LED screen'))).toMatchObject({ failCodes: ['GLOSSARY_MISS'], checks: { glossary: 'fail' } });
    expect(zh(GOOD_ZH.replace('江南站', '江南车站')).failCodes).toEqual(['GLOSSARY_MISS']);
  });

  it('꼭 있어야 하는 표기를 직접 줄 수도 있다. 원문에서 찾은 것에 더해진다', () => {
    expect(en(GOOD_EN, { requiredTerms: ['Exit 11'] }).failCodes).toEqual([]);
    expect(en(GOOD_EN, { requiredTerms: ['Exit 12'] }).failCodes).toEqual(['GLOSSARY_MISS']);
    expect(en(GOOD_EN.replace('digital billboard', 'LED screen'), { sourceKo: undefined, requiredTerms: ['LED screen'] }).failCodes).toEqual([]);
  });

  it('찾아볼 표기가 하나도 없으면 용어 검사는 건너뜀이다', () => {
    expect(en(GOOD_EN, { sourceKo: undefined }).checks.glossary).toBe('skipped');
    expect(en(GOOD_EN, { sourceKo: '별무리 엽서' }).checks.glossary).toBe('skipped');
  });

  it.each(['', '   ', '...', '-'])('빈 글 %j: EMPTY_TEXT 하나만 내고 나머지 검사는 건너뜀이다', (text) => {
    expect(en(text)).toMatchObject({
      status: 'needs_review',
      failCodes: ['EMPTY_TEXT'],
      checks: { placeholder: 'skipped', number: 'skipped', language: 'fail', monologue: 'skipped', glossary: 'skipped' },
    });
  });

  it('제목도 본다', () => {
    const title = one({ lang: 'en', field: 'title', text: 'Title: Gangnam Station Digital Billboard', sourceKo: '강남역 전광판' });
    expect(title).toMatchObject({ field: 'title', failCodes: ['MONOLOGUE'], checks: { number: 'skipped', glossary: 'pass' } });
  });

  it('여러 건: 순서와 번호를 그대로 돌려주고 합계를 낸다', () => {
    const request = ContentCheckRequestSchema.parse({
      items: [
        { id: 'a-1', lang: 'en', field: 'title', text: 'Gangnam Station Digital Billboard', sourceKo: '강남역 전광판' },
        { lang: 'zh-Hans', field: 'title', text: '江南站 전광판', sourceKo: '강남역 전광판' },
        { id: 'a-3', lang: 'en', field: 'summary', text: 'From KRW 1,500,000.', allowedNumbers: ['1500000'] },
      ],
    });
    const response = checkTranslations(request, GLOSSARY);
    expect(response.results.map((r) => [r.id, r.index, r.status])).toEqual([
      ['a-1', 0, 'ok'],
      [null, 1, 'needs_review'],
      ['a-3', 2, 'ok'],
    ]);
    expect(response.results[1]!.failCodes).toEqual(['HANGUL_IN_TEXT', 'GLOSSARY_MISS']);
    // 첫 글은 숫자 검사를, 둘째 글도 숫자 검사를, 셋째 글은 용어 검사를 건너뛰었다. ok 라도 다 본 것은 아니다.
    expect(response.summary).toEqual({ total: 3, ok: 2, needsReview: 1, withSkipped: 3 });
    // 응답이 약속의 꼴이다.
    expect(ContentCheckResponseSchema.safeParse(response).success).toBe(true);
  });

  it('용어집이 비어도 돈다', () => {
    const response = checkTranslations({ items: [{ lang: 'en', field: 'title', text: 'Gangnam Station Digital Billboard', sourceKo: '강남역 전광판' }] }, []);
    expect(response.results[0]).toMatchObject({ status: 'ok', checks: { glossary: 'skipped' } });
  });
});
