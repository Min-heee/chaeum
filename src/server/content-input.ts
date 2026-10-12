// 승인된 상품 한 줄에서 글 만들기에 넘길 것을 만든다.
// 모델에게는 글자 정보만 간다. 숫자는 자리표시에 코드가 넣는다(값을 고쳐 승인해도 같은 요청이 된다).
import {
  PLACEHOLDERS,
  type ContentApi,
  type GenerateContentInput,
  type GlossaryEntry,
  type Placeholder,
} from '@/contract/content';
import { placeholderValuesOf } from '@/content/placeholder-values';
import type { ProductDraft } from './repos/products';

type ProductFacts = Pick<ProductDraft, 'type' | 'subtype' | 'name' | 'price_krw' | 'spec' | 'options'>;

// 자리표시에 넣을 숫자를 고르는 규칙은 src/content/placeholder-values.ts 에 있다(점검도 같은 함수를 쓴다).
export { placeholderValuesOf };

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/** 광고 지면은 위치, 케이터링은 출장 지역. 굿즈는 없다. */
export function regionOf(product: Pick<ProductDraft, 'type' | 'spec'>): string | null {
  if (product.type === 'ad') return textOrNull(product.spec.region);
  if (product.type === 'catering') return textOrNull(product.spec.service_region);
  return null;
}

/**
 * 글 만들기 한 번에 넘길 것. 용어집 줄 고르기는 src/content 의 pickGlossary 를 받아 쓴다
 * (모델에게 가는 글자 정보가 한곳에서 정해지게).
 */
export function contentInputOf(
  product: ProductFacts,
  glossary: readonly GlossaryEntry[],
  pickGlossary: ContentApi['pickGlossary'],
): GenerateContentInput {
  const facts = { type: product.type, subtype: product.subtype, name: product.name, region: regionOf(product) };
  const values = placeholderValuesOf(product);
  const placeholders: Placeholder[] = PLACEHOLDERS.filter((p) => values[p] !== undefined);
  return { content: { ...facts, glossary: pickGlossary(glossary, facts), placeholders }, values };
}
