// 방금 판정 되돌리기. 그 문서의 가장 최근 확인 기록이 방금 그 판정일 때만 지운다. 로컬 전용(LABEL_ENABLED=1).
import { NextResponse } from 'next/server';
import { labelEnabled } from '@/gold/label';
import { GoldError, undoReview } from '@/gold/store';
import { withTx } from '@/server/db';

export const dynamic = 'force-dynamic';

const STATUS = { NOT_FOUND: 404, INVALID: 400, CONFLICT: 409 } as const;

export async function POST(request: Request) {
  if (!labelEnabled()) return new NextResponse(null, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'JSON 이 아니다' }, { status: 400 });
  }
  const { docId, reviewId } = body;
  if (typeof docId !== 'string' || typeof reviewId !== 'string' || !/^\d+$/.test(reviewId)) {
    return NextResponse.json({ error: 'docId 와 reviewId 가 있어야 한다' }, { status: 400 });
  }

  try {
    return NextResponse.json(await withTx((client) => undoReview(client, { docId, reviewId, before: body.before })));
  } catch (err) {
    if (err instanceof GoldError) return NextResponse.json({ error: err.message }, { status: STATUS[err.code] });
    throw err;
  }
}
