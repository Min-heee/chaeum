// 달력이 상품을 읽는 길. npm run test:db 에서 돈다(시험용 PostgreSQL).
// 트랜잭션 하나 안에서 공간과 상품을 만들고 끝나면 되돌린다. 다른 시험의 자료를 건드리지 않고 남기지도 않는다.
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PUBLIC_WORKSPACE_ID, WORKSPACE_HEADER } from '@/contract/api';
import { CalendarResponseSchema } from '@/contract/tools/calendar';
import { GET as calendarRoute } from '../../app/api/calendar/route';
import { calendarFor } from './calendar';
import { closePool, getPool } from './db';
import { insertProduct, type ProductDraft } from './repos/products';
import { ensurePublicWorkspace } from './workspace';

const T0 = new Date('2001-06-01T03:00:00Z');
const NOON = new Date('2026-10-12T03:00:00Z');
let serial = 0;

afterAll(async () => {
  await closePool();
});

async function inRollback(run: (client: PoolClient, wsId: string) => Promise<void>) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const ws = await client.query<{ id: string }>(`INSERT INTO workspaces (kind, created_at, last_write_at) VALUES ('local', $1, $1) RETURNING id`, [T0]);
    await run(client, ws.rows[0]?.id as string);
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
    [wsId, `달력 시험 글 ${serial}`, `calendar-test-${serial}`, T0],
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

describe('공간의 상품으로 마감을 센다', () => {
  it('상품의 마감 일수 칸을 그대로 읽어 지면별 마감일을 낸다', async () => {
    await inRollback(async (client, ws) => {
      const ad = await addProduct(client, ws, { name: '합정역 가상 전광판', spec: { region: '합정역', booking_deadline_days: 14, material_deadline_days: 7 } });
      const coffee = await addProduct(client, ws, {
        type: 'catering', subtype: '커피차', name: '가상 커피차', price_krw: 800_000, options: [{ qty: 100, price_krw: 800_000 }],
        spec: { service_region: '서울 전역', design_deadline_days: 5 },
      });
      const slogan = await addProduct(client, ws, { type: 'goods', subtype: '인쇄물', name: '가상 슬로건', price_krw: 5_000, options: [], spec: { size_mm: { width: 200, height: 600 } } });

      const got = await calendarFor(ws, { date: '2027-03-09', today: '2027-02-21' }, NOON, client);
      expect(CalendarResponseSchema.safeParse(got).success).toBe(true);
      expect(got).toMatchObject({ today: '2027-02-21', eventDate: '2027-03-09', anniversary: null });
      // 급한 것부터: 곧 마감(예약 2월 23일), 아직 됨(시안 3월 4일), 일수 없음(굿즈에 제작 기간이 없다).
      expect(got.items.map((i) => [i.productId, i.status, i.daysLeft])).toEqual([
        [ad, 'closing', 2],
        [coffee, 'open', 11],
        [slogan, 'unknown', null],
      ]);
      expect(got.items[0]?.deadlines.map((d) => [d.kind, d.date])).toEqual([
        ['booking', '2027-02-23'],
        ['material', '2027-03-02'],
      ]);
      expect(got.items[2]?.missing).toEqual(['order']);
      expect(got.counts).toEqual({ open: 1, closing: 1, late: 0, unknown: 1 });
    });
  });

  it('기념일을 고르면 오늘 이후 처음 오는 그 날이 기준일이다. 2월 29일은 평년에 2월 28일', async () => {
    await inRollback(async (client, ws) => {
      await addProduct(client, ws, { spec: { booking_deadline_days: 14, material_deadline_days: 7 } });
      const got = await calendarFor(ws, { anniversary: 'ann-03', today: '2026-10-12' }, NOON, client);
      expect(got.anniversary).toMatchObject({ id: 'ann-03', month: 2, day: 29 });
      expect(got.eventDate).toBe('2027-02-28');
      expect(got.items[0]?.deadlines.map((d) => d.date)).toEqual(['2027-02-14', '2027-02-21']);

      const leap = await calendarFor(ws, { anniversary: 'ann-03', today: '2027-03-01' }, NOON, client);
      expect(leap.eventDate).toBe('2028-02-29');
    });
  });

  it('today 를 안 주면 서버 시각의 한국 날짜로 센다', async () => {
    await inRollback(async (client, ws) => {
      await addProduct(client, ws, { spec: { booking_deadline_days: 1 } });
      // UTC 10월 11일 15:30 = 한국 10월 12일 00:30. 10월 13일의 하루 전 마감은 "오늘까지"다. UTC 날짜로 셌다면 1일 남음이 된다.
      const got = await calendarFor(ws, { date: '2026-10-13' }, new Date('2026-10-11T15:30:00Z'), client);
      expect(got.today).toBe('2026-10-12');
      expect(got.items[0]).toMatchObject({ status: 'closing', daysLeft: 0 });
    });
  });

  it('다른 공간의 상품은 세지 않는다. 본보기 공간도 따로다', async () => {
    await inRollback(async (client, ws) => {
      await ensurePublicWorkspace(client, T0);
      const mine = await addProduct(client, ws, { spec: { booking_deadline_days: 14 } });
      const shown = await addProduct(client, PUBLIC_WORKSPACE_ID, { spec: { booking_deadline_days: 3 } });
      const other = await client.query<{ id: string }>(`INSERT INTO workspaces (kind, created_at, last_write_at) VALUES ('local', $1, $1) RETURNING id`, [T0]);
      await addProduct(client, other.rows[0]?.id as string, { spec: { booking_deadline_days: 30 } });

      const query = { date: '2027-03-09', today: '2026-10-12' };
      expect((await calendarFor(ws, query, NOON, client)).items.map((i) => i.productId)).toEqual([mine]);
      expect((await calendarFor(PUBLIC_WORKSPACE_ID, query, NOON, client)).items.map((i) => i.productId)).toContain(shown);
      expect((await calendarFor(PUBLIC_WORKSPACE_ID, query, NOON, client)).items.map((i) => i.productId)).not.toContain(mine);
    });
  });
});

describe('GET /api/calendar (풀로 읽는 길)', () => {
  it('상품이 없는 공간은 빈 표다(200). 읽기만으로 공간을 만들지 않는다', async () => {
    const ws = '99999999-aaaa-4bbb-8ccc-000000000001';
    const response = await calendarRoute(new Request('http://chaeum.test/api/calendar?date=2027-03-09&today=2026-10-12', { headers: { [WORKSPACE_HEADER]: ws } }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = CalendarResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ eventDate: '2027-03-09', items: [], counts: { open: 0, closing: 0, late: 0, unknown: 0 } });
    const { rows } = await getPool().query('SELECT 1 FROM workspaces WHERE id = $1', [ws]);
    expect(rows).toHaveLength(0);
  });

  it('공간 헤더가 없으면 본보기 공간으로 센다. 센 수와 목록의 길이가 맞는다', async () => {
    const response = await calendarRoute(new Request('http://chaeum.test/api/calendar?anniversary=ann-04&today=2026-10-12'));
    expect(response.status).toBe(200);
    const body = CalendarResponseSchema.parse(await response.json());
    expect(body.eventDate).toBe('2027-03-09');
    expect(body.anniversary).toMatchObject({ id: 'ann-04' });
    expect(Object.values(body.counts).reduce((a, b) => a + b, 0)).toBe(body.items.length);
  });
});
