// 초안 상세(검수 화면). 주소에 pub=1 이 붙으면 읽기 전용 본보기 공간의 초안이다.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DraftDetail } from '../../../components/DraftDetail';

export const metadata: Metadata = { title: '초안 · 채움' };

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
