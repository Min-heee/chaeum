// 상품 하나: 등록된 값과 영어·중국어 글, 글 검사 결과. 주소에 pub=1 이 붙으면 읽기 전용 본보기 공간의 상품이다.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProductDetail } from '../../../components/ProductDetail';

export const metadata: Metadata = { title: '상품 · 채움' };

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pub?: string | string[] }>;
}) {
  const { id } = await params;
  if (!/^[1-9][0-9]{0,14}$/.test(id)) notFound();
  const { pub } = await searchParams;
  return <ProductDetail productId={Number(id)} publicSpace={pub === '1'} />;
}
