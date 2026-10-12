// 글 검사 5종 시험. 망가뜨린 글이 종류별로 걸리는지 본다.
import { describe, expect, it } from 'vitest';
import type { ContentCheckInput } from '@/contract/core-api';
import { checkContent } from './index';

const en = (text: string, over: Partial<ContentCheckInput> = {}) =>
  checkContent({ lang: 'en', field: 'summary', text, requiredPlaceholders: ['price', 'days'], requiredTerms: ['digital billboard'], allowedNumbers: ['11'], ...over });
const zh = (text: string, over: Partial<ContentCheckInput> = {}) =>
  checkContent({ lang: 'zh-Hans', field: 'summary', text, requiredPlaceholders: ['price'], requiredTerms: ['电子屏'], allowedNumbers: [], ...over });

const GOOD_EN = 'A digital billboard at Gangnam Station Exit 11, from {price} for {days} days.';
const GOOD_ZH = '江南站电子屏广告位，{price}起。';

describe('글 검사', () => {
  it('자리표시·용어·언어가 모두 맞으면 통과', () => {
    expect(en(GOOD_EN)).toEqual([]);
    expect(zh(GOOD_ZH)).toEqual([]);
  });

  it('자리표시가 빠지면 PLACEHOLDER_LOST', () => {
    expect(en('A digital billboard at Gangnam Station Exit 11, from {price}.')).toEqual(['PLACEHOLDER_LOST']);
  });

  it('자리표시를 숫자로 바꿔 적으면 PLACEHOLDER_LOST 와 STRAY_NUMBER', () => {
    expect(en('A digital billboard at Gangnam Station Exit 11, from 1,500,000 KRW for {days} days.')).toEqual(['PLACEHOLDER_LOST', 'STRAY_NUMBER']);
  });

  it('모르는 자리표시나 깨진 중괄호가 있으면 PLACEHOLDER_LOST', () => {
    expect(en(GOOD_EN + ' Ask about {discount}.')).toEqual(['PLACEHOLDER_LOST']);
    expect(en('A digital billboard, from {price} for {days} days. {Price')).toEqual(['PLACEHOLDER_LOST']);
    expect(en('A digital billboard, from { price } for {days} days.')).toEqual(['PLACEHOLDER_LOST']);
  });

  it('자리표시 밖 숫자는 STRAY_NUMBER. 이름·지역에 원래 있던 숫자는 봐준다', () => {
    expect(en('A digital billboard, from {price} for {days} days, 100 plays a day.')).toEqual(['STRAY_NUMBER']);
    expect(en(GOOD_EN, { allowedNumbers: [] })).toEqual(['STRAY_NUMBER']);
  });

  it('경계: "1"이 허락됐다고 "11"이나 "21"이 통과하지 않는다', () => {
    expect(en(GOOD_EN, { allowedNumbers: ['1'] })).toEqual(['STRAY_NUMBER']);
    expect(en(GOOD_EN.replace('11', '１１'))).toEqual([]);
  });

  it('한글이 섞이면 HANGUL_IN_TEXT', () => {
    expect(en('A digital billboard 전광판 at Exit 11, from {price} for {days} days.')).toEqual(['HANGUL_IN_TEXT']);
    expect(zh('江南站 전광판 电子屏广告位，{price}起。')).toEqual(['HANGUL_IN_TEXT']);
  });

  it.each(['', '   ', '.', '-', '...', '{price}'])('빈 글 %j 은 EMPTY_TEXT 하나만 낸다', (text) => {
    expect(en(text)).toEqual(['EMPTY_TEXT']);
  });

  it.each([
    'Here is the summary: ' + GOOD_EN,
    'Sure! ' + GOOD_EN,
    GOOD_EN + ' I hope this helps!',
    'Summary: ' + GOOD_EN,
    '**' + GOOD_EN + '**',
    '"' + GOOD_EN + '"',
    GOOD_EN + "\nI've kept the placeholders as requested.",
  ])('혼잣말·머리말이 남은 글 %j 은 MONOLOGUE', (text) => {
    expect(en(text)).toEqual(['MONOLOGUE']);
  });

  it.each(['好的，以下是翻译：' + GOOD_ZH, '以下是摘要：' + GOOD_ZH, '摘要：' + GOOD_ZH, GOOD_ZH + '希望对您有帮助。'])(
    '중국어 혼잣말 %j 도 MONOLOGUE',
    (text) => expect(zh(text)).toEqual(['MONOLOGUE']),
  );

  it('용어집 표기가 다른 낱말로 바뀌면 GLOSSARY_MISS. 영문 대소문자는 봐준다', () => {
    expect(en(GOOD_EN.replace('digital billboard', 'LED screen'))).toEqual(['GLOSSARY_MISS']);
    expect(en(GOOD_EN.replace('digital billboard', 'Digital Billboard'))).toEqual([]);
    expect(zh(GOOD_ZH.replace('电子屏', '大屏幕'))).toEqual(['GLOSSARY_MISS']);
  });

  it('여러 가지가 걸리면 약속한 순서로 모두 낸다', () => {
    expect(en('Sure! LED screen 전광판 for 7 days.')).toEqual(['PLACEHOLDER_LOST', 'STRAY_NUMBER', 'HANGUL_IN_TEXT', 'MONOLOGUE', 'GLOSSARY_MISS']);
  });

  it('제목처럼 자리표시와 용어가 필요 없는 글도 본다', () => {
    const title = (text: string) => checkContent({ lang: 'en', field: 'title', text, requiredPlaceholders: [], requiredTerms: [], allowedNumbers: [] });
    expect(title('Gangnam Station Digital Billboard')).toEqual([]);
    expect(title('Title: Gangnam Station Digital Billboard')).toEqual(['MONOLOGUE']);
  });
});
