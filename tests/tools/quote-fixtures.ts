// 견적 시험과 잼이 함께 쓰는 지어낸 상품 묶음. 이름·값·지역 조합은 전부 지어낸 것이다(지하철역·동네 이름만 실제 이름).
// 본체가 채운 상품의 꼴(종류·갈래·판매가·부가세·규격 칸·옵션) 그대로다.
import type { QuoteProduct } from '../../src/contract/tools/quote';

export const FIXTURE_PRODUCTS: QuoteProduct[] = [
  {
    id: 1, type: 'ad', subtype: '전광판', name: '홍대입구역 9번 출구 전광판', price_krw: 1_400_000, vat_included: false,
    spec: { region: '홍대입구역 9번 출구', booking_deadline_days: 14, material_deadline_days: 7 },
    options: [{ days: 7, price_krw: 1_400_000 }, { days: 14, price_krw: 2_600_000 }, { days: 30, price_krw: 4_800_000 }],
  },
  {
    id: 2, type: 'ad', subtype: '전광판', name: '합정역 사거리 전광판', price_krw: 1_500_000, vat_included: true,
    spec: { region: '합정역', booking_deadline_days: 10, material_deadline_days: 5 },
    options: [{ days: 7, price_krw: 1_500_000 }, { days: 14, price_krw: 2_800_000 }],
  },
  {
    id: 3, type: 'ad', subtype: '지하철', name: '강남역 스크린도어 광고', price_krw: 3_300_000, vat_included: false,
    spec: { region: '강남역', booking_deadline_days: 21, material_deadline_days: 10 },
    options: [{ days: 30, price_krw: 3_300_000 }],
  },
  {
    id: 4, type: 'ad', subtype: '버스', name: '서울 시내버스 외부 광고', price_krw: 900_000, vat_included: null,
    spec: { region: '서울' },
    options: [{ days: 30, price_krw: 900_000 }],
  },
  {
    id: 5, type: 'catering', subtype: '커피차', name: '달무리 커피차', price_krw: 700_000, vat_included: true,
    spec: { service_region: '서울 상암동, 성수동, 경기 남부', design_deadline_days: 7 },
    options: [{ qty: 100, price_krw: 700_000 }, { qty: 200, price_krw: 1_300_000 }, { qty: 300, price_krw: 1_850_000 }],
  },
  {
    id: 6, type: 'catering', subtype: '도시락', name: '솔바람 도시락', price_krw: 600_000, vat_included: false,
    spec: { service_region: '서울 성수동, 상암동', design_deadline_days: 5 },
    options: [{ qty: 50, price_krw: 600_000 }, { qty: 100, price_krw: 1_100_000 }],
  },
  {
    id: 7, type: 'goods', subtype: '인쇄물', name: '포토카드 인쇄', price_krw: 900, vat_included: true,
    spec: { min_order_qty: 100, lead_time_days: 7 },
    options: [],
  },
  {
    id: 8, type: 'goods', subtype: '잡화', name: '아크릴 키링 제작', price_krw: 5_500, vat_included: false,
    spec: { min_order_qty: 50, lead_time_days: 14 },
    options: [],
  },
];
