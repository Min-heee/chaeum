// 실제 자료 넣기의 API. 로컬 전용(LABEL_ENABLED=1 이 아니면 404).
//   GET  ?id=N                     넣은 글 한 건(초안, 강조할 근거 구절)과 진행
//   POST { action: 'draft', content, sourceUrl, fetchedOn, kind }      글을 넣고 얼린 파이프라인으로 초안을 채운다(실제 호출 1번)
//   POST { action: 'confirm', intakeId, type, subtype, fields, seconds }   사람이 확정한 값으로 정답 문서를 만든다
//   POST { action: 'skip', intakeId, note }                             우리 양식에 없는 상품이라 넘긴다
//   POST { action: 'undo', intakeId, reviewId }                         방금 한 확정·넘김을 되돌린다
import { NextResponse } from 'next/server';
import { DEFAULT_LLM_MODEL } from '@/contract/llm-types';
import { labelEnabled } from '@/gold/label';
import { hintsFromDraft } from '@/gold/origins';
import { OutsidePathError, realGoldFile } from '@/gold/paths';
import {
  checkIntakeInput,
  MISSING_TABLE_NOTE,
  confirmIntake,
  createIntakeLocked,
  ensureRealLoaded,
  getIntake,
  isMissingTable,
  realCallCap,
  realProgress,
  skipIntake,
  undoIntake,
  writeRealFile,
  type Intake,
} from '@/gold/real';
import { GoldError } from '@/gold/store';
import { createProvider } from '@/llm';
import { getPool, withTx } from '@/server/db';
import { PgLlmCallStore } from '@/server/repos/llm-calls';

export const dynamic = 'force-dynamic';

const STATUS = { NOT_FOUND: 404, INVALID: 400, CONFLICT: 409 } as const;

/** 화면으로 내려가는 꼴. 강조할 구절은 모델이 준 근거다. */
const forScreen = (intake: Intake) => ({ ...intake, hints: hintsFromDraft(intake.content, intake.model) });

const fail = (err: unknown) => {
  if (err instanceof GoldError) return NextResponse.json({ error: err.message }, { status: STATUS[err.code] });
  // 저장소 밖에 둘 파일의 자리가 틀렸다(상대 경로, 저장소 안). 아무것도 쓰지 않고 알린다.
  if (err instanceof OutsidePathError) return NextResponse.json({ error: err.message }, { status: 400 });
  // 이행 0006 을 돌리기 전이다.
  if (isMissingTable(err)) return NextResponse.json({ error: MISSING_TABLE_NOTE }, { status: 503 });
  throw err;
};

export async function GET(request: Request) {
  if (!labelEnabled()) return new NextResponse(null, { status: 404 });
  const id = new URL(request.url).searchParams.get('id') ?? '';
  const pool = getPool();
  try {
    const intake = await getIntake(pool, id);
    if (!intake) return NextResponse.json({ error: '없는 초안' }, { status: 404 });
    return NextResponse.json({ intake: forScreen(intake), progress: await realProgress(pool) });
  } catch (err) {
    return fail(err);
  }
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
  const intakeId = typeof body.intakeId === 'string' ? body.intakeId : '';

  try {
    switch (body.action) {
      case 'draft': {
        const input = checkIntakeInput(body);
        // 가장 작은 모델로만 부른다(LLM_MODEL 을 따르지 않는다). 얼린 파이프라인의 모델이 그것이다. 키는 넘기기만 한다.
        const store = new PgLlmCallStore();
        const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
        const live = apiKey ? createProvider({ kind: 'anthropic', model: DEFAULT_LLM_MODEL, apiKey, store }) : null;
        // 한 번에 하나만 채운다(같은 글을 겹쳐 보내도 한 번만 부르고, 상한을 넘겨 부르지 않는다).
        const made = await createIntakeLocked(pool, input, { store, live, cap: realCallCap(), model: DEFAULT_LLM_MODEL });
        return NextResponse.json({ intake: forScreen(made.intake), resumed: made.resumed, progress: await realProgress(pool) });
      }
      case 'confirm': {
        const file = realGoldFile();
        const outcome = await withTx(async (client) => {
          // 파일에만 있는 문서가 있으면 먼저 싣는다(번호가 겹치지 않게, 파일을 다시 쓸 때 사라지지 않게).
          await ensureRealLoaded(client, file);
          return confirmIntake(client, {
            intakeId,
            type: typeof body.type === 'string' ? body.type : '',
            subtype: typeof body.subtype === 'string' ? body.subtype : null,
            fields: body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields) ? (body.fields as Record<string, unknown>) : {},
            seconds: typeof body.seconds === 'number' ? body.seconds : null,
          });
        });
        // 원문은 저장소 밖의 파일로만 간다.
        await writeRealFile(pool, file);
        return NextResponse.json({ ...outcome, progress: await realProgress(pool) });
      }
      case 'skip': {
        await skipIntake(pool, intakeId, typeof body.note === 'string' ? body.note : null);
        return NextResponse.json({ ok: true, progress: await realProgress(pool) });
      }
      case 'undo': {
        const reviewId = typeof body.reviewId === 'string' && /^\d+$/.test(body.reviewId) ? body.reviewId : null;
        // 파일의 자리를 먼저 본다. 자리가 틀렸으면 DB 도 건드리지 않는다.
        const file = realGoldFile();
        const undone = await withTx((client) => undoIntake(client, intakeId, reviewId));
        if (undone.removedDocId) await writeRealFile(pool, file, [undone.removedDocId]);
        const intake = await getIntake(pool, intakeId);
        return NextResponse.json({ ...undone, intake: intake ? forScreen(intake) : null, progress: await realProgress(pool) });
      }
      default:
        return NextResponse.json({ error: '모르는 일(action)' }, { status: 400 });
    }
  } catch (err) {
    return fail(err);
  }
}
