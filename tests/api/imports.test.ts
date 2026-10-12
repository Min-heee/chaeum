// 모으기의 경로 넷: 받기(202)와 요청 전체의 거절, 묶음 목록, 줄 목록, 줄 → 초안(201 → 200).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLIC_WORKSPACE_ID, type DraftDetailResponse } from '@/contract/api';
import {
  CollectedDraftResponseSchema,
  CollectedListResponseSchema,
  COLLECT_LIMITS,
  ImportListResponseSchema,
  ImportResponseSchema,
  type CollectedDraftResponse,
  type CollectedListResponse,
  type ImportListResponse,
  type ImportResponse,
} from '@/contract/tools/collect';
import { closePool, getPool } from '@/server/db';
import { ensurePublicWorkspace } from '@/server/workspace';
import { POST as draftRoute } from '../../app/api/collected/[id]/draft/route';
import { GET as collectedRoute } from '../../app/api/collected/route';
import { GET as draftDetailRoute } from '../../app/api/drafts/[id]/route';
import { GET as importsListRoute, POST as importsRoute } from '../../app/api/imports/route';
import { dropWorkspaces, newWorkspace, track } from '../integration/helpers';
import { call, resetToday } from './helpers';

const SOURCE = {
  id: 'sample-subway-2026', name: '가상 기관 지하철 광고 현황', url: 'https://example.org/data/subway.csv',
  license: '출처 표시 조건', fetchedAt: '2026-10-12T03:00:00+09:00',
};

let serial = 0;
const row = (over: Record<string, unknown> = {}) => {
  serial += 1;
  return {
    line: serial, kind: '지하철 광고', name: `가상 스크린도어 ${serial}`, subway_line: '6호선', station: '상수역',
    media_type: '스크린도어', width_m: 2, height_m: 1.5, quantity: 4, address: `서울 마포구 시험로 ${serial}`, raw: { 역명: '상수', 면수: 4 }, ...over,
  };
};

beforeAll(async () => {
  await resetToday();
  await ensurePublicWorkspace(getPool(), new Date('2001-06-01T03:00:00Z'));
});

afterAll(async () => {
  await dropWorkspaces();
  await closePool();
});

describe('POST /api/imports', () => {
  it('202 로 건별 결과와 묶음을 돌려준다. 공간 번호 없이 오면 새 공간 번호를 준다', async () => {
    const got = await call<ImportResponse>(importsRoute, 'POST', '/api/imports', { body: { source: SOURCE, rows: [row(), { line: 2, raw: {}, price: 1 }], collector: { unreadable: 1 } } });
    expect(got.status).toBe(202);
    track(got.body.workspace);
    expect(ImportResponseSchema.safeParse(got.body).success).toBe(true);
    expect(got.body.items.map((i) => i.result)).toEqual(['new', 'error']);
    expect(got.body.batch).toMatchObject({ received: 2, new: 1, duplicate: 0, unreadable: 1, collectorUnreadable: 1, collectorDuplicates: 0 });
    expect(got.response.headers.get('cache-control')).toBe('no-store');

    // 돌려받은 번호로 다시 보내면 같은 공간에 쌓인다.
    const again = await call<ImportResponse>(importsRoute, 'POST', '/api/imports', { ws: got.body.workspace, body: { source: SOURCE, rows: [row()] } });
    expect(again.body.workspace).toBe(got.body.workspace);
    const list = await call<ImportListResponse>(importsListRoute, 'GET', '/api/imports', { ws: got.body.workspace });
    expect(list.status).toBe(200);
    expect(ImportListResponseSchema.safeParse(list.body).success).toBe(true);
    expect(list.body.totals).toMatchObject({ sources: 1, received: 3, new: 2, items: 2, drafted: 0 });
  });

  it('요청 전체를 거절하는 경우: JSON 이 아님, 출처가 틀림, 줄이 0개이거나 500개 초과, 모르는 칸(400)', async () => {
    const ws = await newWorkspace();
    const bad = async (body: unknown) => (await call(importsRoute, 'POST', '/api/imports', { ws, body })).status;
    expect(await call(importsRoute, 'POST', '/api/imports', { ws, body: '{"source":' })).toMatchObject({ status: 400, body: { code: 'BAD_INPUT' } });
    expect(await bad({ rows: [row()] })).toBe(400);
    expect(await bad({ source: { ...SOURCE, id: 'Bad ID' }, rows: [row()] })).toBe(400);
    expect(await bad({ source: { ...SOURCE, license: '' }, rows: [row()] })).toBe(400);
    expect(await bad({ source: { ...SOURCE, fetchedAt: '2026-10-12' }, rows: [row()] })).toBe(400);
    expect(await bad({ source: { ...SOURCE, url: 'ftp://example.org/x' }, rows: [row()] })).toBe(400);
    expect(await bad({ source: SOURCE, rows: [] })).toBe(400);
    expect(await bad({ source: SOURCE, rows: Array.from({ length: COLLECT_LIMITS.rowsPerRequest + 1 }, () => ({ line: 1, raw: {} })) })).toBe(400);
    expect(await bad({ source: SOURCE, rows: [row()], extra: true })).toBe(400);
    const list = await call<ImportListResponse>(importsListRoute, 'GET', '/api/imports', { ws });
    expect(list.body.batches).toEqual([]);
  });

  it('표의 정수 칸보다 큰 줄 번호는 그 줄만 틀린 줄이다(500 이 아니다). 같이 보낸 맞는 줄은 들어간다', async () => {
    const ws = await newWorkspace();
    const good = row();
    const got = await call<ImportResponse>(importsRoute, 'POST', '/api/imports', { ws, body: { source: SOURCE, rows: [good, { ...row(), line: 3_000_000_000 }, { ...row(), line: 2_147_483_647 }] } });
    expect(got.status).toBe(202);
    expect(got.body.items.map((i) => i.result)).toEqual(['new', 'error', 'new']);
    expect(got.body.items[1]).toMatchObject({ result: 'error', code: 'BAD_ROW' });
    expect(got.body.batch).toMatchObject({ received: 3, new: 2, unreadable: 1 });
    const list = await call<ImportListResponse>(importsListRoute, 'GET', '/api/imports', { ws });
    expect(list.body.totals).toMatchObject({ items: 2 });
  });

  it('출처 칸의 제어 글자(NUL 등)와 터무니없이 큰 수집기 수는 400 이다(500 이 아니다)', async () => {
    const ws = await newWorkspace();
    const bad = async (body: unknown) => await call(importsRoute, 'POST', '/api/imports', { ws, body });
    for (const source of [{ ...SOURCE, name: 'a\u0000b' }, { ...SOURCE, license: '조건\u0000' + 'x' }, { ...SOURCE, url: 'https://example.org/a\u0000b' }, { ...SOURCE, name: '두\n줄' }]) {
      expect(await bad({ source, rows: [row()] })).toMatchObject({ status: 400, body: { code: 'BAD_INPUT' } });
    }
    expect(await bad({ source: SOURCE, rows: [row()], collector: { unreadable: 3_000_000_000 } })).toMatchObject({ status: 400, body: { code: 'BAD_INPUT' } });
    expect(await bad({ source: SOURCE, rows: [row()], collector: { duplicates: 3_000_000_000 } })).toMatchObject({ status: 400, body: { code: 'BAD_INPUT' } });
    expect((await bad({ source: SOURCE, rows: [row()], collector: { unreadable: 2_147_483_647, duplicates: 2_147_483_647 } })).status).toBe(202);
    const list = await call<ImportListResponse>(importsListRoute, 'GET', '/api/imports', { ws });
    expect(list.body.batches).toHaveLength(1);
  });

  it('500줄은 받는다. 본문이 3MB 를 넘으면 413, 본보기 공간은 403, 공간 번호의 꼴이 틀리면 400', async () => {
    const ws = await newWorkspace();
    const full = await call<ImportResponse>(importsRoute, 'POST', '/api/imports', { ws, body: { source: SOURCE, rows: Array.from({ length: COLLECT_LIMITS.rowsPerRequest }, () => row()) } });
    expect(full.status).toBe(202);
    expect(full.body.batch).toMatchObject({ received: 500, new: 500 });

    const big = JSON.stringify({ source: SOURCE, rows: [row()], pad: 'x'.repeat(COLLECT_LIMITS.requestMaxBytes) });
    expect(await call(importsRoute, 'POST', '/api/imports', { ws, body: big })).toMatchObject({ status: 413, body: { code: 'FILE_TOO_LARGE' } });
    expect(await call(importsRoute, 'POST', '/api/imports', { ws: PUBLIC_WORKSPACE_ID, body: { source: SOURCE, rows: [row()] } })).toMatchObject({ status: 403, body: { code: 'READ_ONLY_WORKSPACE' } });
    expect((await call(importsRoute, 'POST', '/api/imports', { ws: 'not-a-uuid', body: { source: SOURCE, rows: [row()] } })).status).toBe(400);
  });
});

describe('GET /api/imports · GET /api/collected', () => {
  it('헤더가 없으면 본보기 공간을 본다(읽기만 하고 아무것도 만들지 않는다)', async () => {
    const batches = await call<ImportListResponse>(importsListRoute, 'GET', '/api/imports');
    expect(batches.status).toBe(200);
    expect(ImportListResponseSchema.safeParse(batches.body).success).toBe(true);
    const items = await call<CollectedListResponse>(collectedRoute, 'GET', '/api/collected');
    expect(items.status).toBe(200);
    expect(CollectedListResponseSchema.safeParse(items.body).success).toBe(true);
  });

  it('거르는 값의 꼴이 틀리면 400 이다', async () => {
    const ws = await newWorkspace();
    await call(importsRoute, 'POST', '/api/imports', { ws, body: { source: SOURCE, rows: [row({ name: null })] } });
    const ok = await call<CollectedListResponse>(collectedRoute, 'GET', `/api/collected?sourceId=${SOURCE.id}&flag=no_name&drafted=no&q=${encodeURIComponent('상수')}`, { ws });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ total: 1, nextCursor: null });
    expect(ok.body.items[0]).toMatchObject({ sourceId: SOURCE.id, sourceName: SOURCE.name, flags: ['no_name'], station: '상수역', mediaType: '스크린도어', raw: { 역명: '상수', 면수: 4 } });
    for (const query of ['flag=nope', 'drafted=maybe', 'cursor=0', 'cursor=abc', 'sourceId=Bad%20ID']) {
      expect((await call(collectedRoute, 'GET', `/api/collected?${query}`, { ws })).status).toBe(400);
    }
  });
});

describe('POST /api/collected/:id/draft', () => {
  it('새 초안은 201, 같은 줄을 다시 보내면 200(duplicate). 만든 초안은 검수 화면이 읽는 꼴로 보인다', async () => {
    const ws = await newWorkspace();
    const sent = await call<ImportResponse>(importsRoute, 'POST', '/api/imports', { ws, body: { source: SOURCE, rows: [row()] } });
    const item = sent.body.items[0];
    if (item?.result !== 'new') throw new Error('줄이 들어가지 않았다');

    const made = await call<CollectedDraftResponse>(draftRoute, 'POST', `/api/collected/${item.itemId}/draft`, { ws, id: item.itemId });
    expect(made.status).toBe(201);
    expect(CollectedDraftResponseSchema.safeParse(made.body).success).toBe(true);
    expect(made.body).toMatchObject({ workspace: ws, itemId: item.itemId, status: 'NEEDS_REVIEW', duplicate: false });

    const again = await call<CollectedDraftResponse>(draftRoute, 'POST', `/api/collected/${item.itemId}/draft`, { ws, id: item.itemId });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ draftId: made.body.draftId, sourceDocId: made.body.sourceDocId, duplicate: true });

    const detail = await call<DraftDetailResponse>(draftDetailRoute, 'GET', `/api/drafts/${made.body.draftId}`, { ws, id: made.body.draftId });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ status: 'NEEDS_REVIEW', type: 'ad', subtype: '지하철', extractedBy: 'import' });
  });

  it('없는 줄·번호가 아닌 주소·남의 공간·헤더 없는 요청은 404, 본보기 공간은 403', async () => {
    const ws = await newWorkspace();
    const other = await newWorkspace();
    const sent = await call<ImportResponse>(importsRoute, 'POST', '/api/imports', { ws, body: { source: SOURCE, rows: [row()] } });
    const item = sent.body.items[0];
    if (item?.result !== 'new') throw new Error('줄이 들어가지 않았다');
    const post = (id: number | string, space: string | null) => call(draftRoute, 'POST', `/api/collected/${id}/draft`, { ws: space, id });
    expect(await post(999_999_999, ws)).toMatchObject({ status: 404, body: { code: 'NOT_FOUND', message: '모은 줄이 없습니다.' } });
    expect((await post('abc', ws)).status).toBe(404);
    expect((await post(item.itemId, other)).status).toBe(404);
    expect((await post(item.itemId, null)).status).toBe(404);
    expect(await post(item.itemId, PUBLIC_WORKSPACE_ID)).toMatchObject({ status: 403, body: { code: 'READ_ONLY_WORKSPACE' } });
  });
});
