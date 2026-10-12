// 작업 공간(방문자 칸막이).
// 읽기만 해서는 아무것도 만들지 않는다. 첫 쓰기 때 만든다. 본보기(public) 공간에는 쓰지 못한다.
import { LIMITS, PUBLIC_WORKSPACE_ID, type WorkspaceKind } from '@/contract/api';
import { AppError } from './errors';
import type { Db } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 요청 헤더의 값을 공간 번호로 읽는다. 없으면 null, 꼴이 틀리면 BAD_INPUT. */
export function parseWorkspaceId(header: string | null | undefined): string | null {
  const value = header?.trim();
  if (!value) return null;
  if (!UUID.test(value)) throw new AppError('BAD_INPUT', '작업 공간 번호의 꼴이 틀렸습니다.');
  return value.toLowerCase();
}

/** 읽을 공간. 헤더가 없으면 본보기 공간을 본다. */
export function workspaceForRead(header: string | null | undefined): string {
  return parseWorkspaceId(header) ?? PUBLIC_WORKSPACE_ID;
}

/**
 * 쓸 공간을 정한다. 쓰기 트랜잭션의 맨 앞에서 부른다.
 * - 번호가 없으면 새 공간을 만든다.
 * - 모르는 번호(지워진 공간)면 받은 번호 그대로 다시 만든다. 같은 번호로 동시에 여러 건이 와도 한 공간에 모인다.
 * - 본보기 공간이면 READ_ONLY_WORKSPACE.
 * - 있던 공간이면 마지막 쓰기 시각을 고친다. 이때 공간 줄이 잠겨서 같은 공간의 쓰기가 한 줄로 선다.
 */
export async function workspaceForWrite(
  db: Db,
  workspaceId: string | null,
  now: Date,
  kindForNew: Exclude<WorkspaceKind, 'public'> = 'sandbox',
): Promise<{ id: string; created: boolean }> {
  if (workspaceId === PUBLIC_WORKSPACE_ID) throw readOnly();
  if (workspaceId) {
    const { rows } = await db.query<{ kind: WorkspaceKind }>(
      'UPDATE workspaces SET last_write_at = $2 WHERE id = $1 RETURNING kind',
      [workspaceId, now],
    );
    const row = rows[0];
    if (row?.kind === 'public') throw readOnly();
    if (row) return { id: workspaceId, created: false };
    // 먼저 온 요청이 같은 번호로 만들고 있으면 그 줄이 커밋될 때까지 기다렸다가 그 공간을 쓴다.
    const remade = await db.query<{ kind: WorkspaceKind; inserted: boolean }>(
      `INSERT INTO workspaces (id, kind, created_at, last_write_at) VALUES ($1, $2, $3, $3)
       ON CONFLICT (id) DO UPDATE SET last_write_at = EXCLUDED.last_write_at
       RETURNING kind, (xmax = 0) AS inserted`,
      [workspaceId, kindForNew, now],
    );
    const got = remade.rows[0];
    if (!got) throw new Error('작업 공간을 만들지 못했다');
    if (got.kind === 'public') throw readOnly();
    return { id: workspaceId, created: got.inserted };
  }
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO workspaces (kind, created_at, last_write_at) VALUES ($1, $2, $2) RETURNING id',
    [kindForNew, now],
  );
  const created = rows[0];
  if (!created) throw new Error('작업 공간을 만들지 못했다');
  return { id: created.id, created: true };
}

/**
 * 이미 있는 공간에 쓴다(검수 결정, 칸 고치기). 쓰기 트랜잭션의 맨 앞에서 부른다.
 * - 본보기 공간이면 READ_ONLY_WORKSPACE. 모르는 번호면 NOT_FOUND(새 공간을 만들지 않는다).
 * - 마지막 쓰기 시각을 고친다. 방금 승인한 공간이 낡은 공간으로 지워지지 않게 하고,
 *   공간 줄이 잠겨 같은 공간의 쓰기와 지우기가 한 줄로 선다.
 */
export async function touchWorkspaceForWrite(db: Db, workspaceId: string, now: Date): Promise<void> {
  if (workspaceId === PUBLIC_WORKSPACE_ID) throw readOnly();
  const { rows } = await db.query<{ kind: WorkspaceKind }>(
    'UPDATE workspaces SET last_write_at = GREATEST(last_write_at, $2) WHERE id = $1 RETURNING kind',
    [workspaceId, now],
  );
  const row = rows[0];
  if (!row) throw new AppError('NOT_FOUND', '초안이 없습니다.');
  if (row.kind === 'public') throw readOnly();
}

const readOnly = () => new AppError('READ_ONLY_WORKSPACE', '본보기 공간은 읽기 전용입니다.');

/** 본보기 공간을 만든다(있으면 그대로). 씨앗을 심을 때만 쓴다. */
export async function ensurePublicWorkspace(db: Db, now: Date): Promise<void> {
  await db.query(
    `INSERT INTO workspaces (id, kind, created_at, last_write_at) VALUES ($1, 'public', $2, $2) ON CONFLICT (id) DO NOTHING`,
    [PUBLIC_WORKSPACE_ID, now],
  );
}

/**
 * 오래 쓰기가 없던 방문자 공간을 묶어 지운다. 지운 수를 돌려준다.
 * 원문·초안·상품은 공간과 함께 지워진다(CASCADE). 작업 줄은 묶여 있지 않아 먼저 지운다.
 * 한 문장이라 한 트랜잭션이다. 다른 요청이 지우고 있는 공간은 건너뛴다.
 */
export async function sweepStaleWorkspaces(db: Db, now: Date, batch: number = LIMITS.workspaceSweepBatch): Promise<number> {
  const cutoff = new Date(now.getTime() - LIMITS.workspaceTtlDays * DAY_MS);
  const result = await db.query(
    `WITH stale AS (
       SELECT id FROM workspaces
        WHERE kind = 'sandbox' AND last_write_at < $1
        ORDER BY last_write_at
        FOR UPDATE SKIP LOCKED
        LIMIT $2),
     gone_jobs AS (
       DELETE FROM jobs j
        WHERE (j.kind = 'extract' AND j.ref_id IN (SELECT d.id FROM drafts d WHERE d.workspace_id IN (SELECT id FROM stale)))
           OR (j.kind = 'content' AND j.ref_id IN (SELECT p.id FROM products p WHERE p.workspace_id IN (SELECT id FROM stale))))
     DELETE FROM workspaces WHERE id IN (SELECT id FROM stale)`,
    [cutoff, batch],
  );
  return result.rowCount ?? 0;
}
