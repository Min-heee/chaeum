// 확인 한 건을 적는다. 고친 칸이 있으면 정답도 함께 바뀐다. 로컬 전용(LABEL_ENABLED=1).
import { NextResponse } from 'next/server';
import { labelEnabled } from '@/gold/label';
import { GoldError, recordReview, type ReviewInput } from '@/gold/store';
import { withTx } from '@/server/db';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!labelEnabled()) return new NextResponse(null, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'JSON 이 아니다' }, { status: 400 });
  }
  if (typeof body.docId !== 'string' || (body.pass !== 1 && body.pass !== 2)) {
    return NextResponse.json({ error: 'docId 와 pass(1 또는 2)가 있어야 한다' }, { status: 400 });
  }
  const fixes = body.fixes && typeof body.fixes === 'object' && !Array.isArray(body.fixes) ? (body.fixes as Record<string, unknown>) : {};
  const input: ReviewInput = {
    docId: body.docId,
    pass: body.pass,
    drop: body.drop === true,
    fixes,
    ...(typeof body.subtype === 'string' ? { subtype: body.subtype } : {}),
    seconds: typeof body.seconds === 'number' ? body.seconds : null,
  };

  try {
    return NextResponse.json(await withTx((client) => recordReview(client, input)));
  } catch (err) {
    if (err instanceof GoldError) return NextResponse.json({ error: err.message }, { status: err.code === 'NOT_FOUND' ? 404 : 400 });
    throw err;
  }
}
