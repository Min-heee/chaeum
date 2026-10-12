// 숫자 서식과 자리표시 채우기 시험.
import { describe, expect, it } from 'vitest';
import { fillPlaceholders, formatCount, formatMoney, groupDigits, hasBraces, isUsableValue } from './format';

describe('숫자 서식', () => {
  it.each([
    [7, '7'],
    [100, '100'],
    [1000, '1,000'],
    [12_000, '12,000'],
    [1_500_000, '1,500,000'],
    [25_000_000, '25,000,000'],
    [1_234_567_890, '1,234,567,890'],
  ])('세 자리마다 쉼표: %d → %s', (n, text) => {
    expect(groupDigits(n)).toBe(text);
  });

  it('금액은 언어마다 꼴이 다르다', () => {
    expect(formatMoney(1_500_000, 'en')).toBe('KRW 1,500,000');
    expect(formatMoney(1_500_000, 'zh-Hans')).toBe('1,500,000韩元');
    expect(formatMoney(900, 'en')).toBe('KRW 900');
    expect(formatMoney(900, 'zh-Hans')).toBe('900韩元');
  });

  it('일수와 수량은 숫자만 넣는다(단위 낱말은 글이 쓴다)', () => {
    expect(formatCount(7)).toBe('7');
    expect(formatCount(1000)).toBe('1,000');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, undefined, null, '7'])('넣을 수 없는 값 %s', (value) => {
    expect(isUsableValue(value)).toBe(false);
  });
});

describe('자리표시 채우기', () => {
  const values = { price: 1_500_000, days: 7, qty: 100 };

  it('영어: 금액 앞에 KRW', () => {
    expect(fillPlaceholders('From {price} for {days} days.', values, 'en')).toBe('From KRW 1,500,000 for 7 days.');
  });

  it('중국어: 금액 뒤에 韩元', () => {
    expect(fillPlaceholders('{days}天{price}起。', values, 'zh-Hans')).toBe('7天1,500,000韩元起。');
    expect(fillPlaceholders('{qty}杯{price}起。', values, 'zh-Hans')).toBe('100杯1,500,000韩元起。');
  });

  it('같은 자리표시가 여러 번 나오면 모두 채운다', () => {
    expect(fillPlaceholders('{price}. Yes, {price}.', values, 'en')).toBe('KRW 1,500,000. Yes, KRW 1,500,000.');
  });

  it('자리표시가 없는 글은 그대로다', () => {
    expect(fillPlaceholders('Haneulbit Digital Billboard', values, 'en')).toBe('Haneulbit Digital Billboard');
  });

  it('값이 없는 자리표시는 그대로 둔다. 숫자를 지어내지 않는다', () => {
    expect(fillPlaceholders('From {price} for {days} days.', { price: 12_000 }, 'en')).toBe('From KRW 12,000 for {days} days.');
    expect(fillPlaceholders('{price}起', {}, 'zh-Hans')).toBe('{price}起');
  });

  it.each([0, -5, 1.5, Number.NaN])('넣을 수 없는 값(%s)이면 그대로 둔다', (bad) => {
    expect(fillPlaceholders('From {price}.', { price: bad }, 'en')).toBe('From {price}.');
  });

  it('모르는 자리표시와 꼴이 다른 중괄호는 건드리지 않는다', () => {
    expect(fillPlaceholders('{discount} off, {Price}, { price }, ｛price｝', values, 'en')).toBe('{discount} off, {Price}, { price }, ｛price｝');
  });

  it('남은 중괄호를 알아본다(전각도)', () => {
    expect(hasBraces('From KRW 12,000 for {days} days.')).toBe(true);
    expect(hasBraces('｛price｝起')).toBe(true);
    expect(hasBraces('From KRW 12,000.')).toBe(false);
  });

  it.each([
    ['from ₩{price} a week', 'from KRW 1,500,000 a week'],
    ['from KRW {price} a week', 'from KRW 1,500,000 a week'],
    ['from {price} KRW a week', 'from KRW 1,500,000 a week'],
    ['from {price} won.', 'from KRW 1,500,000.'],
    ['from {price}won a week', 'from KRW 1,500,000 a week'],
  ])('영어: 모델이 통화를 또 적었으면 겹치지 않게 뺀다 (%s)', (text, filled) => {
    expect(fillPlaceholders(text, values, 'en')).toBe(filled);
  });

  it.each([
    ['{price}韩元起', '1,500,000韩元起'],
    ['{price} 韩币起', '1,500,000韩元起'],
    ['韩元{price}起', '1,500,000韩元起'],
    ['₩{price}起', '1,500,000韩元起'],
  ])('중국어: 모델이 통화를 또 적었으면 겹치지 않게 뺀다 (%s)', (text, filled) => {
    expect(fillPlaceholders(text, values, 'zh-Hans')).toBe(filled);
  });

  it('통화처럼 보여도 낱말의 일부면 건드리지 않는다. 다른 자리표시 옆의 낱말도 그대로다', () => {
    expect(fillPlaceholders('{price} wonderful', values, 'en')).toBe('KRW 1,500,000 wonderful');
    expect(fillPlaceholders('{days} won', values, 'en')).toBe('7 won');
  });

  it('값이 없어 {price} 를 못 채우면 옆의 통화 낱말도 지우지 않는다', () => {
    expect(fillPlaceholders('from {price} KRW', {}, 'en')).toBe('from {price} KRW');
  });
});
