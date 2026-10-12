// 지키는 장치들: 본보기 공간 읽기 전용, 마지막 쓰기 시각, 공간 격리 조회, 동시 고치기, 공간이 어긋난 줄.
import { afterAll, describe, expect, it } from 'vitest';
import { PUBLIC_WORKSPACE_ID } from '@/contract/api';
import { closePool, getPool, withTx } from '@/server/db';
import { addEditEvent, listCorrections } from '@/server/repos/draft-events';
import { countByStatus, getDraft, reviseDraft } from '@/server/repos/drafts';
import { getProduct, listProducts } from '@/server/repos/products';
import { approveDraft, failDraftIfProcessing, rejectDraft, reprocessDraft } from '@/server/review';
import { ensurePublicWorkspace, sweepStaleWorkspaces, workspaceForWrite } from '@/server/workspace';
import { at, count, dropWorkspaces, newWorkspace, rawDraft, reviewableDraft, T0 } from './helpers';

const DAY = 24 * 3600_000;
const pool = () => getPool();

afterAll(async () => {
  await pool().query(`DELETE FROM source_docs WHERE workspace_id = $1 AND content_hash LIKE 'raw-%'`, [PUBLIC_WORKSPACE_ID]);
  await dropWorkspaces();
  await closePool();
});

describe('본보기 공간은 검수 결정도 받지 않는다', () => {
  it('승인·반려·다시 돌리기 모두 READ_ONLY_WORKSPACE 이고 상태가 그대로다', async () => {
    await ensurePublicWorkspace(pool(), T0);
    const ready = await rawDraft(PUBLIC_WORKSPACE_ID, 'READY');
    const rejected = await rawDraft(PUBLIC_WORKSPACE_ID, 'REJECTED');
    const base = { workspaceId: PUBLIC_WORKSPACE_ID, version: 1, now: T0 };
    const readOnly = { code: 'READ_ONLY_WORKSPACE' };

    await expect(approveDraft({ ...base, draftId: ready })).rejects.toMatchObject(readOnly);
    await expect(rejectDraft({ ...base, draftId: ready, reasonCode: 'WRONG_INFO' })).rejects.toMatchObject(readOnly);
    await expect(reprocessDraft({ ...base, draftId: rejected })).rejects.toMatchObject(readOnly);

    expect(await getDraft(pool(), PUBLIC_WORKSPACE_ID, ready)).toMatchObject({ status: 'READY', version: 1 });
    expect(await getDraft(pool(), PUBLIC_WORKSPACE_ID, rejected)).toMatchObject({ status: 'REJECTED', version: 1 });
    expect(await count('draft_events WHERE draft_id = ANY($1::bigint[])', [[ready, rejected]])).toBe(0);
    expect(await count('products WHERE workspace_id = $1 AND draft_id = $2', [PUBLIC_WORKSPACE_ID, ready])).toBe(0);
  });

  it('없는 공간 번호로 결정하면 404 이고 공간이 생기지 않는다', async () => {
    const nowhere = '99999999-2222-4333-8444-555555555555';
    await expect(rejectDraft({ workspaceId: nowhere, draftId: 1, version: 1, reasonCode: 'OTHER', now: T0 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await count('workspaces WHERE id = $1', [nowhere])).toBe(0);
  });
});

describe('검수 결정도 쓰기다', () => {
  const lastWrite = async (ws: string) =>
    (await pool().query<{ last_write_at: Date }>('SELECT last_write_at FROM workspaces WHERE id = $1', [ws])).rows[0]?.last_write_at.toISOString();
  const makeOld = (ws: string) => pool().query('UPDATE workspaces SET last_write_at = $2 WHERE id = $1', [ws, at(-3 * DAY)]);

  it('3일 전에 접수한 방문자 공간도 방금 승인했으면 지워지지 않는다', async () => {
    const ws = await newWorkspace('sandbox');
    const { draftId, version } = await reviewableDraft(ws);
    await makeOld(ws);

    const done = await approveDraft({ workspaceId: ws, draftId, version, now: at(-60_000) });
    expect(await lastWrite(ws)).toBe(at(-60_000).toISOString());

    await sweepStaleWorkspaces(pool(), T0);
    expect(await count('workspaces WHERE id = $1', [ws])).toBe(1);
    expect(await getProduct(pool(), ws, done.productId)).not.toBeNull();
  });

  it('반려와 다시 돌리기도 마지막 쓰기 시각을 올린다', async () => {
    const ws = await newWorkspace('sandbox');
    const { draftId, version } = await reviewableDraft(ws);
    await makeOld(ws);
    const rejected = await rejectDraft({ workspaceId: ws, draftId, version, reasonCode: 'OTHER', now: at(-2000) });
    expect(await lastWrite(ws)).toBe(at(-2000).toISOString());
    await reprocessDraft({ workspaceId: ws, draftId, version: rejected.version, now: at(-1000) });
    expect(await lastWrite(ws)).toBe(at(-1000).toISOString());
  });

  it('쓰는 중인 공간은 지우기가 기다리지 않고 건너뛴다', async () => {
    const ws = await newWorkspace('sandbox', at(-3 * DAY));
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await workspaceForWrite(client, ws, T0);
      // 잠금을 건너뛰지 않으면 여기서 위 트랜잭션이 끝나기를 기다리다 시험 시간이 다 간다.
      await sweepStaleWorkspaces(pool(), T0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await count('workspaces WHERE id = $1', [ws])).toBe(1);
  });
});

describe('공간 격리: 남의 공간 것은 목록과 숫자에 섞이지 않는다', () => {
  it('상품 목록, 고친 값 내려받기, 상태별 건수', async () => {
    const mine = await newWorkspace();
    const theirs = await newWorkspace();
    const a = await reviewableDraft(mine);
    const b = await reviewableDraft(theirs);
    await reviewableDraft(theirs, 'NEEDS_REVIEW');
    for (const d of [a, b]) {
      await withTx((c) => addEditEvent(c, { draftId: d.draftId, actor: 'seller', field: 'price_krw', before: 5000, after: 4000 + d.draftId, now: T0 }));
    }
    const pa = await approveDraft({ workspaceId: mine, draftId: a.draftId, version: a.version, now: T0 });
    const pb = await approveDraft({ workspaceId: theirs, draftId: b.draftId, version: b.version, now: T0 });

    expect((await listProducts(pool(), mine)).map((p) => p.id)).toEqual([pa.productId]);
    expect((await listProducts(pool(), theirs)).map((p) => p.id)).toEqual([pb.productId]);

    expect((await listCorrections(pool(), mine)).map((c) => [c.draftId, c.after])).toEqual([[a.draftId, 4000 + a.draftId]]);
    expect((await listCorrections(pool(), theirs)).map((c) => c.draftId)).toEqual([b.draftId]);

    const zero = { PROCESSING: 0, NEEDS_REVIEW: 0, READY: 0, FAILED: 0, APPROVED: 0, REJECTED: 0 };
    expect(await countByStatus(pool(), mine)).toEqual({ ...zero, APPROVED: 1 });
    expect(await countByStatus(pool(), theirs)).toEqual({ ...zero, APPROVED: 1, NEEDS_REVIEW: 1 });
  });
});

describe('동시에 고치기', () => {
  it('상태가 그대로인 고치기 둘이 같은 version 으로 오면 하나만 되고 다른 하나는 409 다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws, 'NEEDS_REVIEW');
    const revise = (subtype: string) =>
      withTx((c) => reviseDraft(c, { workspaceId: ws, draftId, expectedVersion: version, allowed: ['NEEDS_REVIEW'], patch: { subtype }, now: T0 }));
    const results = await Promise.allSettled([revise('인쇄물'), revise('잡화')]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect([ok.length, failed.length]).toEqual([1, 1]);
    expect(failed[0]?.reason).toMatchObject({ code: 'VERSION_CONFLICT', current: { status: 'NEEDS_REVIEW', version: version + 1 } });
    expect(await getDraft(pool(), ws, draftId)).toMatchObject({ version: version + 1 });
  });

  it('이미 따지기가 끝난 초안은 작업이 죽어도 처리 실패로 바뀌지 않는다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    expect(await withTx((c) => failDraftIfProcessing(c, draftId, T0))).toBe(false);
    expect(await getDraft(pool(), ws, draftId)).toMatchObject({ status: 'READY', version });
  });
});

describe('표가 막는 것', () => {
  const rejects = async (sql: string, params: unknown[]) => {
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await expect(client.query(sql, params)).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  };

  it('초안은 원문과, 상품은 초안과 같은 공간이어야 한다', async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    const { draftId } = await reviewableDraft(a);
    const doc = await pool().query<{ id: string }>(
      `INSERT INTO source_docs (workspace_id, clean_text, content_hash, created_at) VALUES ($1, '글', 'cross-1', $2) RETURNING id`,
      [a, T0],
    );
    await rejects('INSERT INTO drafts (workspace_id, source_doc_id) VALUES ($1, $2)', [b, doc.rows[0]?.id]);
    await rejects(
      `INSERT INTO products (workspace_id, draft_id, type, subtype, name, price_krw, spec) VALUES ($1, $2, 'goods', '인쇄물', '응원 슬로건', 5000, '{}')`,
      [b, draftId],
    );
  });

  it('변경 기록: 상태 줄에는 바뀐 상태가, 고침 줄에는 칸 이름이 있어야 한다', async () => {
    const ws = await newWorkspace();
    const draftId = await rawDraft(ws, 'READY');
    await rejects(`INSERT INTO draft_events (draft_id, actor, action) VALUES ($1, 'system', 'status')`, [draftId]);
    await rejects(`INSERT INTO draft_events (draft_id, actor, action) VALUES ($1, 'seller', 'edit')`, [draftId]);
  });

  it('정답 묶음은 넷이다. 실제 자료(real)를 받고 모르는 이름은 막는다', async () => {
    const insert = `INSERT INTO eval_runs (split, method, gold_version, git_commit) VALUES ($1, 'rules', 1, 'x')`;
    await rejects(insert, ['other']);
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await expect(client.query(insert, ['real'])).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
