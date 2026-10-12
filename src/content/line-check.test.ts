// 줄마다의 규칙과 검사 시험.
import { describe, expect, it } from 'vitest';
import { AD, AD_VALUES, CATERING, CATERING_VALUES, GLOSSARY, GOOD_AD, GOODS, GOODS_VALUES, inputOf } from './fixtures';
import { checkLine, lineRules, retryHintOf, usablePlaceholders } from './line-check';

describe('줄마다의 규칙', () => {
  const rules = lineRules(inputOf(AD, AD_VALUES));
  const [enTitle, enSummary, zhTitle, zhSummary] = rules;

  it('네 줄이고 순서는 영어 제목, 영어 요약, 중국어 제목, 중국어 요약', () => {
    expect(rules.map((r) => `${r.lang}.${r.field}`)).toEqual(['en.title', 'en.summary', 'zh-Hans.title', 'zh-Hans.summary']);
  });

  it('요약에는 쓸 수 있는 자리표시가 모두 있어야 하고, 제목에는 없어도 된다', () => {
    expect(enSummary!.requiredPlaceholders).toEqual(['price', 'days']);
    expect(zhSummary!.requiredPlaceholders).toEqual(['price', 'days']);
    expect(enTitle!.requiredPlaceholders).toEqual([]);
    expect(zhTitle!.requiredPlaceholders).toEqual([]);
  });

  it('제목에는 이름 속 낱말의 표기가, 요약에는 이름과 지역 속 낱말의 표기가 있어야 한다', () => {
    expect(enTitle!.requiredTerms).toEqual(['digital billboard']);
    expect(enSummary!.requiredTerms).toEqual(['digital billboard', 'Gangnam Station']);
    expect(zhTitle!.requiredTerms).toEqual(['电子屏']);
    expect(zhSummary!.requiredTerms).toEqual(['电子屏', '江南站']);
  });

  it('종류 이름의 표기("ad space")는 모델에게 알려 주기만 하고 요구하지 않는다', () => {
    expect(inputOf(AD, AD_VALUES).content.glossary.map((e) => e.en)).toContain('ad space');
    expect(enSummary!.requiredTerms).not.toContain('ad space');
  });

  it('이름·지역에 원래 있는 숫자는 글에 나와도 된다', () => {
    expect(enSummary!.allowedNumbers).toEqual(['11']);
    expect(enTitle!.allowedNumbers).toEqual(['11']);
  });

  it('용어집 표기에 든 숫자도 나와도 된다. 같은 수의 쉼표 있는 꼴과 없는 꼴을 함께 허락한다', () => {
    const line2 = lineRules(inputOf({ type: 'ad', subtype: '지하철', name: '2호선 스크린도어 1000면', region: '합정역' }, AD_VALUES));
    expect(line2[1]!.allowedNumbers).toEqual(['2', '1000', '1,000']);
  });

  it('종류마다 쓸 수 있는 자리표시가 다르다', () => {
    expect(lineRules(inputOf(CATERING, CATERING_VALUES))[1]!.requiredPlaceholders).toEqual(['price', 'qty']);
    expect(lineRules(inputOf(GOODS, GOODS_VALUES))[1]!.requiredPlaceholders).toEqual(['price']);
  });

  it('쓸 수 있는 자리표시: 모델에게 알려 준 이름이면서 넣을 값이 있는 것만', () => {
    const input = inputOf(AD, AD_VALUES);
    expect(usablePlaceholders(input)).toEqual(['price', 'days']);
    // 이름은 알려 줬는데 값이 없다(또는 0 이다).
    expect(usablePlaceholders({ ...input, values: { price: 1_500_000 } })).toEqual(['price']);
    expect(usablePlaceholders({ ...input, values: { price: 1_500_000, days: 0 } })).toEqual(['price']);
    // 값은 있는데 모델에게 알려 주지 않았다.
    expect(usablePlaceholders({ content: { ...input.content, placeholders: ['price'] }, values: { ...AD_VALUES, qty: 3 } })).toEqual(['price']);
  });

  it('규칙이 들고 있는 값에는 쓸 수 있는 자리표시의 값만 있다', () => {
    const input = inputOf(AD, AD_VALUES);
    const narrowed = lineRules({ content: { ...input.content, placeholders: ['price'] }, values: { ...AD_VALUES, qty: 3 } });
    expect(narrowed[1]!.values).toEqual({ price: 1_500_000 });
  });
});

describe('줄 검사', () => {
  const [enTitle, enSummary, zhTitle, zhSummary] = lineRules(inputOf(AD, AD_VALUES));

  it('통과하는 답은 네 줄 모두 걸리는 것이 없다', () => {
    expect(checkLine(enTitle!, GOOD_AD.en.title)).toEqual([]);
    expect(checkLine(enSummary!, GOOD_AD.en.summary)).toEqual([]);
    expect(checkLine(zhTitle!, GOOD_AD['zh-Hans'].title)).toEqual([]);
    expect(checkLine(zhSummary!, GOOD_AD['zh-Hans'].summary)).toEqual([]);
  });

  it('제목에 쓴 자리표시도 값이 있으면 받아 준다', () => {
    expect(checkLine(enTitle!, 'Haneulbit Digital Billboard from {price}')).toEqual([]);
  });

  it('전각 중괄호로 쓴 자리표시는 코드가 채우지 못하므로 PLACEHOLDER_LOST', () => {
    expect(checkLine(enSummary!, 'A digital billboard at Gangnam Station, from ｛price｝ for {days} days.')).toEqual(['PLACEHOLDER_LOST']);
  });

  it('넣을 값이 없는 자리표시를 쓰면 PLACEHOLDER_LOST', () => {
    const goods = lineRules(inputOf(GOODS, GOODS_VALUES));
    expect(checkLine(goods[1]!, 'A set of printed photocards, from {price}.')).toEqual([]);
    expect(checkLine(goods[1]!, 'A set of printed photocards, from {price}, ready in {days} days.')).toEqual(['PLACEHOLDER_LOST']);
    expect(checkLine(goods[0]!, 'Byeolmuri Photocard Set of {qty}')).toEqual(['PLACEHOLDER_LOST']);
  });

  it('여러 가지가 걸리면 약속한 순서로 낸다', () => {
    expect(checkLine(enSummary!, 'Sure! LED screen 전광판 for 7 days.')).toEqual(['PLACEHOLDER_LOST', 'STRAY_NUMBER', 'HANGUL_IN_TEXT', 'MONOLOGUE', 'GLOSSARY_MISS']);
  });

  it('빈 글은 EMPTY_TEXT 하나만 낸다', () => {
    expect(checkLine(enSummary!, '')).toEqual(['EMPTY_TEXT']);
    expect(checkLine(enSummary!, '{price}')).toEqual(['EMPTY_TEXT']);
  });
});

describe('다시 쓰라고 할 때 붙이는 말', () => {
  const rules = lineRules(inputOf(AD, AD_VALUES));

  it('걸린 줄만, 지켜야 할 것을 적는다. 이 글이 바뀌면 다시 한 요청의 장부 키도 바뀐다', () => {
    const hint = retryHintOf(rules, [[], ['PLACEHOLDER_LOST', 'STRAY_NUMBER'], ['HANGUL_IN_TEXT'], ['GLOSSARY_MISS']]);
    expect(hint).toBe(
      [
        '지난번 글이 검사에 걸렸다. 아래를 고쳐 네 글을 모두 다시 쓴다.',
        '- en.summary: 자리표시 {price}, {days} 를 중괄호째 그대로 모두 넣는다. 그 밖의 자리표시나 중괄호는 쓰지 않는다. 숫자를 직접 쓰지 않는다. 값·일수·수량은 자리표시로만 적는다.',
        '- zh-Hans.title: 한글을 쓰지 않는다. 용어집에 없는 고유한 이름은 로마자로 적는다.',
        '- zh-Hans.summary: 용어집 표기 "电子屏", "江南站" 를 글자 그대로 넣는다.',
      ].join('\n'),
    );
  });

  it('자리표시가 필요 없는 줄(제목)에는 쓰지 말라고 적는다', () => {
    expect(retryHintOf(rules, [['PLACEHOLDER_LOST'], [], [], []])).toContain('- en.title: 넣을 값이 없는 자리표시와 중괄호는 쓰지 않는다.');
  });

  it('빈 글과 혼잣말', () => {
    const hint = retryHintOf(rules, [['EMPTY_TEXT'], ['MONOLOGUE'], [], []]);
    expect(hint).toContain('- en.title: 글이 비었다. 글을 쓴다.');
    expect(hint).toContain('- en.summary: 머리말·맺음말·설명·따옴표·꾸밈 표시 없이 글만 적는다.');
  });

  it('숫자 값은 들어가지 않는다(값만 다른 상품은 같은 말을 받는다)', () => {
    const fails = [['PLACEHOLDER_LOST'], ['STRAY_NUMBER', 'GLOSSARY_MISS'], ['EMPTY_TEXT'], ['MONOLOGUE']] as const;
    const other = lineRules(inputOf(AD, { price: 990_000, days: 14 }));
    expect(retryHintOf(other, fails)).toBe(retryHintOf(rules, fails));
    expect(retryHintOf(rules, fails)).not.toMatch(/1,?500,?000|7/);
  });

  it('용어집을 통째로 넘겨도 줄마다의 규칙은 같다(해당하는 낱말만 본다)', () => {
    const picked = inputOf(AD, AD_VALUES);
    const whole = { ...picked, content: { ...picked.content, glossary: GLOSSARY } };
    expect(lineRules(whole).map((r) => r.requiredTerms)).toEqual(rules.map((r) => r.requiredTerms));
  });
});
