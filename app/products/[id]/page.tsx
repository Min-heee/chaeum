// 상품 하나: 등록된 값과 영어·중국어 글, 글 검사 결과.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProductDetail } from '../../../components/ProductDetail';

export const metadata: Metadata = { title: '상품 · 채움' };

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[1-9][0-9]{0,14}$/.test(id)) notFound();
  return <ProductDetail productId={Number(id)} />;
}
