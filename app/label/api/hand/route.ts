// 손글 쓰기의 API. 로컬 전용(LABEL_ENABLED=1 이 아니면 404). 모델을 부르지 않는다.
//   GET  ?id=hand-001                                                    이미 쓴 문서 한 건(고쳐 쓸 때)
//   POST { action: 'save', id?, content, type, subtype, fields, tipIds, seconds }   새로 쓰거나(id 없음) 고친다
//   POST { action: 'undo', docId, reviewId }                             방금 새로 쓴 한 건을 지운다
import { NextResponse } from 'next/server';
import { HAND_TARGET, listHand, saveHand, undoHand } from '@/gold/hand';
import { labelEnabled } from '@/gold/label';
import { GoldError, getDoc } from '@/gold/store';
import { getPool, withTx } from '@/server/db';

export const dynamic = 'force-dynamic';

const STATUS = { NOT_FOUND: 404, INVALID: 400, CONFLICT: 409 } as const;

export async function GET(request: Request) {
  if (!labelEnabled()) return new NextResponse(null, { status: 404 });
  const id = new URL(request.url).searchParams.get('id') ?? '';
  const doc = /^hand-\d{3}$/.test(id) ? await getDoc(getPool(), id) : null;
  if (!doc || doc.split !== 'hand') return NextResponse.json({ error: '없는 손글 문서' }, { status: 404 });
  return NextResponse.json({ doc });
}

export async function POST(request: Request) {
  if (!labelEnabled()) return new NextResponse(null, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'JSON 이 아니다' }, { status: 400 });
  }
  const pool = getPool();
  const progress = async () => ({ target: HAND_TARGET, docs: await listHand(pool) });

  try {
    if (body.action === 'save') {
      const outcome = await withTx((client) =>
        saveHand(client, {
          id: typeof body.id === 'string' && body.id ? body.id : null,
          content: typeof body.content === 'string' ? body.content : '',
          type: typeof body.type === 'string' ? body.type : '',
          subtype: typeof body.subtype === 'string' ? body.subtype : null,
          fields: body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields) ? (body.fields as Record<string, unknown>) : {},
          tipIds: Array.isArray(body.tipIds) ? body.tipIds.filter((t): t is string => typeof t === 'string') : [],
          seconds: typeof body.seconds === 'number' ? body.seconds : null,
        }),
      );
      return NextResponse.json({ ...outcome, progress: await progress() });
    }
    if (body.action === 'undo') {
      if (typeof body.docId !== 'string' || typeof body.reviewId !== 'string') return NextResponse.json({ error: 'docId 와 reviewId 가 있어야 한다' }, { status: 400 });
      const { docId, reviewId } = body;
      await withTx((client) => undoHand(client, docId, reviewId));
      return NextResponse.json({ ok: true, progress: await progress() });
    }
    return NextResponse.json({ error: '모르는 일(action)' }, { status: 400 });
  } catch (err) {
    if (err instanceof GoldError) return NextResponse.json({ error: err.message }, { status: STATUS[err.code] });
    throw err;
  }
}
