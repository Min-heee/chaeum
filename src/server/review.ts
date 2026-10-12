// 검수의 결정: 승인, 반려, 다시 돌리기. 상태 변경과 변경 기록, 뒤따르는 쓰기가 한 트랜잭션이다.
// 결정마다 맨 앞에서 공간을 본다(본보기 공간은 읽기 전용, 쓰면 마지막 쓰기 시각이 오른다).
// (칸 고치기는 맞추기·따지기를 다시 돌려야 해서 판단 코드가 붙는 다음 단계에서 더한다.)
import type { PoolClient } from 'pg';
import { LIMITS, type EventActor, type SystemEventReason } from '@/contract/api';
import type { RejectCode } from '@/contract/reasons';
import type { DraftStatus } from '@/contract/transitions';
import { withTx } from './db';
import { AppError, isAppError, isConstraintViolation } from './errors';
import { assertEventRoom } from './limits';
import { enqueue, requeue } from './queue';
import { getDraftById, listFields, saveFields, transitionDraft, type Draft } from './repos/drafts';
import { buildProduct, insertProduct, ProductInvalid } from './repos/products';
import { touchWorkspaceForWrite } from './workspace';

export interface Decision {
  workspaceId: string;
  draftId: number;
  /** 화면이 보고 있던 version */
  version: number;
  actor?: EventActor;
  now: Date;
}

export interface DecisionResult {
  id: number;
  status: DraftStatus;
  version: number;
}

const result = (d: Draft): DecisionResult => ({ id: d.id, status: d.status, version: d.version });

/** 상품 등록이 막혔을 때 변경 기록에 남기는 사유 코드. */
export const PRODUCT_INVALID_REASON: SystemEventReason = 'PRODUCT_INVALID';

/**
 * 승인. 초안 → APPROVED, 상품 한 줄, 글 작업 한 건이 한 트랜잭션에 들어간다.
 * 상품이 꼴 검사나 표의 제약에 걸리면 셋 다 되돌아간다. 초안이 READY 였다면 "확인 필요"로 내려보내고 PRODUCT_INVALID(422)를 던진다.
 */
export async function approveDraft(input: Decision): Promise<DecisionResult & { productId: number }> {
  const { workspaceId, draftId, version, now } = input;
  const actor = input.actor ?? 'seller';
  try {
    return await withTx(async (client) => {
      // 본보기 공간이면 여기서 막힌다. 방문자 공간이면 마지막 쓰기 시각이 오른다.
      await touchWorkspaceForWrite(client, workspaceId, now);
      const draft = await transitionDraft(client, { workspaceId, draftId, to: 'APPROVED', expectedVersion: version, actor, now });
      const product = buildProduct(draft.type, draft.subtype, await listFields(client, draftId));
      const productId = await insertProduct(client, workspaceId, draftId, product, now);
      await enqueue(client, 'content', productId, now);
      return { ...result(draft), productId };
    });
  } catch (err) {
    const why = err instanceof ProductInvalid ? err.issues.join(' ') : isConstraintViolation(err) ? '상품 표의 제약에 걸렸습니다.' : null;
    if (why === null) throw err;
    // 위 트랜잭션은 이미 통째로 되돌아갔다. 바로 승인 가능하다던 초안은 사람이 다시 보게 한다.
    const current = await withTx((client) => sendBackToReview(client, workspaceId, draftId, version, now));
    throw new AppError('PRODUCT_INVALID', `상품으로 등록할 수 없습니다. ${why}`, current ?? undefined);
  }
}

async function sendBackToReview(client: PoolClient, workspaceId: string, draftId: number, version: number, now: Date) {
  try {
    const draft = await transitionDraft(client, {
      workspaceId, draftId, to: 'NEEDS_REVIEW', expectedVersion: version, actor: 'system', reasonCode: PRODUCT_INVALID_REASON, now,
    });
    return { status: draft.status, version: draft.version };
  } catch (err) {
    // 이미 "확인 필요"이거나 그사이 남이 바꿨으면 그대로 둔다.
    if (isAppError(err)) return err.current ?? { status: 'NEEDS_REVIEW', version };
    throw err;
  }
}

/** 반려 메모를 정리한다. DB 가 받지 못하는 글자(NUL)와 제어 글자를 빼고(줄바꿈은 둔다) 상한에서 자른다. 비면 null. */
function cleanMemo(memo: string | null | undefined): string | null {
  const clean = (memo ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd')
    .trim();
  return clean ? [...clean].slice(0, LIMITS.rejectMemoMaxChars).join('') : null;
}

/** 반려. 사유 코드가 꼭 있어야 한다. */
export async function rejectDraft(input: Decision & { reasonCode: RejectCode; memo?: string | null }): Promise<DecisionResult> {
  const memo = cleanMemo(input.memo);
  return withTx(async (client) => {
    await touchWorkspaceForWrite(client, input.workspaceId, input.now);
    return result(
      await transitionDraft(client, {
        workspaceId: input.workspaceId,
        draftId: input.draftId,
        to: 'REJECTED',
        expectedVersion: input.version,
        actor: input.actor ?? 'seller',
        patch: { rejectCode: input.reasonCode, rejectMemo: memo },
        now: input.now,
      }),
    );
  });
}

/**
 * 다시 돌리기. FAILED·REJECTED 를 PROCESSING 으로 돌리고 뽑기 작업을 처음부터 다시 줄에 세운다.
 * 반려 → 다시 돌리기를 끝없이 되풀이하지 못하게, 변경 기록이 상한에 닿은 초안은 LIMIT_EXCEEDED(429).
 */
export async function reprocessDraft(input: Decision): Promise<DecisionResult> {
  return withTx(async (client) => {
    await touchWorkspaceForWrite(client, input.workspaceId, input.now);
    const draft = await transitionDraft(client, {
      workspaceId: input.workspaceId,
      draftId: input.draftId,
      to: 'PROCESSING',
      expectedVersion: input.version,
      actor: input.actor ?? 'seller',
      now: input.now,
    });
    // 위에서 공간과 상태를 확인했다. 넘쳤으면 던져서 방금 바꾼 것까지 되돌린다.
    await assertEventRoom(client, input.draftId);
    // 지난 칸을 지운다. 처리 중인 초안의 상세는 칸이 빈 목록이다(약속).
    await saveFields(client, input.draftId, []);
    await requeue(client, 'extract', input.draftId, input.now);
    return result(draft);
  });
}

/**
 * 뽑기 작업이 dead 가 됐을 때 초안을 FAILED 로 바꾼다. 작업 줄의 onDead 자리에 끼운다.
 * 초안이 없거나(공간이 지워짐) 이미 PROCESSING 이 아니면 아무것도 하지 않는다.
 */
export async function failDraftIfProcessing(client: PoolClient, draftId: number, now: Date, reasonCode: SystemEventReason = 'JOB_DEAD'): Promise<boolean> {
  const draft = await getDraftById(client, draftId);
  if (!draft || draft.status !== 'PROCESSING') return false;
  await transitionDraft(client, {
    workspaceId: draft.workspaceId, draftId, to: 'FAILED', expectedVersion: draft.version, actor: 'system', reasonCode, now,
  });
  return true;
}
