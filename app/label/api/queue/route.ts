// 확인할 문서 줄. 로컬 전용(LABEL_ENABLED=1).
// 문서와 함께, 그 문서들의 표기 조각(원문에서 강조할 글자)과 지금까지 건마다 걸린 초를 내려 준다.
import { NextResponse } from 'next/server';
import { GOLD_SPLITS, type GoldSplit } from '@/contract/eval-types';
import { hintsFor, readHintFile } from '@/gold/hints';
import { LABEL_BATCH, RECHECK_COUNT, labelEnabled, labelTarget } from '@/gold/label';
import { firstPassQueue, getDoc, recheckQueue, reviewSeconds, type Queue } from '@/gold/store';
import { getPool } from '@/server/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!labelEnabled()) return new NextResponse(null, { status: 404 });
  const q = new URL(request.url).searchParams;
  const pool = getPool();
  // 표기 지시 파일이 없으면 null 이다. 그러면 강조 없이 예전처럼 돈다.
  const hintFile = await readHintFile();
  const withHints = async (queue: Queue, pass: 1 | 2) =>
    NextResponse.json({ ...queue, hints: hintsFor(hintFile, queue.docs.map((d) => d.id)), seconds: await reviewSeconds(pool, pass) });

  // 한 건만 다시 확인
  const id = q.get('id');
  if (id) {
    const doc = await getDoc(pool, id);
    if (!doc) return NextResponse.json({ error: '없는 문서' }, { status: 404 });
    return withHints({ docs: [doc], total: 1, done: 0 }, 1);
  }

  // 하루 뒤 다시 보기: 씨앗은 인자로 받는다.
  if (q.get('pass') === '2') {
    const seed = Number(q.get('seed') ?? '1');
    if (!Number.isInteger(seed)) return NextResponse.json({ error: '씨앗은 정수' }, { status: 400 });
    return withHints(await recheckQueue(pool, seed, RECHECK_COUNT), 2);
  }

  const split = q.get('split') as GoldSplit | null;
  if (!split || !GOLD_SPLITS.includes(split)) return NextResponse.json({ error: '묶음 이름이 없다' }, { status: 400 });
  // 이번에 확인하기로 고른 문서 안에서만 줄을 세운다. 목표가 없는 묶음은 전부.
  const target = await labelTarget(pool, split, hintFile);
  return withHints(await firstPassQueue(pool, split, LABEL_BATCH, target ?? undefined), 1);
}
