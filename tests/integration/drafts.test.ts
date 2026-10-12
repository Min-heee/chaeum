// 초안의 상태: 이동 표 전체, 같은 version 으로 동시에 바꾸기, 변경 기록.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canTransition, DRAFT_STATUSES, REVIEWABLE_STATUSES } from '@/contract/transitions';
import { closePool, getPool, withTx } from '@/server/db';
import { addEditEvent, listCorrections, listEvents } from '@/server/repos/draft-events';
import { getDraft, listDrafts, listFields, reviseDraft, saveFields, transitionDraft } from '@/server/repos/drafts';
import { approveDraft, rejectDraft, reprocessDraft } from '@/server/review';
import { getJob } from '@/server/queue';
import { at, count, dropWorkspaces, field, GOODS_FIELDS, newWorkspace, rawDraft, reviewableDraft, T0 } from './helpers';

afterAll(async () => {
  await dropWorkspaces();
  await closePool();
});

describe('상태 이동 표', () => {
  const pairs = DRAFT_STATUSES.flatMap((from) => DRAFT_STATUSES.map((to) => [from, to] as const));

  it('표의 이동은 11개다', () => {
    expect(pairs.filter(([from, to]) => canTransition(from, to))).toHaveLength(11);
  });

  it.each(pairs)('%s → %s: 표에 있으면 바뀌고, 없으면 422 이고 아무것도 안 바뀐다', async (from, to) => {
    const ws = await newWorkspace();
    const draftId = await rawDraft(ws, from);
    const move = withTx((c) =>
      transitionDraft(c, {
        workspaceId: ws, draftId, to, expectedVersion: 1, actor: 'admin',
        patch: to === 'REJECTED' ? { rejectCode: 'WRONG_INFO' } : undefined, now: at(1000),
      }),
    );

    if (canTransition(from, to)) {
      await expect(move).resolves.toMatchObject({ status: to, version: 2 });
      expect(await listEvents(getPool(), draftId)).toEqual([expect.objectContaining({ action: 'status', from, to, actor: 'admin' })]);
    } else {
      await expect(move).rejects.toMatchObject({ code: 'BAD_TRANSITION' });
      expect(await getDraft(getPool(), ws, draftId)).toMatchObject({ status: from, version: 1 });
      expect(await listEvents(getPool(), draftId)).toEqual([]);
    }
  });

  it('없는 초안과 남의 공간의 초안은 404 다', async () => {
    const ws = await newWorkspace();
    const other = await newWorkspace();
    const draftId = await rawDraft(ws, 'READY');
    const move = (workspaceId: string, id: number) =>
      withTx((c) => transitionDraft(c, { workspaceId, draftId: id, to: 'APPROVED', expectedVersion: 1, actor: 'seller', now: T0 }));
    await expect(move(ws, 2_000_000_000)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(move(other, draftId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await getDraft(getPool(), ws, draftId)).toMatchObject({ status: 'READY', version: 1 });
  });

  it('낡은 version 은 표를 보기 전에 409 이고 지금 상태를 함께 돌려준다', async () => {
    const ws = await newWorkspace();
    const draftId = await rawDraft(ws, 'APPROVED');
    await expect(
      withTx((c) => transitionDraft(c, { workspaceId: ws, draftId, to: 'APPROVED', expectedVersion: 7, actor: 'seller', now: T0 })),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', current: { status: 'APPROVED', version: 1 } });
  });
});

describe('같은 version 으로 동시에', () => {
  it('승인 둘이 동시에 오면 하나만 되고 다른 하나는 409 다. 상품도 글 작업도 하나다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws, 'READY');
    const results = await Promise.allSettled([1, 2].map(() => approveDraft({ workspaceId: ws, draftId, version, now: at(2000) })));

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toMatchObject({ code: 'VERSION_CONFLICT', current: { status: 'APPROVED', version: version + 1 } });

    expect(await count('products WHERE draft_id = $1', [draftId])).toBe(1);
    const productId = (ok[0] as PromiseFulfilledResult<{ productId: number }>).value.productId;
    expect(await getJob(getPool(), 'content', productId)).toMatchObject({ status: 'queued' });
    expect(await count(`draft_events WHERE draft_id = $1 AND to_status = 'APPROVED'`, [draftId])).toBe(1);
  });

  it('승인과 반려가 동시에 오면 하나만 된다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws, 'NEEDS_REVIEW');
    const results = await Promise.allSettled([
      approveDraft({ workspaceId: ws, draftId, version, now: T0 }),
      rejectDraft({ workspaceId: ws, draftId, version, reasonCode: 'DUPLICATE', now: T0 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'VERSION_CONFLICT' } });

    const draft = await getDraft(getPool(), ws, draftId);
    expect(draft?.version).toBe(version + 1);
    expect(await count('products WHERE draft_id = $1', [draftId])).toBe(draft?.status === 'APPROVED' ? 1 : 0);
  });

  it('같은 version 으로 한 번 더 승인하면 409 다(차례로 와도)', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    await approveDraft({ workspaceId: ws, draftId, version, now: T0 });
    await expect(approveDraft({ workspaceId: ws, draftId, version, now: T0 })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT', current: { status: 'APPROVED', version: version + 1 },
    });
  });
});

describe('반려와 다시 돌리기', () => {
  it('반려에는 사유가 꼭 있어야 하고, 기록에 사유가 남는다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws, 'NEEDS_REVIEW');
    await expect(
      withTx((c) => transitionDraft(c, { workspaceId: ws, draftId, to: 'REJECTED', expectedVersion: version, actor: 'seller', now: T0 })),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });

    await rejectDraft({ workspaceId: ws, draftId, version, reasonCode: 'NOT_ENOUGH_INFO', memo: ' 값이 없음 ', now: T0 });
    expect(await getDraft(getPool(), ws, draftId)).toMatchObject({ status: 'REJECTED', rejectCode: 'NOT_ENOUGH_INFO', rejectMemo: '값이 없음' });
    expect((await listEvents(getPool(), draftId)).at(-1)).toMatchObject({ to: 'REJECTED', reasonCode: 'NOT_ENOUGH_INFO' });
  });

  it('반려된 초안을 다시 돌리면 처리 중이 되고, 끝난 작업이 처음부터 다시 줄에 선다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws, 'NEEDS_REVIEW');
    await getPool().query(`UPDATE jobs SET status = 'done', attempts = 2 WHERE kind = 'extract' AND ref_id = $1`, [draftId]);
    const rejected = await rejectDraft({ workspaceId: ws, draftId, version, reasonCode: 'OTHER', now: T0 });

    const again = await reprocessDraft({ workspaceId: ws, draftId, version: rejected.version, now: at(9000) });
    expect(again).toMatchObject({ status: 'PROCESSING', version: version + 2 });
    expect(await getDraft(getPool(), ws, draftId)).toMatchObject({ rejectCode: null, rejectMemo: null });
    expect(await getJob(getPool(), 'extract', draftId)).toMatchObject({ status: 'queued', attempts: 0, runAt: at(9000) });
  });

  it('승인된 초안은 다시 돌릴 수 없다(422)', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    const approved = await approveDraft({ workspaceId: ws, draftId, version, now: T0 });
    await expect(reprocessDraft({ workspaceId: ws, draftId, version: approved.version, now: T0 })).rejects.toMatchObject({ code: 'BAD_TRANSITION' });
  });
});

describe('칸과 변경 기록', () => {
  it('칸을 통째로 바꿔 쓴다. 값은 꼴 그대로 돌아오고, 목록에서 빠진 칸은 지워진다', async () => {
    const ws = await newWorkspace();
    const { draftId } = await reviewableDraft(ws);
    expect(await listFields(getPool(), draftId)).toEqual(GOODS_FIELDS);

    const next = [
      { ...field('name', '응원 부채'), reasons: ['NO_EVIDENCE' as const], evidence: '부채' },
      field('price_krw', 3000),
      field('size_mm', { width: 180, height: 180 }),
    ];
    await saveFields(getPool(), draftId, next);
    expect(await listFields(getPool(), draftId)).toEqual(next);
    expect((await listDrafts(getPool(), ws, { reason: 'NO_EVIDENCE' })).items).toEqual([
      expect.objectContaining({ id: draftId, name: '응원 부채', reasons: ['NO_EVIDENCE'] }),
    ]);
    expect((await listDrafts(getPool(), ws, { reason: 'PARSE_FAILED' })).items).toEqual([]);
  });

  it('상태는 그대로 두고 내용만 바꿔도 version 이 오른다. 낡은 version 은 409, 처리 중에는 422', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws, 'NEEDS_REVIEW');
    const revise = (v: number) =>
      withTx((c) => reviseDraft(c, { workspaceId: ws, draftId, expectedVersion: v, allowed: REVIEWABLE_STATUSES, patch: { reasons: ['LLM_SKIPPED'] }, now: T0 }));

    await expect(revise(version)).resolves.toMatchObject({ status: 'NEEDS_REVIEW', version: version + 1, reasons: ['LLM_SKIPPED'] });
    await expect(revise(version)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const processing = await rawDraft(ws, 'PROCESSING');
    await expect(
      withTx((c) => reviseDraft(c, { workspaceId: ws, draftId: processing, expectedVersion: 1, allowed: REVIEWABLE_STATUSES, now: T0 })),
    ).rejects.toMatchObject({ code: 'BAD_TRANSITION' });
  });

  it('사람이 고친 값은 기록에 남고, 그 줄이 정답 후보로 나온다', async () => {
    const ws = await newWorkspace();
    const { draftId } = await reviewableDraft(ws);
    await addEditEvent(getPool(), { draftId, actor: 'seller', field: 'price_krw', before: 5000, after: 5500, now: at(100) });
    await addEditEvent(getPool(), { draftId, actor: 'seller', field: 'material', before: '반사 원단', after: null, now: at(200) });

    expect(await listCorrections(getPool(), ws)).toEqual([
      expect.objectContaining({ draftId, field: 'price_krw', before: 5000, after: 5500, raw: '5000' }),
      expect.objectContaining({ draftId, field: 'material', before: '반사 원단', after: null }),
    ]);
  });

  it('상태 변경이 실패하면 같은 트랜잭션의 기록도 남지 않는다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    const before = await listEvents(getPool(), draftId);
    await expect(
      withTx(async (c) => {
        await transitionDraft(c, { workspaceId: ws, draftId, to: 'APPROVED', expectedVersion: version, actor: 'seller', now: T0 });
        throw new Error('뒤따르는 쓰기가 실패');
      }),
    ).rejects.toThrow('뒤따르는 쓰기가 실패');
    expect(await listEvents(getPool(), draftId)).toEqual(before);
    expect(await getDraft(getPool(), ws, draftId)).toMatchObject({ status: 'READY', version });
  });

  it('변경 기록을 고치거나 지우는 문장이 서버 코드에 없다', () => {
    const dir = path.resolve(process.cwd(), 'src/server');
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const sql = readFileSync(path.join(dir, file), 'utf8');
      expect(sql, file).not.toMatch(/UPDATE\s+draft_events|DELETE\s+FROM\s+draft_events|TRUNCATE[^;]*draft_events/i);
    }
  });
});
