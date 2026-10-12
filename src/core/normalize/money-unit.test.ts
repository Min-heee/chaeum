// 글에 선언된 금액 단위 시험. 확실한 꼴만 선언으로 읽고, 모르면 짐작하지 않는다.
import { describe, expect, it } from 'vitest';
import type { ExtractedField } from '@/contract/fields';
import { declaredMoneyUnits, evaluateDraft, normalizeField, normalizeMoney, normalizePeriodOptions, recheckDraft, rulesExtract } from '../index';

const FAILED = { value: null, reasons: ['PARSE_FAILED'] };
const CONVERTED = ['UNIT_CONVERTED'];

describe('선언된 금액 단위 찾기', () => {
  it.each([
    ['가격표 (단위: 천원)', 1_000],
    ['(단위 : 만원)', 10_000],
    ['단위=원', 1],
    ['단위: 원, VAT 포함', 1],
    ['금액 단위는 천원입니다', 1_000],
    ['모든 금액의 단위는 만원이며 부가세 별도', 10_000],
    ['단위：천원', 1_000],
    ['단위: 만 원', 10_000],
    ['단위: 백만원', 1_000_000],
    ['단위: 원화', 1],
    ['단위: 1,000원', 1_000],
    ['[단위 천원]', 1_000],
    ['요금표 (천원 단위)', 1_000],
    ['Price list (unit: KRW 1,000)', 1_000],
    ['Unit: KRW', 1],
    ['unit = thousand won', 1_000],
    ['Units: 10,000 KRW', 10_000],
    ['All prices in thousand won', 1_000],
    ['(in KRW thousands)', 1_000],
    ['价格表 (单位: 千韩元)', 1_000],
    ['单位:韩元', 1],
    ['金额单位:万韩元', 10_000],
    ['单位: 千韩元，不含税', 1_000],
    ['单位 千韩元', 1_000],
    ['금액 단위는천원입니다', 1_000],
    ['단위: 십만원', 100_000],
    ['단위: 천만원', 10_000_000],
    ['단위: 억원', 100_000_000],
    ['단위: 1천원', 1_000],
    ['Prices in millions of won', 1_000_000],
    ['Amounts are stated in KRW thousands', 1_000],
    ['unit: KRW 1,000, VAT excluded', 1_000],
    ['currency unit: KRW 1,000', 1_000],
    ['단위: 천원 VAT 별도', 1_000],
    ['단위: 천원/부가세 별도', 1_000],
    ['단위: 만원으로 표기', 10_000],
    ['단위: 원 (천원 아님)', 1],
    ['요금표 [만원 단위] 1주 150', 10_000],
  ])('%j → %d원', (text, unit) => {
    expect(declaredMoneyUnits(text)).toEqual([unit]);
  });

  it.each([
    '최소 주문 단위: 100개',
    '판매 단위는 박스',
    '주 단위 집계입니다',
    '주문 단위: 10,000원',
    '충전 단위는 1,000원',
    '만원 단위로 주문할 수 있습니다',
    '10만원 단위 절사',
    '(1,000원 단위)',
    '단위: 천',
    '단위: 만명',
    '단위: 원단 1롤',
    '단위: cm',
    '사이즈(cm)',
    '단위: 달러',
    'unit: USD',
    'unit: KRW 550',
    'unit price: 5,000 won',
    'prices in KRW',
    '起订单位: 100个',
    '单位: 千元',
    '가격 150만원, 부가세 별도',
    // 끝수 처리·묶음 크기·부정·정정 문장
    '단위: 천원 미만은 버립니다',
    '※ 단위: 1,000원 미만 절사',
    '단위: 원 미만 절사',
    '단위 : 만원 이상 주문',
    '단위 천원 아님, 만원임',
    '단위: 천원이 아니라 만원',
    '단위: 천원 → 만원으로 변경',
    '금액 단위는 천원부터',
    '단위: 원, 10,000원부터 주문',
    '추가 주문은 (천원 단위) 로 받습니다',
    '금액은 (만원 단위) 절사',
    '(천원 단위)씩 올라갑니다',
    // 영어: "unit" 앞 낱말과 뒤에 이어지는 말
    'Price per unit: KRW 1,000',
    'per unit: KRW 10,000',
    'Order unit: KRW 10,000',
    'Minimum order unit: KRW 10,000',
    'business unit: KRW',
    'Unit: KRW 1,000 per cup',
    'Sold in units: KRW 1,000 vouchers',
    'unit: KRW 1,000 thousand',
    'unit: KRW 1,000.5',
    'unit KRW 1,000',
    'subunit: KRW 1,000',
    'unit: KRW thousandth',
    'unit: wonderful',
    'unit: 1,000 won only today',
    'Located in Wonju, in thousand won-style signage',
    'Available in million won packages',
    'within thousand won',
    'prices in thousand wonders',
    '运费单位千韩元',
  ])('%j 는 금액 단위 선언이 아니다', (text) => {
    expect(declaredMoneyUnits(text)).toEqual([]);
  });

  it('같은 단위를 두 번 적으면 하나, 서로 다른 단위면 둘 다 낸다', () => {
    expect(declaredMoneyUnits('가격 (단위: 천원)\n100잔 550\n\n추가 (단위 : 천원)\n200잔 990')).toEqual([1_000]);
    expect(declaredMoneyUnits('광고비 (단위: 만원)\n1주 150\n\n제작비 (단위: 천원)\n시안 300')).toEqual([1_000, 10_000]);
  });

  it('한 선언에 단위를 여럿 나열했으면 모두 낸다(어느 것인지 모른다)', () => {
    expect(declaredMoneyUnits('(단위: 원, 천원)')).toEqual([1, 1_000]);
    expect(declaredMoneyUnits('단위: 천원/만원')).toEqual([1_000, 10_000]);
  });

  it('선언은 한 줄 안에서만 읽는다', () => {
    expect(declaredMoneyUnits('단위\n천원')).toEqual([]);
  });
});

describe('선언이 걸리는 자리', () => {
  it('같은 줄(앞이든 뒤든)과 같은 단락의 아래 줄에 건다', () => {
    const text = '광고료는 7일(250) 입니다. 단위: 만원\n30일(1,020)';
    expect(declaredMoneyUnits(text, ['7일(250)'])).toEqual([10_000]);
    expect(declaredMoneyUnits(text, ['30일(1,020)'])).toEqual([10_000]);
  });

  it('선언보다 위에 있는 줄에는 걸지 않는다', () => {
    const text = 'A 전광판: 1주 1500000\nB 버스쉘터 (단위: 천원) 1주 900';
    expect(declaredMoneyUnits(text, ['A 전광판: 1주 1500000'])).toEqual([]);
    expect(declaredMoneyUnits(text, ['1주 900'])).toEqual([1_000]);
  });

  it('빈 줄로 나뉜 다른 단락에는 걸지 않는다', () => {
    const text = '매출 실적(단위: 백만원) 2023년 1,200\n\n이번 상품 가격 350';
    expect(declaredMoneyUnits(text)).toEqual([1_000_000]);
    expect(declaredMoneyUnits(text, ['이번 상품 가격 350'])).toEqual([]);
    expect(declaredMoneyUnits(text, ['2023년 1,200'])).toEqual([1_000_000]);
  });

  it('선언 말고 숫자가 없는 줄이 단락의 끝이면 표 머리로 보고 바로 다음 단락까지 건다', () => {
    const text = '가격표 (단위: 1,000원)\n\n\n100잔 550\n200잔 990\n\n추가 300';
    expect(declaredMoneyUnits(text, ['100잔 550'])).toEqual([1_000]);
    expect(declaredMoneyUnits(text, ['200잔 990'])).toEqual([1_000]);
    expect(declaredMoneyUnits(text, ['추가 300'])).toEqual([]);
  });

  it('숫자가 함께 있는 줄이나 단락 가운데의 줄은 표 머리가 아니다', () => {
    expect(declaredMoneyUnits('매출 12 (단위: 천원)\n\n가격 350', ['가격 350'])).toEqual([]);
    expect(declaredMoneyUnits('가격표 (단위: 천원)\n100잔 550\n\n추가 300', ['추가 300'])).toEqual([]);
  });

  it('단락마다 선언이 다르면 금액은 자기 단락의 선언만 따른다. 한 단락에 둘이면 둘 다 낸다', () => {
    const text = '광고비 (단위: 만원)\n1주 150\n\n제작비 (단위: 천원)\n시안 300';
    expect(declaredMoneyUnits(text, ['1주 150'])).toEqual([10_000]);
    expect(declaredMoneyUnits(text, ['시안 300'])).toEqual([1_000]);
    expect(declaredMoneyUnits('광고비 (단위: 만원)\n제작비 (단위: 천원)\n시안 300', ['시안 300'])).toEqual([1_000, 10_000]);
  });

  it('앞의 구절(근거)부터 보고, 글에 없으면 다음 구절(원문 표현)로 자리를 찾는다', () => {
    const text = '가격표 (단위: 천원)\n100잔 550\n\n문의 550-1234';
    expect(declaredMoneyUnits(text, ['문의 550-1234', '550'])).toEqual([]);
    expect(declaredMoneyUnits(text, ['글에 없는 근거', '100잔 550'])).toEqual([1_000]);
    expect(declaredMoneyUnits(text, [null, '100잔 550'])).toEqual([1_000]);
  });

  it('여러 줄을 이어 붙인 표현은 조각마다 찾고, 공백과 전각·반각 차이는 봐준다', () => {
    const text = '가격표 (단위: 천원)\n100잔   550\n200잔 ９９０';
    expect(declaredMoneyUnits(text, ['100잔 550 / 200잔 990'])).toEqual([1_000]);
    expect(declaredMoneyUnits(text, ['100잔 550\n200잔 990'])).toEqual([1_000]);
  });

  it('여러 줄에 걸친 구절은 걸친 줄을 모두 본다', () => {
    const text = '1주 150\n(단위: 천원) 2주 280';
    expect(declaredMoneyUnits(text, ['1주 150\n(단위: 천원) 2주 280'])).toEqual([1_000]);
    expect(declaredMoneyUnits(text, ['1주 150'])).toEqual([]);
  });

  it('자리를 못 찾으면(글에 없는 구절, 한 글자) 선언이 없는 것으로 둔다', () => {
    const text = '가격표 (단위: 천원)\n100잔 550';
    expect(declaredMoneyUnits(text, ['300잔 1,500'])).toEqual([]);
    expect(declaredMoneyUnits(text, ['100잔 550 / 300잔 1,500'])).toEqual([]);
    expect(declaredMoneyUnits(text, ['5'])).toEqual([]);
    expect(declaredMoneyUnits(text, [null])).toEqual([]);
    expect(declaredMoneyUnits(text, [])).toEqual([]);
  });
});

describe('선언된 단위로 금액 맞추기', () => {
  it('단위 없는 금액은 선언된 단위로 읽고 단위 바꿈을 붙인다', () => {
    expect(normalizeMoney('550', [1_000])).toEqual({ value: 550_000, reasons: CONVERTED });
    expect(normalizeMoney('1,020', [10_000])).toEqual({ value: 10_200_000, reasons: CONVERTED });
    expect(normalizeMoney('5.5', [1_000])).toEqual({ value: 5_500, reasons: CONVERTED });
  });

  it('선언이 "원"이면 만원으로 짐작하지 않는다. 단위를 다른 곳에서 가져왔으니 표시는 붙는다', () => {
    expect(normalizeMoney('5,000', [1])).toEqual({ value: 5_000, reasons: CONVERTED });
    expect(normalizeMoney('9,999', [1])).toEqual({ value: 9_999, reasons: CONVERTED });
  });

  it('선언이 "원"이고 1만 이상이면 선언이 없을 때와 같다(표시 없음)', () => {
    expect(normalizeMoney('10,000', [1])).toEqual({ value: 10_000, reasons: [] });
    expect(normalizeMoney('1,500,000', [1])).toEqual({ value: 1_500_000, reasons: [] });
    expect(normalizeMoney('1,500,000', [1])).toEqual(normalizeMoney('1,500,000'));
  });

  it('천원·만원 선언 아래의 1만 이상인 수는 곱하지 않고 못 읽은 것으로 둔다(이미 원으로 적은 값일 수 있다)', () => {
    expect(normalizeMoney('9,999', [1_000])).toEqual({ value: 9_999_000, reasons: CONVERTED });
    expect(normalizeMoney('10,000', [1_000])).toEqual(FAILED);
    expect(normalizeMoney('1,500,000', [1_000])).toEqual(FAILED);
    expect(normalizeMoney('1,500,000', [10_000])).toEqual(FAILED);
    expect(normalizePeriodOptions('1주 1,500,000 / 2주 2,800,000', [1_000])).toEqual(FAILED);
  });

  it('만원보다 큰 선언(십만원·백만원·억원)은 상품 값의 단위로 쓰지 않는다', () => {
    expect(normalizeMoney('350', [10_000])).toEqual({ value: 3_500_000, reasons: CONVERTED });
    expect(normalizeMoney('350', [100_000])).toEqual(FAILED);
    expect(normalizeMoney('350', [1_000_000])).toEqual(FAILED);
    expect(normalizeMoney('12', [100_000_000])).toEqual(FAILED);
    expect(normalizeMoney('350만원', [1_000_000])).toEqual({ value: 3_500_000, reasons: [] });
  });

  it.each([
    ['55만원', 550_000],
    ['550,000원', 550_000],
    ['₩550,000', 550_000],
    ['KRW 550,000', 550_000],
    ['550천원', 550_000],
    ['55万韩元', 550_000],
    ['55만', 550_000],
    ['550천', 550_000],
    ['5.5억', 550_000_000],
  ])('raw 에 단위가 있으면 선언보다 raw 가 이긴다: %j', (raw, won) => {
    expect(normalizeMoney(raw, [1_000])).toEqual({ value: won, reasons: [] });
    expect(normalizeMoney(raw, [1_000, 10_000])).toEqual({ value: won, reasons: [] });
    expect(normalizeMoney(raw, [1_000_000])).toEqual({ value: won, reasons: [] });
  });

  it('서로 다른 선언이 둘이면 단위 없는 금액은 못 읽은 것으로 둔다', () => {
    expect(normalizeMoney('550', [1_000, 10_000])).toEqual(FAILED);
    expect(normalizeMoney('15000', [1, 1_000])).toEqual(FAILED);
    expect(normalizePeriodOptions('1주 150 2주 280', [1_000, 10_000])).toEqual(FAILED);
  });

  it('선언이 없으면 전과 같다(작은 수는 만원으로 짐작)', () => {
    expect(normalizeMoney('150')).toEqual({ value: 1_500_000, reasons: CONVERTED });
    expect(normalizeMoney('150', [])).toEqual({ value: 1_500_000, reasons: CONVERTED });
    expect(normalizeMoney('10000', [])).toEqual({ value: 10_000, reasons: [] });
    expect(normalizeField('quantity_options', '100잔 80 / 200잔 150')).toEqual({
      value: [{ qty: 100, price_krw: 800_000 }, { qty: 200, price_krw: 1_500_000 }],
      reasons: CONVERTED,
    });
  });

  it('선언이 있어도 못 읽는 표기는 그대로 못 읽는다', () => {
    expect(normalizeMoney('150~200', [1_000])).toEqual(FAILED);
    expect(normalizeMoney('$550', [1_000])).toEqual(FAILED);
    expect(normalizeMoney('550 / 990', [1_000])).toEqual(FAILED);
  });

  it('값표 안의 단위 없는 금액도 선언을 따른다', () => {
    expect(normalizePeriodOptions('1주 1,500 2주 2,800', [1_000])).toEqual({
      value: [{ days: 7, price_krw: 1_500_000 }, { days: 14, price_krw: 2_800_000 }],
      reasons: CONVERTED,
    });
    expect(normalizeField('quantity_options', '100 잔 550 / 200 잔 990', [1_000])).toEqual({
      value: [{ qty: 100, price_krw: 550_000 }, { qty: 200, price_krw: 990_000 }],
      reasons: CONVERTED,
    });
  });

  it('한 표 안에서 단위가 적힌 줄과 선언을 따른 줄이 섞이면 통째로 못 읽은 것으로 둔다', () => {
    expect(normalizePeriodOptions('1주 150만원 / 2주 280', [1_000])).toEqual(FAILED);
    expect(normalizePeriodOptions('1주 150 / 2주 280만원', [10_000])).toEqual(FAILED);
    expect(normalizeField('quantity_options', '100잔 55만원 / 200잔 990', [1_000])).toEqual(FAILED);
    expect(normalizePeriodOptions('1주 150만원 / 2주 280', [1])).toEqual(FAILED);
  });

  it('모든 줄에 단위가 적힌 표, "원" 선언 아래의 큰 수가 섞인 표, 선언이 없는 표는 전과 같다', () => {
    const rows = [{ days: 7, price_krw: 1_500_000 }, { days: 14, price_krw: 2_800_000 }];
    expect(normalizePeriodOptions('1주 150만원 / 2주 280만원', [1_000])).toEqual({ value: rows, reasons: [] });
    expect(normalizePeriodOptions('1주 150만원 / 2주 2,800,000', [1])).toEqual({ value: rows, reasons: [] });
    expect(normalizePeriodOptions('1주 150만원 / 2주 280')).toEqual({ value: rows, reasons: CONVERTED });
  });

  it('기간 옵션 칸도 칸 이름으로 부를 때 선언을 받는다', () => {
    expect(normalizeField('period_options', '7일: 250 / 14일: 480', [1_000])).toEqual({
      value: [{ days: 7, price_krw: 250_000 }, { days: 14, price_krw: 480_000 }],
      reasons: CONVERTED,
    });
    expect(normalizeField('list_price_krw', '700', [1_000])).toEqual({ value: 700_000, reasons: CONVERTED });
  });

  it('금액이 아닌 칸은 선언과 상관없다', () => {
    expect(normalizeField('min_order_qty', '100', [1_000])).toEqual({ value: 100, reasons: [] });
    expect(normalizeField('footfall_per_day', '일 10만명', [1_000])).toEqual({ value: 100_000, reasons: [] });
  });
});

describe('한 번에 돌기에서 선언된 단위', () => {
  const source = (header: string) => `[별하늘 커피차 응원 세트]\n${header}\n100잔 550\n200잔 990\n출장 지역: 전국`;
  const fields: ExtractedField[] = [
    { field: 'name', raw: '별하늘 커피차 응원 세트', value: '별하늘 커피차 응원 세트', evidence: '[별하늘 커피차 응원 세트]' },
    { field: 'price_krw', raw: '550', value: 550_000, evidence: '100잔 550' },
    {
      field: 'quantity_options',
      raw: '100잔 550\n200잔 990',
      value: [{ qty: 100, price_krw: 550_000 }, { qty: 200, price_krw: 990_000 }],
      evidence: '100잔 550',
    },
    { field: 'service_region', raw: '전국', value: '전국', evidence: '출장 지역: 전국' },
  ];
  const run = (header: string) =>
    evaluateDraft({ sourceText: source(header), extraction: { type: 'catering', subtype: '커피차', fields }, extractedBy: 'llm' });
  const of = (ev: ReturnType<typeof run>, field: string) => ev.fields.find((f) => f.field === field)!;

  it('"(단위: 천원)" 아래의 단위 없는 금액을 천원으로 읽는다. 모델 값과 어긋나지 않고, 사람이 보게 표시는 남는다', () => {
    const ev = run('가격표 (단위: 천원)');
    expect(of(ev, 'price_krw')).toMatchObject({ codeValue: 550_000, finalValue: 550_000, reasons: CONVERTED });
    expect(of(ev, 'quantity_options')).toMatchObject({
      codeValue: [{ qty: 100, price_krw: 550_000 }, { qty: 200, price_krw: 990_000 }],
      reasons: CONVERTED,
    });
  });

  it('선언이 없으면 전처럼 만원으로 짐작하고, 모델 값과 다르면 값 불일치가 붙는다', () => {
    const ev = run('가격표');
    expect(of(ev, 'price_krw')).toMatchObject({ codeValue: 5_500_000, reasons: ['VALUE_MISMATCH', 'UNIT_CONVERTED'] });
  });

  it('선언이 둘이면 코드는 읽지 않는다. 모델 값이 실리되 읽지 못함이 붙어 확인 필요로 간다', () => {
    const ev = run('가격표 (단위: 천원)\n배송비 (단위: 만원)');
    expect(of(ev, 'price_krw')).toMatchObject({ codeValue: null, finalValue: 550_000, reasons: ['PARSE_FAILED'] });
    expect(of(ev, 'quantity_options')).toMatchObject({ codeValue: null, reasons: ['PARSE_FAILED'] });
    expect(ev.route).toBe('NEEDS_REVIEW');
  });

  it('"단위"가 금액과 상관없이 쓰인 글은 전과 같다', () => {
    const ev = run('최소 주문 단위: 100잔, 판매 단위는 세트');
    expect(of(ev, 'price_krw').codeValue).toBe(5_500_000);
  });

  it('다른 단락의 선언은 이 칸의 금액에 걸지 않는다(전과 같이 만원으로 짐작)', () => {
    const text = `작년 매출 (단위: 백만원) 1,200\n\n${source('가격표')}`;
    const ev = evaluateDraft({ sourceText: text, extraction: { type: 'catering', subtype: '커피차', fields }, extractedBy: 'llm' });
    expect(of(ev, 'price_krw')).toMatchObject({ codeValue: 5_500_000, reasons: ['VALUE_MISMATCH', 'UNIT_CONVERTED'] });
  });

  it('선언 아래에 이미 원으로 적힌 큰 수는 코드가 곱하지 않는다. 모델 값이 실리고 읽지 못함이 붙는다', () => {
    const text = '[별하늘 전광판]\n요금 (단위: 천원)\n가격 1,500,000';
    const ev = evaluateDraft({
      sourceText: text,
      extraction: { type: 'ad', subtype: '전광판', fields: [{ field: 'price_krw', raw: '1,500,000', value: 1_500_000, evidence: '가격 1,500,000' }] },
      extractedBy: 'llm',
    });
    expect(of(ev, 'price_krw')).toMatchObject({ codeValue: null, finalValue: 1_500_000, reasons: ['PARSE_FAILED'] });
    expect(ev.route).toBe('NEEDS_REVIEW');
  });

  it('"단위: 원" 아래의 큰 금액에는 표시가 붙지 않는다(선언이 없을 때와 같다)', () => {
    const one = (header: string) =>
      evaluateDraft({
        sourceText: `[별하늘 전광판]\n${header}\n가격 1,500,000`,
        extraction: { type: 'ad', subtype: '전광판', fields: [{ field: 'price_krw', raw: '1,500,000', value: 1_500_000, evidence: '가격 1,500,000' }] },
        extractedBy: 'llm',
      });
    expect(of(one('요금 (단위: 원)'), 'price_krw')).toMatchObject({ codeValue: 1_500_000, reasons: [] });
    expect(of(one('요금 (단위: 원)'), 'price_krw')).toEqual(of(one('요금'), 'price_krw'));
  });

  it('규칙만으로 뽑는 길도 같은 단위를 쓴다', () => {
    const text = source('가격표 (단위: 천원)');
    const ev = evaluateDraft({ sourceText: text, extraction: { ...rulesExtract(text), type: 'catering' }, extractedBy: 'rules' });
    expect(of(ev, 'price_krw')).toMatchObject({ codeValue: 550_000, reasons: CONVERTED });
    expect(of(ev, 'quantity_options').codeValue).toEqual([{ qty: 100, price_krw: 550_000 }, { qty: 200, price_krw: 990_000 }]);
  });

  it('사람이 다른 칸을 고친 뒤 다시 따져도 같은 단위로 읽는다', () => {
    const first = run('가격표 (단위: 천원)');
    const again = recheckDraft({
      sourceText: source('가격표 (단위: 천원)'),
      type: 'catering',
      subtype: '커피차',
      extractedBy: 'llm',
      fields: first.fields,
      edits: { service_region: '수도권' },
    });
    expect(of(again, 'price_krw')).toMatchObject({ codeValue: 550_000, reasons: CONVERTED });
    expect(of(again, 'quantity_options').codeValue).toEqual([{ qty: 100, price_krw: 550_000 }, { qty: 200, price_krw: 990_000 }]);
  });

  it('사람이 고친 칸의 코드 값(견줄 때 쓰는 값)도 같은 단위로 읽는다', () => {
    const again = recheckDraft({
      sourceText: source('가격표 (단위: 천원)'),
      type: 'catering',
      subtype: '커피차',
      extractedBy: 'llm',
      fields: run('가격표 (단위: 천원)').fields,
      edits: { price_krw: 560_000 },
    });
    expect(of(again, 'price_krw')).toMatchObject({ codeValue: 550_000, finalValue: 560_000, editedByHuman: true, reasons: [] });
  });
});
