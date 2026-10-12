// 승인된 상품에서 글 만들기에 넘길 것: 자리표시에 넣을 숫자와 지역.
import { describe, expect, it } from 'vitest';
import { pickGlossary } from '@/content';
import { contentInputOf, placeholderValuesOf, regionOf } from '@/server/content-input';

const glossary = [
  { ko: '전광판', en: 'digital billboard', 'zh-Hans': '电子屏' },
  { ko: '커피차', en: 'coffee truck', 'zh-Hans': '咖啡车' },
];

describe('글 만들기 입력', () => {
  it('광고 지면: 가장 짧은 기간의 일수가 들어간다(목록의 순서와 상관없이)', () => {
    const ad = {
      type: 'ad' as const, subtype: '전광판', name: '하늘빛 전광판', price_krw: 1_500_000,
      spec: { region: ' 합정역 7번 출구 ' },
      options: [{ days: 30, price_krw: 5_000_000 }, { days: 7, price_krw: 1_500_000 }, { days: 14, price_krw: 2_800_000 }, { 꼴이: '다른 줄' }],
    };
    expect(placeholderValuesOf(ad)).toEqual({ price: 1_500_000, days: 7 });
    expect(regionOf(ad)).toBe('합정역 7번 출구');
    const input = contentInputOf(ad, glossary, pickGlossary);
    expect(input.content.placeholders).toEqual(['price', 'days']);
    expect(input.content.region).toBe('합정역 7번 출구');
    expect(input.content.glossary.map((g) => g.ko)).toEqual(['전광판']);
    // 모델에게 가는 쪽에는 숫자 값이 없다.
    expect(JSON.stringify(input.content)).not.toMatch(/1500000|5000000/);
  });

  it('케이터링: 지역은 출장 지역에서 오고, 가장 적은 수량이 들어간다', () => {
    const catering = {
      type: 'catering' as const, subtype: '커피차', name: '달무리 커피차', price_krw: 800_000,
      spec: { service_region: '서울 마포구', region: '쓰지 않는 칸' },
      options: [{ qty: 200, price_krw: 1_500_000 }, { qty: 100, price_krw: 800_000 }],
    };
    expect(regionOf(catering)).toBe('서울 마포구');
    expect(placeholderValuesOf(catering)).toEqual({ price: 800_000, qty: 100 });
    expect(contentInputOf(catering, glossary, pickGlossary).content.placeholders).toEqual(['price', 'qty']);
  });

  it('값이 없는 자리표시는 알려 주지 않는다: 옵션이 없는 광고 지면, 최소 수량이 없는 굿즈', () => {
    const ad = { type: 'ad' as const, subtype: '버스', name: '달빛 버스 광고', price_krw: 300_000, spec: {}, options: [] };
    expect(placeholderValuesOf(ad)).toEqual({ price: 300_000 });
    expect(contentInputOf(ad, glossary, pickGlossary).content.placeholders).toEqual(['price']);
    expect(regionOf(ad)).toBeNull();

    const goods = { type: 'goods' as const, subtype: '잡화', name: '별무리 키링', price_krw: 2_300, spec: { region: '굿즈에는 지역이 없다' }, options: [] };
    expect(placeholderValuesOf(goods)).toEqual({ price: 2_300 });
    expect(regionOf(goods)).toBeNull();
    expect(placeholderValuesOf({ ...goods, spec: { min_order_qty: 10 } })).toEqual({ price: 2_300, qty: 10 });
  });
});
