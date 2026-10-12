// 접수. 글을 정리하고 상한을 본 뒤 원문·초안·작업을 한 트랜잭션에 넣는다.
import type { WorkspaceKind } from '@/contract/api';
import type { DraftStatus } from '@/contract/transitions';
import { getPool, withTx } from './db';
import { AppError, isAppError } from './errors';
import { assertBulkSize, assertWorkspaceRoom, countIntake, prepareText } from './limits';
import { findByHash, nextBatchNo, receiveDoc } from './repos/source-docs';
import { sweepStaleWorkspaces, workspaceForWrite } from './workspace';

export type IntakeItem =
  | { result: 'new' | 'duplicate'; sourceDocId: number; draftId: number; status: DraftStatus }
  | { result: 'error'; code: string; message: string };

export interface IntakeOptions {
  /** 요청이 들고 온 공간 번호. 없으면 새 공간을 만든다. */
  workspaceId: string | null;
  now: Date;
  /** 새 공간을 만들 때의 종류. 기본은 방문자 공간. */
  kindForNew?: Exclude<WorkspaceKind, 'public'>;
}

/**
 * 여러 건을 받는다. 건마다 결과(new / duplicate / error)를 돌려준다. 한 건이 틀려도 나머지는 들어간다.
 * 넣을 수 있는 글이 하나도 없으면 공간도 만들지 않는다(workspace 는 받은 번호 그대로).
 */
export async function intakeMany(texts: readonly unknown[], options: IntakeOptions): Promise<{ workspace: string | null; items: IntakeItem[] }> {
  assertBulkSize(texts.length);
  const { now } = options;

  const prepared = texts.map((text) => {
    try {
      return prepareText(text);
    } catch (err) {
      if (isAppError(err)) return { error: err };
      throw err;
    }
  });
  if (prepared.every((p) => 'error' in p)) {
    return { workspace: options.workspaceId, items: prepared.map((p) => asErrorItem((p as { error: AppError }).error)) };
  }

  const run = () => withTx(async (client) => {
    // 공간 줄이 여기서 잠긴다. 같은 공간의 접수는 한 줄로 서므로 건수 상한과 중복 확인이 어긋나지 않는다.
    const workspace = await workspaceForWrite(client, options.workspaceId, now, options.kindForNew);
    const batchNo = texts.length > 1 ? await nextBatchNo(client, workspace.id) : null;
    const items: IntakeItem[] = [];

    for (const p of prepared) {
      if ('error' in p) {
        items.push(asErrorItem(p.error));
        continue;
      }
      const existing = await findByHash(client, workspace.id, p.hash);
      if (existing) {
        items.push({ result: 'duplicate', sourceDocId: existing.sourceDocId, draftId: existing.draftId, status: existing.status });
        continue;
      }
      try {
        // 상한은 쓰기 전에 본다. 넘으면 이 건만 빠지고 트랜잭션은 이어진다.
        await assertWorkspaceRoom(client, workspace.id);
        await countIntake(client, now);
      } catch (err) {
        if (!isAppError(err)) throw err;
        items.push(asErrorItem(err));
        continue;
      }
      const doc = await receiveDoc(client, { workspaceId: workspace.id, clean: p.clean, hash: p.hash, batchNo, now });
      items.push({ result: doc.duplicate ? 'duplicate' : 'new', sourceDocId: doc.sourceDocId, draftId: doc.draftId, status: doc.status });
    }
    // 이번에 공간을 만들었는데(번호 없이 왔거나 모르는 번호로 왔거나) 한 건도 못 넣었으면(상한 초과) 빈 공간을 남기지 않게 되돌린다.
    if (workspace.created && items.every((item) => item.result === 'error')) throw new NothingStored(items);
    return { workspace: workspace.id as string | null, items };
  });
  const out = await run().catch((err: unknown) => {
    if (err instanceof NothingStored) return { workspace: options.workspaceId, items: err.items };
    throw err;
  });

  await sweepQuietly(now);
  return out;
}

/** 한 건을 받는다. 틀린 글이나 상한 초과는 오류로 던진다. */
export async function intakeOne(
  text: unknown,
  options: IntakeOptions,
): Promise<{ workspace: string; sourceDocId: number; draftId: number; status: DraftStatus; duplicate: boolean }> {
  prepareText(text); // 틀린 글이면 DB 를 건드리기 전에 400
  const { workspace, items } = await intakeMany([text], options);
  const item = items[0];
  if (item?.result === 'error') throw new AppError(item.code as AppError['code'], item.message);
  if (!item || !workspace) throw new Error('접수 결과가 없다');
  return { workspace, sourceDocId: item.sourceDocId, draftId: item.draftId, status: item.status, duplicate: item.result === 'duplicate' };
}

/** 트랜잭션을 되돌리려고 던지는 표식. 건별 결과를 들고 나온다. */
class NothingStored extends Error {
  constructor(readonly items: IntakeItem[]) {
    super('넣은 글이 없다');
  }
}

const asErrorItem = (err: AppError): IntakeItem => ({ result: 'error', code: err.code, message: err.message });

/** 쓰기 요청이 올 때마다 낡은 방문자 공간을 조금씩 지운다. 실패해도 접수는 성공이다. */
async function sweepQuietly(now: Date): Promise<void> {
  try {
    await sweepStaleWorkspaces(getPool(), now);
  } catch (err) {
    console.error('[workspace] 낡은 공간 지우기 실패:', err instanceof Error ? err.message : err);
  }
}
