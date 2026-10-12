// API 한 바퀴와 오류 번호. 경로 함수를 직접 불러 시험용 DB 로 돈다.
// 방식을 녹화 재생으로 묶어 둔다. 녹화가 없는 글이라 "규칙만" 길로 가고, 모델은 한 번도 부르지 않는다.
// 키도 여기서 정해 둔다(가짜 값). 내 컴퓨터에 키가 있든 없든 같은 길(cache_miss)로 가야 한다. 키가 없을 때는 no-key.test.ts 가 본다.
process.env.LLM_PROVIDER = 'replay';
process.env.ANTHROPIC_API_KEY = 'not-a-real-key';
process.env.LIVE_LLM_DAILY_CAP = '0';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiErrorBodySchema,
  BulkIntakeResponseSchema,
  ConflictBodySchema,
  DecisionResponseSchema,
  DraftDetailResponseSchema,
  DraftListResponseSchema,
  DrainResponseSchema,
  IntakeResponseSchema,
  kstDay,
  LIMITS,
  ProductDetailResponseSchema,
  ProductListResponseSchema,
  PUBLIC_WORKSPACE_ID,
  type DecisionResponse,
  type DraftDetailResponse,
  type DraftListResponse,
  type IntakeResponse,
} from '@/contract/api';
import { closePool, getPool } from '@/server/db';
import { ensurePublicWorkspace } from '@/server/workspace';
import { POST as approve } from '../../app/api/drafts/[id]/approve/route';
import { PATCH as patchFields } from '../../app/api/drafts/[id]/fields/route';
import { POST as reject } from '../../app/api/drafts/[id]/reject/route';
import { POST as reprocess } from '../../app/api/drafts/[id]/reprocess/route';
import { GET as draftDetail } from '../../app/api/drafts/[id]/route';
import { GET as draftList } from '../../app/api/drafts/route';
import { GET as exportCsv } from '../../app/api/export.csv/route';
import { POST as drain } from '../../app/api/jobs/drain/route';
import { GET as productDetail } from '../../app/api/products/[id]/route';
import { GET as productList } from '../../app/api/products/route';
import { POST as intakeBulk } from '../../app/api/source-docs/bulk/route';
import { POST as intake } from '../../app/api/source-docs/route';
import { POST as upload } from '../../app/api/source-files/route';
import { route } from '../../app/api/_lib/http';
import { at, count, dropWorkspaces, newWorkspace, rawDraft, reviewableDraft, track } from '../integration/helpers';
import { call, fileForm, pngBytes, resetToday } from './helpers';

const pool = () => getPool();
let serial = 0;

/** 규칙만으로도 값·크기·수량이 뽑히는 굿즈 글. 이름은 규칙이 못 뽑아 사람이 채워야 한다. */
function goods(): string {
  serial += 1;
  return `달무리 응원 슬로건 ${serial}호 판매합니다.\n가격은 5,000원입니다.\n크기는 200x600mm 입니다.\n최소 주문 10장, 부가세 포함`;
}

/** 접수하고 줄을 굴려 뽑기까지 끝낸 초안. 공간을 안 주면 새 공간이 생긴다. */
async function received(ws?: string): Promise<{ ws: string; draftId: number }> {
  const got = await call<IntakeResponse>(intake, 'POST', '/api/source-docs', { ws, body: { text: goods() } });
  expect(got.status).toBe(201);
  track(got.body.workspace);
  await call(drain, 'POST', '/api/jobs/drain');
  return { ws: got.body.workspace, draftId: got.body.draftId };
}

const workspaces = () => count('workspaces');

beforeAll(async () => {
  await resetToday();
});

beforeEach(async () => {
  await pool().query('TRUNCATE jobs RESTART IDENTITY');
});

afterAll(async () => {
  await dropWorkspaces();
  await resetToday();
  await closePool();
});

describe('한 바퀴', () => {
  it('접수 → 줄 굴리기 → 조회 → 고침 → 승인 → 상품 → 내려받기', async () => {
    // 접수: 헤더가 없으니 새 공간이 생겨 돌아온다.
    const text = goods();
    const got = await call<IntakeResponse>(intake, 'POST', '/api/source-docs', { body: { text } });
    expect(got.status).toBe(201);
    expect(IntakeResponseSchema.parse(got.body)).toMatchObject({ status: 'PROCESSING', duplicate: false });
    const ws = track(got.body.workspace);
    const draftId = got.body.draftId;

    // 같은 글을 다시 넣으면 200 이고 같은 초안이다.
    const again = await call<IntakeResponse>(intake, 'POST', '/api/source-docs', { ws, body: { text } });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, draftId, workspace: ws });

    // 줄 굴리기
    const drained = await call(drain, 'POST', '/api/jobs/drain');
    expect(drained.status).toBe(200);
    expect(DrainResponseSchema.parse(drained.body)).toMatchObject({ done: 1, remaining: 0 });

    // 조회: 검수함과 상세
    const list = await call<DraftListResponse>(draftList, 'GET', '/api/drafts?status=NEEDS_REVIEW', { ws });
    expect(list.status).toBe(200);
    expect(DraftListResponseSchema.parse(list.body).items.map((d) => d.id)).toEqual([draftId]);
    expect(list.body.counts.NEEDS_REVIEW).toBe(1);

    const detail = await call<DraftDetailResponse>(draftDetail, 'GET', `/api/drafts/${draftId}`, { ws, id: draftId });
    expect(detail.status).toBe(200);
    const before = DraftDetailResponseSchema.parse(detail.body);
    expect(before).toMatchObject({ status: 'NEEDS_REVIEW', type: 'goods', extractedBy: 'rules', llm: { recorded: false, live: false, skipCause: 'cache_miss' } });
    expect(before.reasons).toContain('LLM_SKIPPED');
    expect(before.fields.find((f) => f.field === 'name')?.reasons).toContain('REQUIRED_MISSING');
    expect(before.fields.find((f) => f.field === 'price_krw')?.finalValue).toBe(5000);

    // 고침: 빈 이름을 사람이 채운다.
    const patched = await call<DraftDetailResponse>(patchFields, 'PATCH', `/api/drafts/${draftId}/fields`, {
      ws, id: draftId, body: { version: before.version, edits: { name: '달무리 응원 슬로건' }, actor: 'seller' },
    });
    expect(patched.status).toBe(200);
    const after = DraftDetailResponseSchema.parse(patched.body);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.fields.find((f) => f.field === 'name')).toMatchObject({ finalValue: '달무리 응원 슬로건', editedByHuman: true, reasons: [] });
    expect(after.events.some((e) => e.action === 'edit' && e.field === 'name' && e.actor === 'seller')).toBe(true);

    // 승인: 상품이 생긴다.
    const approved = await call<DecisionResponse>(approve, 'POST', `/api/drafts/${draftId}/approve`, { ws, id: draftId, body: { version: after.version } });
    expect(approved.status).toBe(200);
    expect(DecisionResponseSchema.parse(approved.body)).toMatchObject({ id: draftId, status: 'APPROVED' });
    const productId = approved.body.productId as number;
    expect(productId).toBeGreaterThan(0);

    // 글 작업이 줄에 서 있다. 굴리면 두 언어 글 넷이 붙는다(모델이 없어 틀 문장이다).
    const second = await call(drain, 'POST', '/api/jobs/drain');
    expect(second.body).toMatchObject({ done: 1, remaining: 0 });

    const products = await call(productList, 'GET', '/api/products', { ws });
    expect(ProductListResponseSchema.parse(products.body).items).toMatchObject([{ id: productId, draftId, name: '달무리 응원 슬로건', price_krw: 5000 }]);

    const product = await call(productDetail, 'GET', `/api/products/${productId}`, { ws, id: productId });
    expect(product.status).toBe(200);
    const texts = ProductDetailResponseSchema.parse(product.body).texts;
    expect(texts).toHaveLength(4);
    expect(texts.every((t) => t.source === 'template')).toBe(true);

    const linked = await call<DraftDetailResponse>(draftDetail, 'GET', `/api/drafts/${draftId}`, { ws, id: draftId });
    expect(linked.body).toMatchObject({ status: 'APPROVED', productId });

    // 내려받기: 양식 꼴과 사람이 고친 값
    const csv = await call<string>(exportCsv, 'GET', '/api/export.csv', { ws });
    expect(csv.status).toBe(200);
    expect(csv.response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(csv.response.headers.get('content-disposition')).toMatch(/^attachment; filename="[a-z0-9.-]+\.csv"$/);
    const bytes = new Uint8Array(await csv.response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv.body).toContain('달무리 응원 슬로건');
    expect(csv.body.trim().split('\n')).toHaveLength(2);

    const other = await call<string>(exportCsv, 'GET', '/api/export.csv?template=ad-board', { ws });
    expect(other.status).toBe(200);
    expect(other.body.split('\n')[0]).not.toBe(csv.body.split('\n')[0]);

    const corrections = await call<string>(exportCsv, 'GET', '/api/export.csv?kind=corrections', { ws });
    expect(corrections.status).toBe(200);
    expect(corrections.body).toContain('draft_id,source_doc_id,field,raw,before,after,edited_at');
    expect(corrections.body).toContain('달무리 응원 슬로건');
  });

  it('반려한 초안은 다시 돌릴 수 있다', async () => {
    const { ws, draftId } = await received();
    const rejected = await call<DecisionResponse>(reject, 'POST', `/api/drafts/${draftId}/reject`, {
      ws, id: draftId, body: { version: 2, reasonCode: 'OTHER', memo: '값을 다시 물어본다' },
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: 'REJECTED' });
    const detail = await call<DraftDetailResponse>(draftDetail, 'GET', `/api/drafts/${draftId}`, { ws, id: draftId });
    expect(detail.body.reject).toEqual({ code: 'OTHER', memo: '값을 다시 물어본다' });

    const redo = await call<DecisionResponse>(reprocess, 'POST', `/api/drafts/${draftId}/reprocess`, { ws, id: draftId, body: { version: rejected.body.version } });
    expect(redo.status).toBe(200);
    expect(redo.body).toMatchObject({ status: 'PROCESSING' });
    expect((await call(drain, 'POST', '/api/jobs/drain')).body).toMatchObject({ done: 1 });
    const back = await call<DraftDetailResponse>(draftDetail, 'GET', `/api/drafts/${draftId}`, { ws, id: draftId });
    expect(back.body).toMatchObject({ status: 'NEEDS_REVIEW', reject: null });
  });

  it('여러 건을 넣으면 202 이고, 한 건이 틀려도 나머지는 들어간다', async () => {
    const got = await call(intakeBulk, 'POST', '/api/source-docs/bulk', { body: { texts: [goods(), '   ', goods()] } });
    expect(got.status).toBe(202);
    const body = BulkIntakeResponseSchema.parse(got.body);
    track(body.workspace as string);
    expect(body.counts).toEqual({ new: 2, duplicate: 0, error: 1 });
    expect(body.items[1]).toMatchObject({ index: 1, result: 'error', code: 'BAD_INPUT' });

    const csv = await call(intakeBulk, 'POST', '/api/source-docs/bulk', {
      ws: body.workspace as string, body: { csv: `text\n"${goods().replaceAll('"', '""')}"\n"${goods()}"\n` },
    });
    expect(csv.status).toBe(202);
    expect(BulkIntakeResponseSchema.parse(csv.body).counts).toEqual({ new: 2, duplicate: 0, error: 0 });
    expect(await count('drafts WHERE workspace_id = $1', [body.workspace])).toBe(4);
  });
});

describe('오류 번호', () => {
  it('입력이 틀리면 400', async () => {
    const ws = await newWorkspace();
    const cases = [
      await call(intake, 'POST', '/api/source-docs', { ws, body: '{"text": ' }),
      await call(intake, 'POST', '/api/source-docs', { ws, body: { text: 7 } }),
      await call(intake, 'POST', '/api/source-docs', { ws, body: { text: '   ' } }),
      await call(intake, 'POST', '/api/source-docs', { ws, body: { text: '가'.repeat(LIMITS.textMaxChars + 1) } }),
      await call(intake, 'POST', '/api/source-docs', { headers: { 'X-Workspace': 'not-a-workspace-id' }, body: { text: goods() } }),
      await call(draftList, 'GET', '/api/drafts?status=없는상태', { ws }),
      await call(draftList, 'GET', '/api/drafts?cursor=abc', { ws }),
      await call(exportCsv, 'GET', '/api/export.csv?kind=전부', { ws }),
      await call(exportCsv, 'GET', '/api/export.csv?template=../../etc', { ws }),
      await call(approve, 'POST', '/api/drafts/1/approve', { ws, id: 1, body: {} }),
      await call(reject, 'POST', '/api/drafts/1/reject', { ws, id: 1, body: { version: 1 } }),
      await call(reject, 'POST', '/api/drafts/1/reject', { ws, id: 1, body: { version: 1, reasonCode: '없는사유' } }),
      await call(patchFields, 'PATCH', '/api/drafts/1/fields', { ws, id: 1, body: { version: 1 } }),
    ];
    for (const got of cases) {
      expect(got.status).toBe(400);
      expect(ApiErrorBodySchema.parse(got.body).code).toBe('BAD_INPUT');
    }
    expect(await count('drafts WHERE workspace_id = $1', [ws])).toBe(0);
  });

  it('그 종류에 없는 칸이나 꼴이 다른 값으로 고치면 400 이고 아무것도 바뀌지 않는다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    const path = `/api/drafts/${draftId}/fields`;
    expect((await call(patchFields, 'PATCH', path, { ws, id: draftId, body: { version, edits: { region: '합정역' } } })).status).toBe(400);
    expect((await call(patchFields, 'PATCH', path, { ws, id: draftId, body: { version, edits: { price_krw: '오천원' } } })).status).toBe(400);
    const detail = await call<DraftDetailResponse>(draftDetail, 'GET', `/api/drafts/${draftId}`, { ws, id: draftId });
    expect(detail.body.version).toBe(version);
  });

  it('너무 긴 값으로 고치면 400 이고 변경 기록이 쌓이지 않는다. 되풀이해도 같다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    const path = `/api/drafts/${draftId}/fields`;
    const long = '가'.repeat(330_000);
    for (let i = 0; i < 3; i += 1) {
      expect((await call(patchFields, 'PATCH', path, { ws, id: draftId, body: { version, subtype: long } })).status).toBe(400);
      expect((await call(patchFields, 'PATCH', path, { ws, id: draftId, body: { version, edits: { name: long } } })).status).toBe(400);
    }
    expect(await count(`draft_events WHERE draft_id = $1 AND action = 'edit'`, [draftId])).toBe(0);
    const detail = await call<DraftDetailResponse>(draftDetail, 'GET', `/api/drafts/${draftId}`, { ws, id: draftId });
    expect(detail.body).toMatchObject({ version, subtype: '인쇄물' });
  });

  it('NUL 글자가 든 글·값·메모는 500 이 아니라 정리돼 들어간다. 여러 건에서도 나머지가 들어간다', async () => {
    const ws = await newWorkspace();
    const one = await call<IntakeResponse>(intake, 'POST', '/api/source-docs', { ws, body: { text: `abc\u0000def ${goods()}` } });
    expect(one.status).toBe(201);
    const bulk = await call<{ counts: { new: number; error: number } }>(intakeBulk, 'POST', '/api/source-docs/bulk', { ws, body: { texts: [goods(), `널 \u0000 글자 ${goods()}`] } });
    expect(bulk.status).toBe(202);
    expect(bulk.body.counts).toMatchObject({ new: 2, error: 0 });

    const { draftId, version } = await reviewableDraft(ws);
    const patched = await call<DraftDetailResponse>(patchFields, 'PATCH', `/api/drafts/${draftId}/fields`, { ws, id: draftId, body: { version, edits: { name: 'a\u0000b' } } });
    expect(patched.status).toBe(200);
    expect(patched.body.fields.find((f) => f.field === 'name')?.finalValue).toBe('a b');
    const rejected = await call(reject, 'POST', `/api/drafts/${draftId}/reject`, { ws, id: draftId, body: { version: patched.body.version, reasonCode: 'OTHER', memo: 'a\u0000b' } });
    expect(rejected.status).toBe(200);
  });

  it('여러 건이 50건을 넘으면 400 이고 한 건도 들어가지 않는다', async () => {
    const ws = await newWorkspace();
    const texts = Array.from({ length: LIMITS.bulkMaxDocs + 1 }, () => goods());
    const asList = await call(intakeBulk, 'POST', '/api/source-docs/bulk', { ws, body: { texts } });
    expect(asList.status).toBe(400);
    // 왜 안 되는지(상한 50건)를 알려 준다.
    expect(String(asList.body.message)).toContain(String(LIMITS.bulkMaxDocs));
    const asCsv = await call(intakeBulk, 'POST', '/api/source-docs/bulk', { ws, body: { csv: texts.map((t) => `"${t}"`).join('\n') } });
    expect(asCsv.status).toBe(400);
    expect(asCsv.body).toMatchObject({ code: 'BAD_INPUT' });
    expect((await call(intakeBulk, 'POST', '/api/source-docs/bulk', { ws, body: { texts: [] } })).status).toBe(400);
    expect((await call(intakeBulk, 'POST', '/api/source-docs/bulk', { ws, body: { texts: [goods()], csv: 'a' } })).status).toBe(400);
    expect(await count('drafts WHERE workspace_id = $1', [ws])).toBe(0);

    // 딱 50건은 들어간다.
    const full = await call(intakeBulk, 'POST', '/api/source-docs/bulk', { ws, body: { texts: texts.slice(0, LIMITS.bulkMaxDocs) } });
    expect(full.status).toBe(202);
    expect(await count('drafts WHERE workspace_id = $1', [ws])).toBe(LIMITS.bulkMaxDocs);
  });

  it('없는 번호는 404', async () => {
    const ws = await newWorkspace();
    const cases = [
      await call(draftDetail, 'GET', '/api/drafts/999999999', { ws, id: 999999999 }),
      await call(draftDetail, 'GET', '/api/drafts/abc', { ws, id: 'abc' }),
      await call(draftDetail, 'GET', '/api/drafts/0', { ws, id: 0 }),
      await call(productDetail, 'GET', '/api/products/999999999', { ws, id: 999999999 }),
      await call(approve, 'POST', '/api/drafts/999999999/approve', { ws, id: 999999999, body: { version: 1 } }),
      await call(patchFields, 'PATCH', '/api/drafts/999999999/fields', { ws, id: 999999999, body: { version: 1, edits: { name: '가' } } }),
      await call(exportCsv, 'GET', '/api/export.csv?template=no-such-form', { ws }),
    ];
    for (const got of cases) {
      expect(got.status).toBe(404);
      expect(got.body).toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('낡은 version 으로 누르면 409 이고 지금 상태가 함께 온다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    const first = await call<DecisionResponse>(approve, 'POST', `/api/drafts/${draftId}/approve`, { ws, id: draftId, body: { version } });
    expect(first.status).toBe(200);

    const stale = [
      await call(approve, 'POST', `/api/drafts/${draftId}/approve`, { ws, id: draftId, body: { version } }),
      await call(reject, 'POST', `/api/drafts/${draftId}/reject`, { ws, id: draftId, body: { version, reasonCode: 'OTHER' } }),
      await call(patchFields, 'PATCH', `/api/drafts/${draftId}/fields`, { ws, id: draftId, body: { version, edits: { price_krw: 1 } } }),
    ];
    for (const got of stale) {
      expect(got.status).toBe(409);
      expect(ConflictBodySchema.parse(got.body)).toMatchObject({ code: 'VERSION_CONFLICT', current: { status: 'APPROVED', version: first.body.version } });
    }
    expect(await count('products WHERE workspace_id = $1', [ws])).toBe(1);
  });

  it('표에 없는 상태 이동은 422', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    const redo = await call(reprocess, 'POST', `/api/drafts/${draftId}/reprocess`, { ws, id: draftId, body: { version } });
    expect(redo.status).toBe(422);
    expect(redo.body).toMatchObject({ code: 'BAD_TRANSITION' });

    const processing = await rawDraft(ws, 'PROCESSING');
    const early = await call(approve, 'POST', `/api/drafts/${processing}/approve`, { ws, id: processing, body: { version: 1 } });
    expect(early.status).toBe(422);
    expect(early.body).toMatchObject({ code: 'BAD_TRANSITION' });
  });

  it('상품으로 등록할 수 없는 값이면 422 이고 초안은 확인 필요로 간다', async () => {
    // 이름이 빈 채로 승인한다.
    const { ws, draftId } = await received();
    const got = await call(approve, 'POST', `/api/drafts/${draftId}/approve`, { ws, id: draftId, body: { version: 2 } });
    expect(got.status).toBe(422);
    expect(ConflictBodySchema.parse(got.body)).toMatchObject({ code: 'PRODUCT_INVALID', current: { status: 'NEEDS_REVIEW' } });
    expect(await count('products WHERE workspace_id = $1', [ws])).toBe(0);
  });

  it('오늘의 접수 상한을 넘으면 429 이고 글은 들어가지 않는다', async () => {
    const startedAt = new Date();
    const before = await count('source_docs');
    await pool().query(
      `INSERT INTO daily_counters (day, key, count) VALUES ($1, 'intake', $2)
       ON CONFLICT (day, key) DO UPDATE SET count = EXCLUDED.count`,
      [kstDay(new Date()), LIMITS.intakePerDay],
    );
    try {
      const got = await call(intake, 'POST', '/api/source-docs', { body: { text: goods() } });
      expect(got.status).toBe(429);
      expect(got.body).toMatchObject({ code: 'LIMIT_EXCEEDED' });
      expect(await count('source_docs')).toBe(before);
    } finally {
      await resetToday();
      // 이때 헤더 없이 온 요청은 빈 공간 하나를 남긴다(이틀 뒤 지워진다). 시험이 남긴 것은 여기서 지운다.
      await pool().query(
        `DELETE FROM workspaces w WHERE w.kind = 'sandbox' AND w.created_at >= $1
            AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.workspace_id = w.id)`,
        [startedAt],
      );
    }
  });

  it('공간 하나에 초안이 100건이면 더 받지 않는다(429)', async () => {
    const ws = await newWorkspace();
    for (let i = 0; i < LIMITS.draftsPerWorkspace / LIMITS.bulkMaxDocs; i += 1) {
      const texts = Array.from({ length: LIMITS.bulkMaxDocs }, () => goods());
      expect((await call(intakeBulk, 'POST', '/api/source-docs/bulk', { ws, body: { texts } })).status).toBe(202);
    }
    const got = await call(intake, 'POST', '/api/source-docs', { ws, body: { text: goods() } });
    expect(got.status).toBe(429);
    expect(got.body).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(await count('drafts WHERE workspace_id = $1', [ws])).toBe(LIMITS.draftsPerWorkspace);
  });

  it('본보기 공간에는 쓰지 못한다(403). 헤더 없이 고치거나 결정해도 같다', async () => {
    await ensurePublicWorkspace(pool(), at(0));
    const pub = PUBLIC_WORKSPACE_ID;
    const before = await count('drafts WHERE workspace_id = $1', [pub]);
    const cases = [
      await call(intake, 'POST', '/api/source-docs', { ws: pub, body: { text: goods() } }),
      await call(upload, 'POST', '/api/source-files', { ws: pub, body: fileForm(pngBytes()) }),
      await call(patchFields, 'PATCH', '/api/drafts/1/fields', { ws: pub, id: 1, body: { version: 1, edits: { name: '가' } } }),
      await call(approve, 'POST', '/api/drafts/1/approve', { id: 1, body: { version: 1 } }),
      await call(reject, 'POST', '/api/drafts/1/reject', { id: 1, body: { version: 1, reasonCode: 'OTHER' } }),
      await call(reprocess, 'POST', '/api/drafts/1/reprocess', { id: 1, body: { version: 1 } }),
      await call(patchFields, 'PATCH', '/api/drafts/1/fields', { id: 1, body: { version: 1, edits: { name: '가' } } }),
    ];
    for (const got of cases) {
      expect(got.status).toBe(403);
      expect(got.body).toMatchObject({ code: 'READ_ONLY_WORKSPACE' });
    }
    const bulk = await call(intakeBulk, 'POST', '/api/source-docs/bulk', { ws: pub, body: { texts: [goods()] } });
    expect(bulk.status).toBe(403);
    expect(await count('drafts WHERE workspace_id = $1', [pub])).toBe(before);
  });

  it('모델을 부를 수 없으면 그림은 접수하지 않는다(503, 까닭이 함께 온다)', async () => {
    const before = await workspaces();
    const got = await call(upload, 'POST', '/api/source-files', { body: fileForm(pngBytes()) });
    expect(got.status).toBe(503);
    expect(ApiErrorBodySchema.parse(got.body)).toMatchObject({ code: 'LLM_UNAVAILABLE', skipCause: 'cache_miss' });
    expect(await workspaces()).toBe(before);
  });

  it('예상 못 한 오류는 500 이고 내부 글을 싣지 않는다', async () => {
    const broken = route('시험', async () => {
      throw new Error('connect ECONNREFUSED postgres://someone@10.0.0.1/db');
    });
    const response = await broken();
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ code: 'INTERNAL' });
    expect(body).not.toMatch(/postgres|ECONNREFUSED|10\.0\.0\.1/);
  });
});

describe('작업 공간', () => {
  it('남의 공간 번호로는 초안·상품·내려받기가 보이지 않고 손댈 수도 없다', async () => {
    const mine = await received();
    const theirs = await newWorkspace();
    const { draftId } = mine;
    const fixed = await call<DraftDetailResponse>(patchFields, 'PATCH', `/api/drafts/${draftId}/fields`, {
      ws: mine.ws, id: draftId, body: { version: 2, edits: { name: '달무리 응원 슬로건' } },
    });
    const approved = await call<DecisionResponse>(approve, 'POST', `/api/drafts/${draftId}/approve`, { ws: mine.ws, id: draftId, body: { version: fixed.body.version } });
    const productId = approved.body.productId as number;

    for (const ws of [theirs, null]) {
      const seen = { ws, id: draftId };
      expect((await call(draftDetail, 'GET', `/api/drafts/${draftId}`, seen)).status).toBe(404);
      expect((await call(productDetail, 'GET', `/api/products/${productId}`, { ws, id: productId })).status).toBe(404);
      const list = await call<DraftListResponse>(draftList, 'GET', '/api/drafts', { ws });
      expect(list.body.items.some((d) => d.id === draftId)).toBe(false);
      const products = await call<{ items: { id: number }[] }>(productList, 'GET', '/api/products', { ws });
      expect(products.body.items.some((p) => p.id === productId)).toBe(false);
      expect((await call<string>(exportCsv, 'GET', '/api/export.csv', { ws })).body).not.toContain('달무리');
      expect((await call<string>(exportCsv, 'GET', '/api/export.csv?kind=corrections', { ws })).body).not.toContain('달무리');
    }
    const act = { ws: theirs, id: draftId };
    expect((await call(patchFields, 'PATCH', `/api/drafts/${draftId}/fields`, { ...act, body: { version: approved.body.version, edits: { price_krw: 1 } } })).status).toBe(404);
    expect((await call(approve, 'POST', `/api/drafts/${draftId}/approve`, { ...act, body: { version: approved.body.version } })).status).toBe(404);
    expect((await call(reject, 'POST', `/api/drafts/${draftId}/reject`, { ...act, body: { version: approved.body.version, reasonCode: 'OTHER' } })).status).toBe(404);
    expect((await call(reprocess, 'POST', `/api/drafts/${draftId}/reprocess`, { ...act, body: { version: approved.body.version } })).status).toBe(404);

    // 내 공간에서는 그대로다.
    const still = await call<DraftDetailResponse>(draftDetail, 'GET', `/api/drafts/${draftId}`, { ws: mine.ws, id: draftId });
    expect(still.body).toMatchObject({ status: 'APPROVED', version: approved.body.version, productId });
  });

  it('같은 글이라도 공간이 다르면 따로 접수된다', async () => {
    const text = goods();
    const a = await call<IntakeResponse>(intake, 'POST', '/api/source-docs', { body: { text } });
    const b = await call<IntakeResponse>(intake, 'POST', '/api/source-docs', { body: { text } });
    track(a.body.workspace);
    track(b.body.workspace);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.workspace).not.toBe(b.body.workspace);
    expect(a.body.draftId).not.toBe(b.body.draftId);
  });

  it('헤더 없는 쓰기는 공간을 만들어 돌려주고, 그 번호로 이어 쓸 수 있다', async () => {
    const before = await workspaces();
    const first = await call<IntakeResponse>(intake, 'POST', '/api/source-docs', { body: { text: goods() } });
    const ws = track(first.body.workspace);
    expect(ws).toMatch(/^[0-9a-f-]{36}$/);
    expect(ws).not.toBe(PUBLIC_WORKSPACE_ID);
    expect(await workspaces()).toBe(before + 1);
    expect(await count(`workspaces WHERE id = $1 AND kind = 'sandbox'`, [ws])).toBe(1);

    const second = await call<IntakeResponse>(intake, 'POST', '/api/source-docs', { ws, body: { text: goods() } });
    expect(second.body.workspace).toBe(ws);
    expect(await workspaces()).toBe(before + 1);
    const list = await call<DraftListResponse>(draftList, 'GET', '/api/drafts', { ws });
    expect(list.body.items).toHaveLength(2);
  });

  it('헤더 없는 읽기와 틀린 쓰기는 아무것도 만들지 않는다', async () => {
    const before = { workspaces: await workspaces(), docs: await count('source_docs'), jobs: await count('jobs') };
    const reads = [
      await call(draftList, 'GET', '/api/drafts'),
      await call(productList, 'GET', '/api/products'),
      await call(exportCsv, 'GET', '/api/export.csv'),
      await call(exportCsv, 'GET', '/api/export.csv?kind=corrections'),
    ];
    for (const got of reads) expect(got.status).toBe(200);
    expect((await call(draftDetail, 'GET', '/api/drafts/999999999', { id: 999999999 })).status).toBe(404);
    expect((await call(intake, 'POST', '/api/source-docs', { body: { text: '' } })).status).toBe(400);
    expect((await call(intakeBulk, 'POST', '/api/source-docs/bulk', { body: { texts: ['  ', ''] } })).body).toMatchObject({ workspace: null });
    // 모르는 번호로 읽어도 그 공간이 생기지 않는다.
    const unknown = '11111111-2222-4333-8444-555555555555';
    expect((await call<DraftListResponse>(draftList, 'GET', '/api/drafts', { ws: unknown })).body.items).toEqual([]);
    expect(await count('workspaces WHERE id = $1', [unknown])).toBe(0);

    expect({ workspaces: await workspaces(), docs: await count('source_docs'), jobs: await count('jobs') }).toEqual(before);
  });
});
