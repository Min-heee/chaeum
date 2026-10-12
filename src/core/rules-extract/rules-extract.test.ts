// 규칙만으로 뽑기 시험. 꼴이 다른 글 몇 가지와, 못 찾으면 비워 두는지를 본다.
import { describe, expect, it } from 'vitest';
import type { Extraction, FieldKey } from '@/contract/fields';
import { rulesExtract } from '../index';
import { guessSubtype, guessType } from './classify';

const raws = (ex: Extraction) => Object.fromEntries(ex.fields.map((f) => [f.field, f.raw])) as Partial<Record<FieldKey, string>>;

const AD_TABLE = `[강남역 11번 출구 대형 전광판]
위치: 강남역 11번 출구 앞
크기: 7*12(m)
해상도: 1920x1080
운영시간: 05시~25시
1회 15초, 1일 100회 이상 송출
월 유동인구 300만명
1주 150 / 2주 280 / 4주 500 (부가세 별도)
소재 접수: 게재 2주 전까지 (JPG, MP4)
전액 환불: 게재 7일 전까지
예약 마감: 게재 10일 전`;

const AD_CHAT = `안녕하세요~ 홍대입구역 스크린도어 광고 문의주셔서 감사해요!
가격은 1주 150만원이고 2주는 280만원이에요 (vat 별도)
크기는 가로 2m 세로 1.5m 구요, 운영은 첫차부터 막차까지에요
소재는 게재 일주일 전까지 주시면 됩니다`;

const COFFEE = `달보드레 커피차 안내
출장 지역: 서울 전 지역, 경기 일부
100잔 80만원
200잔 150만원
운영 시간 오전 10시 ~ 오후 2시
시안은 행사 10일 전까지 확정해 주세요.
부가세 포함`;

const GOODS = `모아나래 포토카드
사이즈 55x85mm
재질: 스노우지 300g
제작 기간: 영업일 기준 7일
최소 주문 수량 100장
정가 500원 → 판매가 350원 (VAT 포함)`;

describe('종류와 갈래', () => {
  it('낱말로 종류를 가른다', () => {
    expect(guessType(AD_TABLE)).toBe('ad');
    expect(guessType(COFFEE)).toBe('catering');
    expect(guessType(GOODS)).toBe('goods');
  });

  it('뚜렷한 낱말이 없거나 두 종류가 비기면 정하지 않는다', () => {
    expect(guessType('안녕하세요. 문의드립니다.')).toBeNull();
    expect(guessType('커피차 그리고 전광판')).toBeNull();
    expect(guessType('메뉴 안내드립니다')).toBeNull();
  });

  it('갈래는 가장 많이 나온 낱말로, 없으면 null', () => {
    expect(guessSubtype('ad', AD_CHAT)).toBe('지하철');
    expect(guessSubtype('ad', '삼성역 버스 쉘터 광고')).toBe('버스');
    expect(guessSubtype('goods', '아크릴 키링 제작')).toBe('잡화');
    expect(guessSubtype('ad', '옥외 광고 지면')).toBeNull();
  });
});

describe('표를 붙여 넣은 글', () => {
  const ex = rulesExtract(AD_TABLE);

  it('종류·갈래와 칸 16개 가운데 원문에 있는 15개를 찾는다', () => {
    expect(ex.type).toBe('ad');
    expect(ex.subtype).toBe('전광판');
    expect(raws(ex)).toEqual({
      name: '강남역 11번 출구 대형 전광판',
      price_krw: '150',
      vat_included: '부가세 별도',
      region: '강남역 11번 출구 앞',
      size_m: '7*12(m)',
      resolution_px: '1920x1080',
      hours: '05시~25시',
      spot_seconds: '15초',
      plays_per_day: '1일 100회 이상',
      footfall_per_day: '월 유동인구 300만명',
      period_options: '1주 150 / 2주 280 / 4주 500',
      material_deadline_days: '2주 전까지',
      file_format: 'JPG, MP4',
      refund_full_days: '7일 전까지',
      booking_deadline_days: '10일 전',
    });
  });

  it('값은 내지 않는다. 근거는 원문의 그 줄이다', () => {
    for (const f of ex.fields) {
      expect(f.value).toBeNull();
      expect(AD_TABLE).toContain(f.evidence);
    }
    expect(ex.fields.find((f) => f.field === 'hours')?.evidence).toBe('운영시간: 05시~25시');
  });

  it('함정: 값이 아예 없는 칸(정가)은 지어내지 않고 비워 둔다', () => {
    expect(ex.fields.some((f) => f.field === 'list_price_krw')).toBe(false);
  });
});

describe('메신저 말투', () => {
  const ex = rulesExtract(AD_CHAT);

  it('문장 속에서도 값표·크기·마감을 찾는다', () => {
    expect(ex.type).toBe('ad');
    expect(ex.subtype).toBe('지하철');
    expect(raws(ex)).toEqual({
      price_krw: '150만원',
      vat_included: 'vat 별도',
      region: '홍대입구역',
      size_m: '가로 2m 세로 1.5m',
      period_options: '1주 150만원 / 2주는 280만원',
      material_deadline_days: '일주일 전까지',
    });
  });

  it('인사말로 시작하는 첫 줄을 이름으로 삼지 않는다. "첫차부터 막차까지"는 시각이 아니라 비워 둔다', () => {
    expect(raws(ex).name).toBeUndefined();
    expect(raws(ex).hours).toBeUndefined();
  });
});

describe('케이터링과 굿즈', () => {
  it('커피차: 수량 옵션과 가장 적은 수량의 값(대표 판매가)', () => {
    const ex = rulesExtract(COFFEE);
    expect([ex.type, ex.subtype]).toEqual(['catering', '커피차']);
    expect(raws(ex)).toEqual({
      name: '달보드레 커피차',
      price_krw: '80만원',
      vat_included: '부가세 포함',
      service_region: '서울 전 지역, 경기 일부',
      quantity_options: '100잔 80만원 / 200잔 150만원',
      service_hours: '오전 10시 ~ 오후 2시',
      design_deadline_days: '10일 전까지',
    });
    expect(ex.fields.find((f) => f.field === 'quantity_options')?.evidence).toBe('100잔 80만원\n200잔 150만원');
  });

  it('함정: 정가와 판매가가 함께 적힌 줄에서 둘을 가른다', () => {
    const ex = rulesExtract(GOODS);
    expect([ex.type, ex.subtype]).toEqual(['goods', '인쇄물']);
    expect(raws(ex)).toEqual({
      name: '모아나래 포토카드',
      price_krw: '350원',
      list_price_krw: '500원',
      vat_included: 'VAT 포함',
      size_mm: '55x85mm',
      material: '스노우지 300g',
      lead_time_days: '7일',
      min_order_qty: '100장',
    });
  });
});

describe('헷갈리는 표현을 억지로 읽지 않는다', () => {
  it('해상도를 크기로 읽지 않고, 크기를 해상도로 읽지 않는다', () => {
    const ex = raws(rulesExtract('성수동 LED 전광판\n화면 1920x1080px, 가로 4m x 세로 3m\n가격 300만원'));
    expect(ex.resolution_px).toBe('1920x1080px');
    expect(ex.size_m).toBe('가로 4m x 세로 3m');
  });

  it('"3~5일" 같은 범위와 값표의 "1주"는 마감 일수로 읽지 않는다', () => {
    const goods = raws(rulesExtract('아크릴 키링 굿즈\n제작 기간 3~5일 소요\n개당 2,500원'));
    expect(goods.lead_time_days).toBeUndefined();
    const ad = raws(rulesExtract('강남역 전광판 광고\n소재 포함 1주 150만원'));
    expect(ad.material_deadline_days).toBeUndefined();
  });

  it('기간 바로 뒤에 금액이 오지 않으면 값표로 읽지 않는다', () => {
    const ex = raws(rulesExtract('강남역 전광판 광고\n1주 기준 100회 이상 송출, 150만원'));
    expect(ex.period_options).toBeUndefined();
  });

  it('"1회 15초"의 1회를 하루 송출 횟수로 읽지 않는다', () => {
    const ex = raws(rulesExtract('강남역 전광판 광고\n송출: 1회 15초\n가격 150만원'));
    expect(ex.plays_per_day).toBeUndefined();
    expect(ex.spot_seconds).toBe('15초');
  });

  it('"지역"의 "역"을 지하철역으로 읽지 않는다', () => {
    const ex = raws(rulesExtract('서울 전 지역 버스 광고\n가격 150만원\n1주 150만원'));
    expect(ex.region).toBeUndefined();
  });

  it('금액이 여럿인데 이름표가 없으면 판매가를 고르지 않는다', () => {
    const ex = raws(rulesExtract('아크릴 키링 굿즈 50x50mm\n견본 3,000원, 본품 2,500원'));
    expect(ex.price_krw).toBeUndefined();
  });

  it('이름표만 있는 줄이면 다음 줄에서 값을 찾는다', () => {
    const ex = raws(rulesExtract('강남역 전광판 광고\n위치\n강남역 11번 출구\n가격\n150만원'));
    expect(ex.region).toBe('강남역 11번 출구');
    expect(ex.price_krw).toBe('150만원');
  });

  it('"위치가 좋아서"의 위치를 이름표로 읽지 않는다', () => {
    const ex = raws(rulesExtract('전광판 광고 소개\n위치가 좋아서 인기가 많습니다\n가격 150만원'));
    expect(ex.region).toBeUndefined();
  });
});

describe('등록 대상이 아닌 글', () => {
  it('함정: 잔금 안내는 not_product', () => {
    const text = '안녕하세요, 별솔 미디어입니다.\n강남역 전광판 광고 잔금 150만원 입금 부탁드립니다.\n세금계산서는 입금 확인 후 발행됩니다.';
    expect(rulesExtract(text)).toEqual({ type: 'not_product', subtype: null, fields: [] });
  });

  it('함정: 인사말은 not_product', () => {
    expect(rulesExtract('안녕하세요! 항상 이용해 주셔서 감사합니다. 추석 연휴 동안 휴무입니다.').type).toBe('not_product');
  });

  it('종류 낱말은 있어도 값·규격이 하나도 없으면 not_product', () => {
    expect(rulesExtract('전광판 광고에 관심 가져 주셔서 감사합니다.').type).toBe('not_product');
  });

  it('빈 글도 실패하지 않는다', () => {
    expect(rulesExtract('')).toEqual({ type: 'not_product', subtype: null, fields: [] });
  });
});
