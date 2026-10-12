// 상품의 값에서 글의 자리표시에 들어갈 숫자를 고른다. 순수 함수다.
// 글 만들기(src/server/content-input.ts)와 점검(src/tools/audit)이 같이 쓴다. 글에 나와도 되는 숫자가 한곳에서 정해진다.
import type { PlaceholderValues } from '@/contract/content';
import { PeriodOptionSchema, QuantityOptionSchema, type ProductType } from '@/contract/fields';

export interface PlaceholderFacts {
  type: ProductType;
  price_krw: number;
  spec: Record<string, unknown>;
  options: readonly unknown[];
}

/** 자리표시에 넣을 숫자. price: 대표 판매가, days: 가장 짧은 기간, qty: 가장 적은 수량(굿즈는 최소 주문 수량). */
export function placeholderValuesOf(product: PlaceholderFacts): PlaceholderValues {
  const values: PlaceholderValues = { price: product.price_krw };
  if (product.type === 'ad') {
    const days = product.options.flatMap((o) => {
      const parsed = PeriodOptionSchema.safeParse(o);
      return parsed.success ? [parsed.data.days] : [];
    });
    if (days.length > 0) values.days = Math.min(...days);
  } else if (product.type === 'catering') {
    const qty = product.options.flatMap((o) => {
      const parsed = QuantityOptionSchema.safeParse(o);
      return parsed.success ? [parsed.data.qty] : [];
    });
    if (qty.length > 0) values.qty = Math.min(...qty);
  } else if (typeof product.spec.min_order_qty === 'number') {
    values.qty = product.spec.min_order_qty;
  }
  return values;
}
