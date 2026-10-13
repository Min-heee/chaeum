// 초안 상세(검수 화면). 주소에 pub=1 이 붙으면 읽기 전용 본보기 공간의 초안이다.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DraftDetail } from '../../../components/DraftDetail';

/** 탭 제목에 초안 번호를 넣는다(여러 건을 탭으로 열어도 구별된다). 상품 이름은 읽어 온 뒤 화면이 덧붙인다. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: /^[1-9][0-9]{0,14}$/.test(id) ? `초안 #${id} · 채움` : '초안 · 채움' };
}

export default async function DraftPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pub?: string | string[] }>;
}) {
  const { id } = await params;
  if (!/^[1-9][0-9]{0,14}$/.test(id)) notFound();
  const { pub } = await searchParams;
  return <DraftDetail draftId={Number(id)} publicSpace={pub === '1'} />;
}
