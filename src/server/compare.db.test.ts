// 비교가 상품을 읽는 길과 경로. npm run test:db 에서 돈다(시험용 PostgreSQL).
// 상품을 읽는 시험은 트랜잭션 하나 안에서 공간과 상품을 만들고 끝나면 되돌린다. 다른 시험의 자료를 건드리지 않고 남기지도 않는다.
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { ApiErrorBodySchema, PUBLIC_WORKSPACE_ID, WORKSPACE_HEADER } from '@/contract/api';
import { CompareQuerySchema, CompareResponseSchema } from '@/contract/tools/compare';
import { GET as compareRoute } from '../../app/api/compare/route';
import { compareFor } from './compare';
import { closePool, getPool } from './db';
import { isAppError } from './errors';
import { insertProduct, type ProductDraft } from './repos/products';
import { ensurePublicWorkspace } from './workspace';

const T0 = new Date('2001-06-01T03:00:00Z');
let serial = 0;

afterAll(async () => {
  await closePool();
});

const query = (raw: Record<string, string>) => CompareQuerySchema.parse(raw);

async function newWorkspace(client: PoolClient): Promise<string> {
  const ws = await client.query<{ id: string }>(`INSERT INTO workspaces (kind, created_at, last_write_at) VALUES ('local', $1, $1) RETURNING id`, [T0]);
  return ws.rows[0]?.id as string;
}

async function inRollback(run: (client: PoolClient, wsId: string) => Promise<void>) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await run(client, await newWorkspace(client));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** 승인된 초안에서 나온 것처럼 상품 한 줄을 넣는다(원문 → 초안 → 상품). */
async function addProduct(client: PoolClient, wsId: string, over: Partial<ProductDraft>): Promise<number> {
  serial += 1;
  const doc = await client.query<{ id: string }>(
    'INSERT INTO source_docs (workspace_id, clean_text, content_hash, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [wsId, `비교 시험 글 ${serial}`, `compare-test-${serial}`, T0],
  );
  const draft = await client.query<{ id: string }>(
    `INSERT INTO drafts (workspace_id, source_doc_id, status, created_at, updated_at) VALUES ($1, $2, 'APPROVED', $3, $3) RETURNING id`,
    [wsId, doc.rows[0]?.id, T0],
  );
  const product: ProductDraft = {
    type: 'ad', subtype: '전광판', name: `가상 전광판 ${serial}`, price_krw: 1_500_000, list_price_krw: null, vat_included: false,
    spec: {}, options: [{ days: 7, price_krw: 1_500_000 }], ...over,
  };
  return insertProduct(client, wsId, Number(draft.rows[0]?.id), product, T0);
}

describe('공간의 상품을 같은 잣대로 놓는다', () => {
  it('저장된 칸을 그대로 읽어 견줄 값을 낸다. 없는 칸은 없음이다', async () => {
    await inRollback(async (client, ws) => {
      const board = await addProduct(client, ws, {
        name: '합정역 가상 전광판', price_krw: 1_500_000, vat_included: false,
        options: [{ days: 7, price_krw: 1_500_000 }, { days: 14, price_krw: 2_800_000 }],
        spec: { region: '합정역 7번출구', size_m: { width: 7, height: 12 }, hours: { open: '05:00', close: '01:00', nextDay: true }, plays_per_day: 100, spot_seconds: 20, material_deadline_days: 14 },
      });
      const subway = await addProduct(client, ws, {
        subtype: '지하철', name: '강남역 가상 조명광고', price_krw: 3_200_000, vat_included: false, options: [{ days: 30, price_krw: 3_200_000 }],
        spec: { region: '강남역', footfall_per_day: 140_000, booking_deadline_days: 14 },
      });
      const slogan = await addProduct(client, ws, { type: 'goods', subtype: '잡화', name: '가상 슬로건', price_krw: 4_500, vat_included: true, options: [], spec: { size_mm: { width: 600, height: 200 }, min_order_qty: 30 } });

      const got = await compareFor(ws, query({ type: 'ad', sort: 'per_day_krw' }), client);
      expect(CompareResponseSchema.safeParse(got).success).toBe(true);
      expect(got.total).toBe(3);
      // 3,200,000 ÷ 30 = 106,667(반올림)   1,500,000 ÷ 7 = 214,286(반올림)
      expect(got.rows.map((r) => [r.productId, r.rank, r.values.per_day_krw.value, r.values.per_day_krw.rounded])).toEqual([
        [subway, 1, 106_667, true],
        [board, 2, 214_286, true],
      ]);
      expect(got.sort).toEqual({ metric: 'per_day_krw', order: 'asc', split: false, byType: false });
      expect(got.warnings).toEqual([]);

      const boardRow = got.rows[1];
      expect(boardRow?.values.per_day_krw.basis).toEqual({ kind: 'period_option', days: 7, price_krw: 1_500_000 });
      expect(boardRow?.options.map((o) => [o.size, o.each, o.rounded])).toEqual([[7, 214_286, true], [14, 200_000, false]]);
      expect(boardRow?.values.area_m2.value).toBe(84);
      expect(boardRow?.values.open_minutes.value).toBe(1200);
      expect(boardRow?.values.exposure_seconds.value).toBe(2000);
      // 유동인구가 안 적힌 지면: 없음이고 까닭이 있다.
      expect(boardRow?.values.per_1000_footfall_krw).toEqual({ value: null, rounded: false, basis: null, missing: { reason: 'no_value', fields: ['footfall_per_day'] } });
      // 3,200,000 × 1,000 ÷ (30 × 140,000) = 761.9 → 762
      expect(got.rows[0]?.values.per_1000_footfall_krw.value).toBe(762);

      // 거르기: 갈래, 지역 글자.
      expect((await compareFor(ws, query({ subtype: '지하철' }), client)).rows.map((r) => r.productId)).toEqual([subway]);
      expect((await compareFor(ws, query({ region: '합정' }), client)).rows.map((r) => r.productId)).toEqual([board]);
      expect((await compareFor(ws, query({ type: 'catering' }), client)).rows).toEqual([]);

      // 아무것도 안 주면 전부, 번호순. 종류와 부가세가 섞였다고 알린다.
      const all = await compareFor(ws, query({}), client);
      expect(all.rows.map((r) => r.productId)).toEqual([board, subway, slogan]);
      expect(all.warnings.map((w) => w.code)).toEqual(['vat_mixed', 'mixed_types']);

      // 나란히 놓기: 받은 차례 그대로.
      const side = (await compareFor(ws, query({ ids: `${subway},${board}` }), client)).side;
      expect(side?.productIds).toEqual([subway, board]);
      // 7일 옵션과 30일 옵션에서 나눈 하루당 값이라 좋은 쪽을 붙이지 않는다.
      expect(side?.metrics.find((m) => m.metric === 'per_day_krw')).toMatchObject({ differs: true, best: [], bestWithheld: 'mixed_basis' });
    });
  });

  it('다른 공간의 상품은 보이지 않는다. 본보기 공간도 따로다', async () => {
    await inRollback(async (client, ws) => {
      await ensurePublicWorkspace(client, T0);
      const mine = await addProduct(client, ws, {});
      const mine2 = await addProduct(client, ws, {});
      const shown = await addProduct(client, PUBLIC_WORKSPACE_ID, {});
      const other = await newWorkspace(client);
      const theirs = await addProduct(client, other, {});

      expect((await compareFor(ws, query({}), client)).rows.map((r) => r.productId)).toEqual([mine, mine2]);
      const pub = (await compareFor(PUBLIC_WORKSPACE_ID, query({}), client)).rows.map((r) => r.productId);
      expect(pub).toContain(shown);
      expect(pub).not.toContain(mine);
      expect(pub).not.toContain(theirs);

      // 남의 공간·본보기 공간의 상품 번호를 나란히 놓으려 하면 없는 번호와 똑같이 404 다(있는지도 알려 주지 않는다).
      for (const foreign of [theirs, shown, 999_999_999]) {
        const err = await compareFor(ws, query({ ids: `${mine},${foreign}` }), client).catch((e: unknown) => e);
        expect(isAppError(err) && err.code).toBe('NOT_FOUND');
      }
      expect((await compareFor(ws, query({ ids: `${mine},${mine2}` }), client)).side?.productIds).toEqual([mine, mine2]);
    });
  });
});

describe('GET /api/compare (풀로 읽는 길)', () => {
  const get = (path: string, headers: Record<string, string> = {}) => compareRoute(new Request(`http://chaeum.test${path}`, { headers }));

  it('상품이 없는 공간은 빈 표다(200). 읽기만으로 공간을 만들지 않는다', async () => {
    const ws = '99999999-aaaa-4bbb-8ccc-000000000002';
    const response = await get('/api/compare?type=ad&sort=per_day_krw', { [WORKSPACE_HEADER]: ws });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = CompareResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ total: 0, rows: [], warnings: [], side: null, sort: { metric: 'per_day_krw', order: 'asc', split: false } });
    const { rows } = await getPool().query('SELECT 1 FROM workspaces WHERE id = $1', [ws]);
    expect(rows).toHaveLength(0);
  });

  it('공간 헤더가 없으면 본보기 공간으로 돈다. 거른 수는 전체를 넘지 않는다', async () => {
    const response = await get('/api/compare');
    expect(response.status).toBe(200);
    const body = CompareResponseSchema.parse(await response.json());
    expect(body.rows.length).toBe(body.total);
    const ads = CompareResponseSchema.parse(await (await get('/api/compare?type=ad')).json());
    expect(ads.rows.length).toBeLessThanOrEqual(body.total);
    expect(ads.rows.every((r) => r.type === 'ad')).toBe(true);
  });

  it('없는 상품 번호를 나란히 놓으려 하면 404', async () => {
    const response = await get('/api/compare?ids=999999998,999999999', { [WORKSPACE_HEADER]: '99999999-aaaa-4bbb-8ccc-000000000002' });
    expect(response.status).toBe(404);
    expect(ApiErrorBodySchema.parse(await response.json()).code).toBe('NOT_FOUND');
  });

  it('잘못된 요청은 400 이다(DB 를 읽기 전에 막는다)', async () => {
    const bad = [
      '?type=food',
      '?subtype=비행선',
      '?type=ad&subtype=커피차',
      '?sort=vat_included',
      '?order=asc',
      '?sort=per_day_krw&order=up',
      '?ids=5',
      '?ids=1,2,3,4,5',
      '?ids=5,5',
      '?ids=5,x',
      `?region=${'가'.repeat(61)}`,
    ];
    for (const q of bad) {
      const response = await get(`/api/compare${encodeURI(q)}`);
      expect([q, response.status]).toEqual([q, 400]);
      expect(ApiErrorBodySchema.parse(await response.json()).code).toBe('BAD_INPUT');
    }
    const badSpace = await get('/api/compare', { [WORKSPACE_HEADER]: 'not-a-uuid' });
    expect(badSpace.status).toBe(400);
  });
});
