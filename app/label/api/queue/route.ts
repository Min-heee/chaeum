// 확인할 문서 줄. 로컬 전용(LABEL_ENABLED=1).
import { NextResponse } from 'next/server';
import { GOLD_SPLITS, type GoldSplit } from '@/contract/eval-types';
import { LABEL_BATCH, RECHECK_COUNT, labelEnabled } from '@/gold/label';
import { firstPassQueue, getDoc, recheckQueue } from '@/gold/store';
import { getPool } from '@/server/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!labelEnabled()) return new NextResponse(null, { status: 404 });
  const q = new URL(request.url).searchParams;
  const pool = getPool();

  // 한 건만 다시 확인
  const id = q.get('id');
  if (id) {
    const doc = await getDoc(pool, id);
    if (!doc) return NextResponse.json({ error: '없는 문서' }, { status: 404 });
    return NextResponse.json({ docs: [doc], total: 1, done: 0 });
  }

  // 하루 뒤 다시 보기: 씨앗은 인자로 받는다.
  if (q.get('pass') === '2') {
    const seed = Number(q.get('seed') ?? '1');
    if (!Number.isInteger(seed)) return NextResponse.json({ error: '씨앗은 정수' }, { status: 400 });
    return NextResponse.json(await recheckQueue(pool, seed, RECHECK_COUNT));
  }

  const split = q.get('split') as GoldSplit | null;
  if (!split || !GOLD_SPLITS.includes(split)) return NextResponse.json({ error: '묶음 이름이 없다' }, { status: 400 });
  return NextResponse.json(await firstPassQueue(pool, split, LABEL_BATCH));
}
