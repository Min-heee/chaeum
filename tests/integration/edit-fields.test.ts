// 칸 고치기: 값을 고치면 맞추기·따지기가 다시 돌고 갈래가 바뀐다. 고친 값은 변경 기록(정답 후보)에 남는다.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, PatchFieldsRequestSchema, PatchFieldsResponseSchema, PUBLIC_WORKSPACE_ID } from '@/contract/api';
import { EDIT_LIMITS } from '@/contract/fields';
import { closePool, getPool } from '@/server/db';
import { editFields } from '@/server/edit-fields';
import { listCorrections, listEvents } from '@/server/repos/draft-events';
import { getDraft, listFields } from '@/server/repos/drafts';
import { approveDraft, rejectDraft, reprocessDraft } from '@/server/review';
import { patchFields } from '@/server/service';
import { ensurePublicWorkspace } from '@/server/workspace';
import { at, count, dropWorkspaces, field, newWorkspace, reviewableDraft } from './helpers';
import { fakeRouter, goodsText, handlersFor, processed, router } from './pipeline-helpers';

const pool = () => getPool();
const llm = () => handlersFor({ router: fakeRouter() });

beforeEach(async () => {
  await pool().query('TRUNCATE jobs RESTART IDENTITY');
});

afterAll(async () => {
  await dropWorkspaces();
  await closePool();
});

describe('칸 고치기', () => {
  it('빈 필수 칸을 채우면 "바로 승인 가능"이 되고, 말이 안 되는 값으로 고치면 다시 "확인 필요"가 된다', async () => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText(false).text, llm());
    expect(draft).toMatchObject({ status: 'NEEDS_REVIEW', version: 2 });

    const fixed = await patchFields({ workspaceId: ws, draftId: draft.id, version: 2, edits: { size_mm: { width: 200, height: 600 } }, actor: 'seller', now: at(1000) });
    expect(() => PatchFieldsResponseSchema.parse(fixed)).not.toThrow();
    expect(fixed).toMatchObject({ status: 'READY', version: 3 });
    expect(fixed.fields.find((f) => f.field === 'size_mm')).toMatchObject({ finalValue: { width: 200, height: 600 }, editedByHuman: true, reasons: [] });
    // 변경 기록: 고친 값 한 줄 + 상태가 바뀐 한 줄.
    expect(fixed.events.slice(-2)).toMatchObject([
      { actor: 'seller', action: 'edit', field: 'size_mm', before: null, after: { width: 200, height: 600 } },
      { actor: 'seller', action: 'status', from: 'NEEDS_REVIEW', to: 'READY' },
    ]);

    const broken = await patchFields({ workspaceId: ws, draftId: draft.id, version: 3, edits: { price_krw: 0 }, now: at(2000) });
    expect(broken).toMatchObject({ status: 'NEEDS_REVIEW', version: 4 });
    expect(broken.fields.find((f) => f.field === 'price_krw')).toMatchObject({ finalValue: 0, editedByHuman: true, reasons: ['OUT_OF_RANGE'] });
    // 전에 고친 칸은 고친 값 그대로다.
    expect(broken.fields.find((f) => f.field === 'size_mm')).toMatchObject({ finalValue: { width: 200, height: 600 }, editedByHuman: true });

    // 사람이 고친 값이 정답 후보로 쌓인다.
    expect((await listCorrections(pool(), ws)).map((c) => [c.field, c.before, c.after, c.raw])).toEqual([
      ['size_mm', null, { width: 200, height: 600 }, null],
      ['price_krw', 5000, 0, '5,000원'],
    ]);
  });

  it('갈래가 그대로면 상태는 그대로이고 version 만 오른다. 같은 값으로 고치면 고침 기록을 남기지 않는다', async () => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText().text, llm());
    expect(draft.status).toBe('READY');
    const after = await editFields({ workspaceId: ws, draftId: draft.id, version: 2, edits: { material: '반사 원단', price_krw: 5000 }, now: at(1000) });
    expect(after).toMatchObject({ status: 'READY', version: 3 });
    const events = await listEvents(pool(), draft.id);
    expect(events.filter((e) => e.action === 'edit').map((e) => [e.actor, e.field])).toEqual([['admin', 'material']]);
    expect(events.filter((e) => e.action === 'status')).toHaveLength(2);
  });

  it('값을 비우면(null) 필수 칸 사유가 붙는다', async () => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText().text, llm());
    const after = await patchFields({ workspaceId: ws, draftId: draft.id, version: 2, edits: { name: null }, now: at(1000) });
    expect(after.status).toBe('NEEDS_REVIEW');
    expect(after.fields.find((f) => f.field === 'name')).toMatchObject({ finalValue: null, reasons: ['REQUIRED_MISSING'] });
  });

  it('"바로 승인 가능"인 초안의 이름을 한 글자로 고치면 "확인 필요"로 가고 그 칸에 사유가 붙는다(승인에서야 막히지 않는다)', async () => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText().text, llm());
    expect(draft.status).toBe('READY');
    const after = await patchFields({ workspaceId: ws, draftId: draft.id, version: 2, edits: { name: '가' }, now: at(1000) });
    expect(after.status).toBe('NEEDS_REVIEW');
    expect(after.fields.find((f) => f.field === 'name')?.reasons).toEqual(['OUT_OF_RANGE']);
    // 그래도 승인하면 등록은 막힌다(422). 초안에는 까닭이 이미 붙어 있다.
    await expect(approveDraft({ workspaceId: ws, draftId: draft.id, version: after.version, now: at(2000) })).rejects.toMatchObject({ code: 'PRODUCT_INVALID' });
    const back = await patchFields({ workspaceId: ws, draftId: draft.id, version: after.version, edits: { name: '키링' }, now: at(3000) });
    expect(back.status).toBe('READY');
  });

  it('규칙만으로 뽑은 초안은 값을 다 고쳐도 "규칙만으로 뽑음" 표시가 남는다', async () => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText().text, handlersFor({ router: router({}) }));
    const fields = await listFields(pool(), draft.id);
    const edits = { name: '별빛 응원 슬로건', price_krw: 5000, size_mm: { width: 200, height: 600 } };
    const after = await patchFields({ workspaceId: ws, draftId: draft.id, version: draft.version, edits, now: at(1000) });
    expect(fields.length).toBeGreaterThan(0);
    expect(after.reasons).toContain('LLM_SKIPPED');
    expect(after.status).toBe('NEEDS_REVIEW');
    expect(after.llm.skipCause).toBe('no_key');
  });

  it('종류를 "등록 대상 아님"으로 고치면 칸이 없어지고 사유가 붙는다. 다시 굿즈로 고치면 칸이 돌아온다', async () => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText().text, llm());
    const none = await patchFields({ workspaceId: ws, draftId: draft.id, version: 2, type: 'not_product', now: at(1000) });
    expect(none).toMatchObject({ status: 'NEEDS_REVIEW', type: 'not_product', subtype: null, fields: [], reasons: ['NOT_A_PRODUCT'] });
    expect(none.events.filter((e) => e.action === 'edit').map((e) => [e.field, e.before, e.after])).toEqual([
      ['type', 'goods', 'not_product'],
      ['subtype', '인쇄물', null],
    ]);

    const back = await patchFields({ workspaceId: ws, draftId: draft.id, version: 3, type: 'goods', subtype: '잡화', edits: { name: '키링', price_krw: 2300, size_mm: { width: 50, height: 50 } }, now: at(2000) });
    expect(back).toMatchObject({ status: 'READY', type: 'goods', subtype: '잡화', reasons: [] });
    expect(back.fields).toHaveLength(8);
  });

  it('갈래가 그 종류의 목록에 없으면 사유가 붙는다', async () => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText().text, llm());
    const after = await patchFields({ workspaceId: ws, draftId: draft.id, version: 2, subtype: '전광판', now: at(1000) });
    expect(after).toMatchObject({ status: 'NEEDS_REVIEW', subtype: '전광판' });
    expect(after.reasons).toContain('TYPE_SUBTYPE_MISMATCH');
  });
});

describe('막는 것', () => {
  it('낡은 version 은 409 이고 지금 상태가 함께 온다. 아무것도 바뀌지 않는다', async () => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText().text, llm());
    await editFields({ workspaceId: ws, draftId: draft.id, version: 2, edits: { material: '원단' }, now: at(1000) });
    const stale = editFields({ workspaceId: ws, draftId: draft.id, version: 2, edits: { material: '종이' }, now: at(2000) });
    await expect(stale).rejects.toMatchObject({ code: 'VERSION_CONFLICT', current: { status: 'READY', version: 3 } });
    expect((await listFields(pool(), draft.id)).find((f) => f.field === 'material')?.finalValue).toBe('원단');
    expect(await count(`draft_events WHERE draft_id = $1 AND action = 'edit'`, [draft.id])).toBe(1);
  });

  it('모르는 칸, 그 종류에 없는 칸, 꼴이 다른 값, 빈 요청은 400 이다', async () => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText().text, llm());
    const base = { workspaceId: ws, draftId: draft.id, version: 2, now: at(1000) };
    await expect(editFields({ ...base, edits: { nope: 1 } })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(editFields({ ...base, edits: { hours: { open: '05:00', close: '01:00', nextDay: true } } })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(editFields({ ...base, edits: { price_krw: '5천원' } })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(editFields({ ...base, edits: { size_mm: { width: 200 } } })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(editFields({ ...base, edits: {} })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect((await getDraft(pool(), ws, draft.id))?.version).toBe(2);
  });

  it('너무 긴 값은 400 이고 아무것도 쌓이지 않는다(글자 칸 200자, 갈래 60자, 목록 30개)', async () => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText().text, llm());
    const base = { workspaceId: ws, draftId: draft.id, version: 2, now: at(1000) };
    const before = await count('draft_events WHERE draft_id = $1', [draft.id]);

    await expect(editFields({ ...base, edits: { name: '가'.repeat(EDIT_LIMITS.textMaxChars + 1) } })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(editFields({ ...base, edits: { material: '가'.repeat(330_000) } })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(editFields({ ...base, subtype: '가'.repeat(EDIT_LIMITS.subtypeMaxChars + 1) })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(PatchFieldsRequestSchema.safeParse({ version: 2, subtype: '가'.repeat(EDIT_LIMITS.subtypeMaxChars + 1) }).success).toBe(false);
    expect(await count('draft_events WHERE draft_id = $1', [draft.id])).toBe(before);
    expect((await getDraft(pool(), ws, draft.id))?.version).toBe(2);

    // 상한에 딱 맞는 값은 들어간다.
    const ok = await editFields({ ...base, edits: { name: '가'.repeat(EDIT_LIMITS.textMaxChars) }, subtype: '나'.repeat(EDIT_LIMITS.subtypeMaxChars) });
    expect(ok.version).toBe(3);
  });

  it('목록 칸은 30개까지다', async () => {
    const ws = await newWorkspace();
    const doc = await reviewableDraft(ws, 'NEEDS_REVIEW', [field('name', '합정역 전광판'), field('price_krw', 100000)], 'ad', '전광판');
    const options = (n: number) => Array.from({ length: n }, (_, i) => ({ days: i + 1, price_krw: 1000 * (i + 1) }));
    const base = { workspaceId: ws, draftId: doc.draftId, version: doc.version, now: at(1000) };
    await expect(editFields({ ...base, edits: { period_options: options(EDIT_LIMITS.listMaxItems + 1) } })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(editFields({ ...base, edits: { file_format: ['j'.repeat(EDIT_LIMITS.formatMaxChars + 1)] } })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(editFields({ ...base, edits: { period_options: options(EDIT_LIMITS.listMaxItems) } })).resolves.toMatchObject({ version: doc.version + 1 });
  });

  it('글자 칸의 제어 글자(NUL, 탭, 줄바꿈)는 빈칸으로 바뀌어 들어간다. 500 이 나지 않는다', async () => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText().text, llm());
    const after = await patchFields({
      workspaceId: ws, draftId: draft.id, version: 2, edits: { name: 'a\u0000b', material: "\t=cmd|' /C calc'!A0\r\n" }, subtype: ' 잡\u0000화 ', now: at(1000),
    });
    expect(after.fields.find((f) => f.field === 'name')?.finalValue).toBe('a b');
    expect(after.fields.find((f) => f.field === 'material')?.finalValue).toBe("=cmd|' /C calc'!A0");
    expect(after.subtype).toBe('잡 화');
    // 정리하고 나니 빈 글자면 꼴이 틀린 것이다.
    await expect(editFields({ workspaceId: ws, draftId: draft.id, version: 3, edits: { name: '\u0000\t ' }, now: at(2000) })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    // 짝 없는 대리 글자도 DB 까지 가서 터지지 않는다.
    await expect(editFields({ workspaceId: ws, draftId: draft.id, version: 3, edits: { name: '별\ud800빛' }, now: at(2000) })).resolves.toMatchObject({ version: 4 });
  });

  it('변경 기록이 200줄에 닿은 초안은 더 고치거나 다시 돌릴 수 없다(429). 반려와 승인은 된다', async () => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText().text, llm());
    const have = await count('draft_events WHERE draft_id = $1', [draft.id]);
    await pool().query(
      `INSERT INTO draft_events (draft_id, actor, action, field, before, after, created_at)
       SELECT $1, 'admin', 'edit', 'material', '"가"'::jsonb, '"나"'::jsonb, $3 FROM generate_series(1, $2::int)`,
      [draft.id, LIMITS.eventsPerDraft - have - 1, at(500)],
    );
    // 199줄: 한 번은 더 고칠 수 있다.
    const last = await editFields({ workspaceId: ws, draftId: draft.id, version: 2, edits: { material: '종이' }, now: at(1000) });
    const full = editFields({ workspaceId: ws, draftId: draft.id, version: last.version, edits: { material: '원단' }, now: at(2000) });
    await expect(full).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect((await listFields(pool(), draft.id)).find((f) => f.field === 'material')?.finalValue).toBe('종이');

    const rejected = await rejectDraft({ workspaceId: ws, draftId: draft.id, version: last.version, reasonCode: 'OTHER', now: at(3000) });
    const again = reprocessDraft({ workspaceId: ws, draftId: draft.id, version: rejected.version, now: at(4000) });
    await expect(again).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    // 막힌 다시 돌리기는 아무것도 바꾸지 않는다.
    expect(await getDraft(pool(), ws, draft.id)).toMatchObject({ status: 'REJECTED', version: rejected.version });
    expect(await count('draft_events WHERE draft_id = $1', [draft.id])).toBe(LIMITS.eventsPerDraft + 1);
  });

  it('반려 메모의 NUL 글자는 빠지고, 500자에서 잘린다', async () => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText().text, llm());
    await rejectDraft({ workspaceId: ws, draftId: draft.id, version: 2, reasonCode: 'OTHER', memo: ` a\u0000b\n${'가'.repeat(600)}`, now: at(1000) });
    const memo = (await getDraft(pool(), ws, draft.id))?.rejectMemo ?? '';
    expect(memo.startsWith('a b\n가')).toBe(true);
    expect([...memo]).toHaveLength(LIMITS.rejectMemoMaxChars);
  });

  it('승인된 초안과 처리 중인 초안은 고칠 수 없다(422)', async () => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText().text, llm());
    const approved = await approveDraft({ workspaceId: ws, draftId: draft.id, version: 2, now: at(1000) });
    const tried = editFields({ workspaceId: ws, draftId: draft.id, version: approved.version, edits: { material: '종이' }, now: at(2000) });
    await expect(tried).rejects.toMatchObject({ code: 'BAD_TRANSITION' });
  });

  it('남의 공간 번호로는 고칠 수 없다. 본보기 공간은 읽기 전용이다', async () => {
    const mine = await newWorkspace();
    const theirs = await newWorkspace();
    const draft = await processed(mine, goodsText().text, llm());
    const edit = { draftId: draft.id, version: 2, edits: { price_krw: 1 }, now: at(1000) };
    await expect(editFields({ ...edit, workspaceId: theirs })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(editFields({ ...edit, workspaceId: '11111111-1111-4111-8111-111111111111' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await ensurePublicWorkspace(pool(), at(0));
    await expect(editFields({ ...edit, workspaceId: PUBLIC_WORKSPACE_ID })).rejects.toMatchObject({ code: 'READ_ONLY_WORKSPACE' });
    expect((await listFields(pool(), draft.id)).find((f) => f.field === 'price_krw')?.finalValue).toBe(5000);
    expect(await getDraft(pool(), mine, draft.id)).toMatchObject({ version: 2 });
  });
});
