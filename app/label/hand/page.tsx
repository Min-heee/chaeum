// 손글 쓰기. 로컬 전용(LABEL_ENABLED=1 이 아니면 404). 모델을 부르지 않는다.
import { notFound } from 'next/navigation';
import { HAND_TARGET, listHand } from '@/gold/hand';
import { labelEnabled } from '@/gold/label';
import { getDoc } from '@/gold/store';
import { getPool } from '@/server/db';
import HandClient from './HandClient';

export const dynamic = 'force-dynamic';

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function LabelHand({ searchParams }: { searchParams: Promise<Params> }) {
  if (!labelEnabled()) notFound();
  const q = await searchParams;
  const id = one(q.id);
  const pool = getPool();
  const found = id && /^hand-\d{3}$/.test(id) ? await getDoc(pool, id) : null;
  return <HandClient target={HAND_TARGET} docs={await listHand(pool)} start={found && found.split === 'hand' ? found : null} />;
}
