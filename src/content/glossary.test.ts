// 용어집 줄 고르기 시험.
import { describe, expect, it } from 'vitest';
import type { GlossaryEntry } from '@/contract/content';
import { AD, CATERING, GLOSSARY, GOODS } from './fixtures';
import { entriesIn, pickGlossary, termsIn } from './glossary';

const kos = (entries: readonly GlossaryEntry[]) => entries.map((e) => e.ko);

describe('글에서 용어 찾기', () => {
  it('글에 나온 순서대로 찾는다', () => {
    expect(kos(entriesIn('강남역 11번 출구 전광판', GLOSSARY))).toEqual(['강남역', '전광판']);
    expect(termsIn('강남역 11번 출구 전광판', GLOSSARY, 'en')).toEqual(['Gangnam Station', 'digital billboard']);
    expect(termsIn('강남역 11번 출구 전광판', GLOSSARY, 'zh-Hans')).toEqual(['江南站', '电子屏']);
  });

  it('긴 낱말에 묻힌 짧은 낱말은 치지 않는다', () => {
    expect(kos(entriesIn('달보드레 커피차', GLOSSARY))).toEqual(['커피차']);
  });

  it('짧은 낱말이 따로도 나오면 둘 다 친다', () => {
    expect(kos(entriesIn('커피차에서 커피 한 잔', GLOSSARY))).toEqual(['커피차', '커피']);
  });

  it('전각 글자와 대소문자 차이는 봐준다', () => {
    const glossary = [{ ko: 'LED 전광판', en: 'LED billboard', 'zh-Hans': 'LED屏' }];
    expect(kos(entriesIn('하늘빛 ｌｅｄ 전광판', glossary))).toEqual(['LED 전광판']);
  });

  it('글이 없거나 해당하는 낱말이 없으면 빈 목록', () => {
    expect(entriesIn(null, GLOSSARY)).toEqual([]);
    expect(entriesIn('', GLOSSARY)).toEqual([]);
    expect(entriesIn('별무리 엽서', GLOSSARY)).toEqual([]);
  });

  it('같은 낱말이 용어집에 두 번 있으면 앞의 줄을 쓴다', () => {
    const twice = [...GLOSSARY, { ko: '전광판', en: 'LED screen', 'zh-Hans': '大屏幕' }];
    expect(termsIn('하늘빛 전광판', twice, 'en')).toEqual(['digital billboard']);
  });
});

describe('상품에 해당하는 줄 고르기', () => {
  it('종류 이름·갈래·이름·지역에 낱말이 들어 있는 줄만 고른다', () => {
    // 광고 지면(종류 이름), 강남역(지역), 전광판(갈래와 이름)
    expect(kos(pickGlossary(GLOSSARY, AD))).toEqual(['강남역', '광고 지면', '전광판']);
    expect(kos(pickGlossary(GLOSSARY, CATERING))).toEqual(['커피차', '합정역']);
    expect(kos(pickGlossary(GLOSSARY, GOODS))).toEqual(['포토카드']);
  });

  it('지역이 없어도 된다', () => {
    expect(kos(pickGlossary(GLOSSARY, { ...AD, region: null }))).toEqual(['광고 지면', '전광판']);
  });

  it('해당하는 줄이 없으면 빈 목록', () => {
    expect(pickGlossary(GLOSSARY, { type: 'goods', subtype: '잡화', name: '별무리 엽서', region: null })).toEqual([]);
    expect(pickGlossary([], AD)).toEqual([]);
  });

  it('용어집의 줄 순서를 바꾸거나 상관없는 줄을 더해도 고른 결과가 같다(모델에게 가는 입력이 같다)', () => {
    const base = pickGlossary(GLOSSARY, AD);
    const reversed = [...GLOSSARY].reverse();
    const more = [{ ko: '현수막', en: 'banner', 'zh-Hans': '横幅' }, ...GLOSSARY, { ko: '성수동', en: 'Seongsu-dong', 'zh-Hans': '圣水洞' }];
    expect(pickGlossary(reversed, AD)).toEqual(base);
    expect(pickGlossary(more, AD)).toEqual(base);
  });

  it('용어집을 고치지 않는다', () => {
    const before = JSON.stringify(GLOSSARY);
    pickGlossary(GLOSSARY, AD);
    expect(JSON.stringify(GLOSSARY)).toBe(before);
  });
});
