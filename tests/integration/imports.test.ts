// 모으기(서버): 줄 묶음 받기(건별 결과, 중복은 한 건, 상한), 목록·거르기, 줄 → 초안(모델 없이 본체의 맞추기·따지기).
import { afterAll, describe, expect, it } from 'vitest';
import { LIMITS, PUBLIC_WORKSPACE_ID } from '@/contract/api';
import { COLLECT_LIMITS, ImportListResponseSchema, ImportResponseSchema, CollectedListResponseSchema, type ImportRequest } from '@/contract/tools/collect';
import { draftFromCollected, listCollected } from '@/server/collected';
import { closePool, getPool } from '@/server/db';
import { listImports, receiveImport } from '@/server/imports';
import { getDraftDetail } from '@/server/repos/drafts';
import { ensurePublicWorkspace } from '@/server/workspace';
import { at, count, dropWorkspaces, newWorkspace, rawDraft, track } from './helpers';

const SOURCE = {
  id: 'sample-outdoor-2026', name: '가상 기관 옥외광고 현황', url: 'https://example.org/data/outdoor.csv',
  license: '출처 표시 조건', fetchedAt: '2026-10-12T03:00:00Z',
};

let serial = 0;
/** 서로 다른 자리의 줄. */
const row = (over: Record<string, unknown> = {}) => {
  serial += 1;
  return {
    line: serial, kind: '전광판', name: `가상 전광판 ${serial}`, region: '서울 마포구', address: `서울 마포구 가상로 ${serial}`,
    subway_line: '2호선', station: '홍대입구역', media_type: 'LED 전광판', width_m: 7, height_m: 12, quantity: 1,
    raw: { 명칭: `가상 전광판 ${serial}`, 규격: '7m x 12m' }, ...over,
  };
};
const request = (rows: unknown[], over: Partial<ImportRequest> = {}): ImportRequest => ({ source: SOURCE, rows, ...over });

afterAll(async () => {
  await dropWorkspaces();
  await closePool();
});

describe('줄 묶음 받기', () => {
  it('줄마다 결과를 낸다. 한 줄이 틀려도 나머지는 들어가고, 묶음에 수가 남는다', async () => {
    const ws = await newWorkspace();
    const first = row();
    const got = await receiveImport(
      request([first, { ...first, line: 99, name: '같은 자리의 다른 이름' }, { ...row(), width_m: '7' }, row({ flags: ['unit_assumed'] })], { collector: { unreadable: 2, duplicates: 1 } }),
      { workspaceId: ws, now: at(0) },
    );
    expect(ImportResponseSchema.safeParse(got).success).toBe(true);
    expect(got.workspace).toBe(ws);
    expect(got.items.map((i) => i.result)).toEqual(['new', 'duplicate', 'error', 'new']);
    const [a, b, c] = got.items;
    expect(a).toMatchObject({ index: 0, line: first.line, result: 'new' });
    // 같은 요청의 앞줄과 같은 자리·같은 규격이면 중복이고, 있던 줄의 번호를 돌려준다.
    expect(b).toMatchObject({ index: 1, line: 99, result: 'duplicate', itemId: (a as { itemId: number }).itemId });
    expect(c).toMatchObject({ index: 2, result: 'error', code: 'BAD_ROW' });
    expect(got.batch).toMatchObject({
      source: { ...SOURCE, fetchedAt: '2026-10-12T03:00:00.000Z' },
      received: 4, new: 2, duplicate: 1, unreadable: 1, collectorUnreadable: 2, collectorDuplicates: 1, receivedAt: at(0).toISOString(),
    });
    expect(await count('collected_items WHERE workspace_id = $1', [ws])).toBe(2);

    const { items } = await listCollected(ws);
    expect(items.map((i) => i.flags)).toEqual([['unit_assumed'], []]);
    expect(items[1]).toMatchObject({ name: first.name, widthM: 7, heightM: 12, quantity: 1, lat: null, draftId: null, sourceName: SOURCE.name, raw: first.raw });
  });

  it('전에 받은 줄을 다시 보내면 중복이다. 출처가 달라도 같은 자리면 한 건이고, 다른 공간과는 섞이지 않는다', async () => {
    const ws = await newWorkspace();
    const other = await newWorkspace();
    const rows = [row(), row()];
    const first = await receiveImport(request(rows), { workspaceId: ws, now: at(0) });
    const again = await receiveImport(request(rows, { source: { ...SOURCE, id: 'another-source' } }), { workspaceId: ws, now: at(1000) });
    expect(again.items.map((i) => i.result)).toEqual(['duplicate', 'duplicate']);
    expect(again.items.map((i) => 'itemId' in i && i.itemId)).toEqual(first.items.map((i) => 'itemId' in i && i.itemId));
    expect(again.batch).toMatchObject({ received: 2, new: 0, duplicate: 2, unreadable: 0 });

    const elsewhere = await receiveImport(request(rows), { workspaceId: other, now: at(0) });
    expect(elsewhere.items.map((i) => i.result)).toEqual(['new', 'new']);
    expect(await count('collected_items WHERE workspace_id = $1', [ws])).toBe(2);
  });

  it('같은 줄들이 동시에 와도 열쇠마다 한 건만 들어간다', async () => {
    const ws = await newWorkspace();
    const rows = Array.from({ length: 20 }, () => row());
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => receiveImport(request(rows), { workspaceId: ws, now: at(i) })));
    expect(results.reduce((sum, r) => sum + r.batch.new, 0)).toBe(20);
    expect(results.reduce((sum, r) => sum + r.batch.duplicate, 0)).toBe(60);
    expect(await count('collected_items WHERE workspace_id = $1', [ws])).toBe(20);
    expect(await count('import_batches WHERE workspace_id = $1', [ws])).toBe(4);
  });

  it('공간 번호 없이 오면 새 공간을 만들어 돌려준다. 한 줄도 못 넣어도 묶음은 남는다', async () => {
    const got = await receiveImport(request([{ line: 1, raw: {} }]), { workspaceId: null, now: at(0) });
    track(got.workspace);
    expect(got.items).toEqual([expect.objectContaining({ index: 0, result: 'error', code: 'BAD_ROW' })]);
    expect(got.batch).toMatchObject({ received: 1, new: 0, duplicate: 0, unreadable: 1 });
    expect(await count('import_batches WHERE workspace_id = $1', [got.workspace])).toBe(1);
  });

  it('본보기 공간에는 쓰지 못한다. 받은 곳 주소가 http(s) 가 아니면 받지 않는다', async () => {
    await ensurePublicWorkspace(getPool(), at(0));
    const before = await count('import_batches WHERE workspace_id = $1', [PUBLIC_WORKSPACE_ID]);
    await expect(receiveImport(request([row()]), { workspaceId: PUBLIC_WORKSPACE_ID, now: at(0) })).rejects.toMatchObject({ code: 'READ_ONLY_WORKSPACE' });
    expect(await count('import_batches WHERE workspace_id = $1', [PUBLIC_WORKSPACE_ID])).toBe(before);

    const ws = await newWorkspace();
    await expect(
      receiveImport(request([row()], { source: { ...SOURCE, url: 'javascript:alert(1)' } }), { workspaceId: ws, now: at(0) }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(await count('import_batches WHERE workspace_id = $1', [ws])).toBe(0);
  });

  it('공간의 묶음 수 상한에 닿으면 요청 전체를 받지 않는다(429)', async () => {
    const ws = await newWorkspace();
    await getPool().query(
      `INSERT INTO import_batches (workspace_id, source_id, source_name, source_url, license, fetched_at)
       SELECT $1, 'filler', '채우기', 'https://example.org/x', '시험', now() FROM generate_series(1, $2)`,
      [ws, COLLECT_LIMITS.batchesPerWorkspace],
    );
    await expect(receiveImport(request([row()]), { workspaceId: ws, now: at(0) })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(await count('collected_items WHERE workspace_id = $1', [ws])).toBe(0);
  });

  it('공간의 줄 수 상한에 닿으면 새 줄만 빠진다. 이미 있는 줄은 중복으로 가른다', async () => {
    const ws = await newWorkspace();
    const kept = row();
    const first = await receiveImport(request([kept]), { workspaceId: ws, now: at(0) });
    await getPool().query(
      `INSERT INTO collected_items (workspace_id, batch_id, source_id, source_line, raw, dedupe_key)
       SELECT $1, $2, 'filler', n, '{}'::jsonb, 'filler|' || n FROM generate_series(1, $3) n`,
      [ws, first.batch.id, COLLECT_LIMITS.itemsPerWorkspace - 1],
    );
    const got = await receiveImport(request([kept, row()]), { workspaceId: ws, now: at(1000) });
    expect(got.items).toEqual([
      expect.objectContaining({ index: 0, result: 'duplicate' }),
      expect.objectContaining({ index: 1, result: 'error', code: 'LIMIT_EXCEEDED' }),
    ]);
    expect(got.batch).toMatchObject({ received: 2, new: 0, duplicate: 1, unreadable: 1 });
  });
});

describe('묶음 목록과 줄 목록', () => {
  it('묶음은 새것부터, 합계는 묶음의 수를 그대로 더한 것이다', async () => {
    const ws = await newWorkspace();
    const shared = row();
    await receiveImport(request([shared, row()], { collector: { unreadable: 3, duplicates: 0 } }), { workspaceId: ws, now: at(0) });
    await receiveImport(request([shared, row(), { line: 5, raw: {} }], { source: { ...SOURCE, id: 'second-source', name: '가상 기관 지하철 광고 현황' } }), { workspaceId: ws, now: at(1000) });

    const list = await listImports(ws);
    expect(ImportListResponseSchema.safeParse(list).success).toBe(true);
    expect(list.batches.map((b) => b.source.id)).toEqual(['second-source', SOURCE.id]);
    expect(list.totals).toEqual({ sources: 2, received: 5, new: 3, duplicate: 1, unreadable: 1, collectorUnreadable: 3, collectorDuplicates: 0, items: 3, drafted: 0 });
    expect((await listImports(await newWorkspace())).totals).toMatchObject({ sources: 0, received: 0, items: 0, drafted: 0 });
  });

  it('출처·표시·초안 여부·글자로 거른다. 찾는 글자의 % 와 _ 는 글자 그대로 본다', async () => {
    const ws = await newWorkspace();
    await receiveImport(request([row({ name: '합정역 100% 전광판', station: '합정역' }), row({ name: null }), row({ width_m: null })]), { workspaceId: ws, now: at(0) });
    await receiveImport(request([row({ address: '서울 성동구 가상길_7' })], { source: { ...SOURCE, id: 'second-source' } }), { workspaceId: ws, now: at(0) });

    const names = async (query: Parameters<typeof listCollected>[1]) => {
      const list = await listCollected(ws, query);
      expect(CollectedListResponseSchema.safeParse(list).success).toBe(true);
      expect(list.total).toBe(list.items.length);
      return list.items.length;
    };
    expect(await names({})).toBe(4);
    expect(await names({ sourceId: 'second-source' })).toBe(1);
    expect(await names({ flag: 'no_name' })).toBe(1);
    expect(await names({ flag: 'no_size' })).toBe(1);
    expect(await names({ flag: 'odd_size' })).toBe(0);
    expect(await names({ drafted: 'yes' })).toBe(0);
    expect(await names({ drafted: 'no' })).toBe(4);
    expect(await names({ q: '합정' })).toBe(1);
    expect(await names({ q: '100%' })).toBe(1);
    expect(await names({ q: '%' })).toBe(1);
    expect(await names({ q: '가상길_7' })).toBe(1);
    expect(await names({ q: '_' })).toBe(1);
  });

  it('한 쪽은 50건이고 다음 쪽 번호로 이어 읽는다', async () => {
    const ws = await newWorkspace();
    await receiveImport(request(Array.from({ length: 60 }, () => row())), { workspaceId: ws, now: at(0) });
    const first = await listCollected(ws);
    expect(first.items).toHaveLength(COLLECT_LIMITS.pageSize);
    expect(first.total).toBe(60);
    expect(first.nextCursor).toBe(first.items.at(-1)?.id);
    const second = await listCollected(ws, { cursor: first.nextCursor as number });
    expect(second.items).toHaveLength(10);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(60);
  });
});

describe('줄 → 초안', () => {
  async function oneItem(ws: string, over: Record<string, unknown> = {}): Promise<number> {
    const got = await receiveImport(request([row(over)]), { workspaceId: ws, now: at(0) });
    const item = got.items[0];
    if (item?.result !== 'new') throw new Error('줄이 들어가지 않았다');
    return item.itemId;
  }

  it('모델 없이 초안이 된다. 뽑은 방식은 import 이고 가격이 없어 "확인 필요"로 간다', async () => {
    const ws = await newWorkspace();
    const itemId = await oneItem(ws, { name: '합정역 전광판 A', station: '합정역', width_m: 7.5, height_m: 3 });
    const { body, created } = await draftFromCollected({ workspaceId: ws, itemId, now: at(1000) });
    expect(created).toBe(true);
    expect(body).toMatchObject({ workspace: ws, itemId, status: 'NEEDS_REVIEW', duplicate: false });

    const detail = await getDraftDetail(getPool(), ws, body.draftId);
    expect(detail?.draft).toMatchObject({ status: 'NEEDS_REVIEW', version: 2, type: 'ad', subtype: '전광판', extractedBy: 'import', reasons: [], model: null, llmSkipCause: null });
    expect(detail?.source.kind).toBe('import');
    expect(detail?.sourceText).toContain(`[모은 줄 #${itemId}] 출처 ${SOURCE.id}`);
    expect(detail?.sourceText).toContain('이름: 합정역 전광판 A');
    const of = (key: string) => detail?.fields.find((f) => f.field === key);
    expect(of('name')).toMatchObject({ raw: '합정역 전광판 A', finalValue: '합정역 전광판 A', modelValue: null, evidence: '이름: 합정역 전광판 A', reasons: [] });
    expect(of('region')).toMatchObject({ finalValue: '합정역', reasons: [] });
    expect(of('size_m')).toMatchObject({ finalValue: { width: 7.5, height: 3 }, reasons: [] });
    expect(of('price_krw')).toMatchObject({ finalValue: null, reasons: ['REQUIRED_MISSING'] });
    expect(detail?.events.map((e) => [e.from, e.to])).toEqual([[null, 'PROCESSING'], ['PROCESSING', 'NEEDS_REVIEW']]);
    // 집어 갈 뽑기 작업이 없다(모델을 부를 일이 없다).
    expect(await count(`jobs WHERE kind = 'extract' AND ref_id = $1`, [body.draftId])).toBe(0);

    expect((await listCollected(ws, { drafted: 'yes' })).items.map((i) => [i.id, i.draftId])).toEqual([[itemId, body.draftId]]);
    expect((await listImports(ws)).totals).toMatchObject({ items: 1, drafted: 1 });
  });

  it('전각 글자가 섞인 값도 저장된 원문과 글자까지 같아 근거 대조가 된다', async () => {
    const ws = await newWorkspace();
    const itemId = await oneItem(ws, { name: 'ＬＥＤ　전광판　Ｂ', station: '상수역' });
    const { body } = await draftFromCollected({ workspaceId: ws, itemId, now: at(1000) });
    const detail = await getDraftDetail(getPool(), ws, body.draftId);
    expect(detail?.fields.find((f) => f.field === 'name')).toMatchObject({ finalValue: 'LED 전광판 B', reasons: [] });
    expect(detail?.sourceText).toContain('이름: LED 전광판 B');
  });

  it('같은 줄을 두 번 보내면 한 건이다. 동시에 보내도 초안은 하나다', async () => {
    const ws = await newWorkspace();
    const itemId = await oneItem(ws);
    const results = await Promise.all(Array.from({ length: 3 }, () => draftFromCollected({ workspaceId: ws, itemId, now: at(1000) })));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.draftId)).size).toBe(1);
    const later = await draftFromCollected({ workspaceId: ws, itemId, now: at(2000) });
    expect(later).toMatchObject({ created: false, body: { duplicate: true, status: 'NEEDS_REVIEW', draftId: results[0]?.body.draftId, sourceDocId: results[0]?.body.sourceDocId } });
    expect(await count('drafts WHERE workspace_id = $1', [ws])).toBe(1);
  });

  it('없는 줄, 남의 공간의 줄, 공간 번호 없는 요청은 404 이고 본보기 공간은 403 이다', async () => {
    const ws = await newWorkspace();
    const other = await newWorkspace();
    const itemId = await oneItem(ws);
    await expect(draftFromCollected({ workspaceId: other, itemId, now: at(0) })).rejects.toMatchObject({ code: 'NOT_FOUND', message: '모은 줄이 없습니다.' });
    await expect(draftFromCollected({ workspaceId: ws, itemId: 999_999_999, now: at(0) })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(draftFromCollected({ workspaceId: null, itemId, now: at(0) })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(draftFromCollected({ workspaceId: '11111111-1111-4111-8111-111111111111', itemId, now: at(0) })).rejects.toMatchObject({ code: 'NOT_FOUND', message: '모은 줄이 없습니다.' });
    await ensurePublicWorkspace(getPool(), at(0));
    await expect(draftFromCollected({ workspaceId: PUBLIC_WORKSPACE_ID, itemId, now: at(0) })).rejects.toMatchObject({ code: 'READ_ONLY_WORKSPACE' });
    expect(await count('drafts WHERE workspace_id = ANY($1::uuid[])', [[ws, other]])).toBe(0);
  });

  it('공간의 초안 수 상한에 닿으면 만들지 않는다(429). 줄은 "아직 초안이 아님"으로 남는다', async () => {
    const ws = await newWorkspace();
    const itemId = await oneItem(ws);
    for (let i = 0; i < LIMITS.draftsPerWorkspace; i += 1) await rawDraft(ws, 'READY');
    await expect(draftFromCollected({ workspaceId: ws, itemId, now: at(0) })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect((await listCollected(ws)).items[0]?.draftId).toBeNull();
  });
});
