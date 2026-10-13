// 시험에 쓰는 지어낸 상품. 이름은 모두 지어낸 것이다.
import type { CompareProduct } from '@/contract/tools/compare';

let serial = 0;

export function ad(over: Partial<CompareProduct> = {}): CompareProduct {
  serial += 1;
  return {
    id: serial,
    type: 'ad',
    subtype: '전광판',
    name: `가상 전광판 ${serial}`,
    price_krw: 1_500_000,
    vat_included: false,
    spec: {},
    options: [{ days: 7, price_krw: 1_500_000 }],
    ...over,
  };
}

export function catering(over: Partial<CompareProduct> = {}): CompareProduct {
  serial += 1;
  return {
    id: serial,
    type: 'catering',
    subtype: '커피차',
    name: `가상 커피차 ${serial}`,
    price_krw: 800_000,
    vat_included: true,
    spec: {},
    options: [{ qty: 100, price_krw: 800_000 }],
    ...over,
  };
}

export function goods(over: Partial<CompareProduct> = {}): CompareProduct {
  serial += 1;
  return { id: serial, type: 'goods', subtype: '잡화', name: `가상 슬로건 ${serial}`, price_krw: 4_500, vat_included: true, spec: {}, options: [], ...over };
}
