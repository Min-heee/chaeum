// 정답 확인 화면: 왼쪽 원문, 오른쪽 칸별 정답. 로컬 전용.
import { notFound } from 'next/navigation';
import { GOLD_SPLITS, type GoldSplit } from '@/contract/eval-types';
import { labelEnabled } from '@/gold/label';
import ReviewClient from '../ReviewClient';

export const dynamic = 'force-dynamic';

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function LabelReview({ searchParams }: { searchParams: Promise<Params> }) {
  if (!labelEnabled()) notFound();
  const q = await searchParams;
  const id = one(q.id);
  const split = one(q.split) as GoldSplit | undefined;
  const seed = Number(one(q.seed) ?? '1');

  if (id) return <ReviewClient query={`id=${encodeURIComponent(id)}`} pass={1} title={`${id} 다시 확인`} />;
  if (one(q.pass) === '2' && Number.isInteger(seed)) {
    return <ReviewClient query={`pass=2&seed=${seed}`} pass={2} title={`하루 뒤 다시 보기 (씨앗 ${seed})`} />;
  }
  if (split && GOLD_SPLITS.includes(split)) return <ReviewClient query={`split=${split}`} pass={1} title="첫 확인" />;
  notFound();
}
