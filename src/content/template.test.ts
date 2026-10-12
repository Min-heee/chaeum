// 틀 문장 시험. 모델 없이 코드가 만드는 기본 글이다.
import { describe, expect, it } from 'vitest';
import { AD, AD_VALUES, CATERING, CATERING_VALUES, GOODS, GOODS_VALUES, inputOf } from './fixtures';
import { hasBraces } from './format';
import { checkLine, lineRules } from './line-check';
import { templateTexts } from './template';

const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;

describe('틀 문장', () => {
  it('네 줄이고 모두 "확인 필요"다', () => {
    const texts = templateTexts(inputOf(AD, AD_VALUES));
    expect(texts.map((t) => `${t.lang}.${t.field}`)).toEqual(['en.title', 'en.summary', 'zh-Hans.title', 'zh-Hans.summary']);
    for (const t of texts) expect(t).toMatchObject({ source: 'template', status: 'needs_review', failCodes: [] });
  });

  it('광고 지면: 값과 가장 짧은 기간이 언어별 서식으로 들어간다', () => {
    const texts = templateTexts(inputOf(AD, AD_VALUES));
    expect(texts.map((t) => t.text)).toEqual([
      'Digital billboard · Gangnam Station',
      'Digital billboard · Gangnam Station. Price from KRW 1,500,000. Minimum period: 7 day(s).',
      '电子屏广告 · 江南站',
      '电子屏广告 · 江南站。价格1,500,000韩元起。最短7天。',
    ]);
    expect(texts[1]!.withPlaceholders).toBe('Digital billboard · Gangnam Station. Price from {price}. Minimum period: {days} day(s).');
    expect(texts[3]!.withPlaceholders).toBe('电子屏广告 · 江南站。价格{price}起。最短{days}天。');
  });

  it('케이터링: 값과 가장 적은 수량', () => {
    const texts = templateTexts(inputOf(CATERING, CATERING_VALUES));
    expect(texts.map((t) => t.text)).toEqual([
      'Coffee truck · Hapjeong Station',
      'Coffee truck · Hapjeong Station. Price from KRW 800,000. Minimum quantity: 100.',
      '咖啡车 · 合井站',
      '咖啡车 · 合井站。价格800,000韩元起。最少数量100。',
    ]);
  });

  it('기간도 수량도 없는 상품: 그 문장을 넣지 않는다. 채우지 못한 자리표시가 남지 않는다', () => {
    const texts = templateTexts(inputOf(GOODS, GOODS_VALUES));
    expect(texts.map((t) => t.text)).toEqual([
      'Printed goods · photocard',
      'Printed goods · photocard. Price from KRW 12,000.',
      '印刷品 · 小卡',
      '印刷品 · 小卡。价格12,000韩元起。',
    ]);
  });

  it('값이 하나도 없으면 설명 한 줄만 낸다', () => {
    const texts = templateTexts(inputOf(GOODS, {}));
    expect(texts[1]!.text).toBe('Printed goods · photocard.');
    expect(texts[3]!.text).toBe('印刷品 · 小卡。');
  });

  it('이름은 알려 줬는데 값이 없는 자리표시의 문장도 넣지 않는다', () => {
    const input = inputOf(AD, AD_VALUES);
    const texts = templateTexts({ ...input, values: { price: 1_500_000 } });
    expect(texts[1]!.text).toBe('Digital billboard · Gangnam Station. Price from KRW 1,500,000.');
  });

  it('갈래가 목록에 없으면 종류의 표기를 쓴다', () => {
    const texts = templateTexts(inputOf({ type: 'catering', subtype: '분식차', name: '달보드레 분식차', region: null }, { price: 500_000 }));
    expect(texts[0]!.text).toBe('Catering');
    expect(texts[2]!.text).toBe('餐饮服务');
  });

  it('용어집 표기가 갈래의 기본 표기와 다르면 뒤에 덧붙인다(용어집 표기가 꼭 들어간다)', () => {
    const glossary = [{ ko: '전광판', en: 'LED screen', 'zh-Hans': '大屏幕' }];
    const texts = templateTexts(inputOf(AD, AD_VALUES, glossary));
    expect(texts[0]!.text).toBe('Digital billboard · LED screen');
    expect(texts[2]!.text).toBe('电子屏广告 · 大屏幕');
  });

  it('표기가 마침표로 끝나도 마침표를 두 번 찍지 않는다', () => {
    const glossary = [{ ko: '합정역', en: 'Hapjeong Stn.', 'zh-Hans': '合井站' }];
    const texts = templateTexts(inputOf(CATERING, { price: 800_000 }, glossary));
    expect(texts[1]!.text).toBe('Coffee truck · Hapjeong Stn. Price from KRW 800,000.');
  });

  it.each([
    ['광고 지면', inputOf(AD, AD_VALUES)],
    ['케이터링', inputOf(CATERING, CATERING_VALUES)],
    ['굿즈', inputOf(GOODS, GOODS_VALUES)],
    ['숫자가 든 이름', inputOf({ type: 'ad', subtype: '지하철', name: '2호선 스크린도어 1000면', region: '합정역 3번 출구' }, AD_VALUES)],
  ])('%s: 틀 문장은 글 검사를 통과하는 꼴이고 한글과 중괄호가 없다', (_label, input) => {
    const rules = lineRules(input);
    templateTexts(input).forEach((t, i) => {
      expect(checkLine(rules[i]!, t.withPlaceholders)).toEqual([]);
      expect(t.text).not.toMatch(HANGUL);
      expect(hasBraces(t.text)).toBe(false);
    });
  });

  it('같은 입력이면 늘 같은 글이다', () => {
    expect(templateTexts(inputOf(AD, AD_VALUES))).toEqual(templateTexts(inputOf(AD, AD_VALUES)));
  });
});
