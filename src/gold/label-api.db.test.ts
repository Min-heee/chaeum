// 확인 화면의 API 가 확인 기록(gold_reviews)에 한 줄을 쓰는지 본다.
// 서버를 띄우지 않고 경로 파일의 함수를 바로 부른다. npm run test:db 에서 돈다(시험용 PostgreSQL, 이름이 _test 로 끝나는 DB).
// 이 시험은 앱의 연결 풀로 커밋까지 간다. 옆에서 도는 시험이 그 줄을 보지 않게, 이 시험만 쓰는 스키마를 만들고 끝나면 통째로 지운다.
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GoldDoc } from '@/contract/eval-types';
import { closePool, getPool } from '@/server/db';
import { GET as getQueue } from '../../app/label/api/queue/route';
import { POST as postReview } from '../../app/label/api/review/route';
import { migrate } from '../../scripts/migrate';
import { assemble } from './assemble';
import { generateSpecs } from './generate';
import { loadDocs } from './store';

config({ path: '.env.local', quiet: true });
const url = process.env.TEST_DATABASE_URL;
const usable = url !== undefined && new URL(url).pathname.endsWith('_test');

const SCHEMA = `label_api_${process.pid}`;
const DOC_ID = 'hand-998';
const spec = generateSpecs(11).find((s) => s.type === 'ad') as ReturnType<typeof generateSpecs>[number];
const made = assemble([spec], [{ id: spec.id, content: `${spec.surface_hints.flatMap((h) => h.tokens).join(' ')} `.padEnd(120, '가') }]).docs[0] as GoldDoc;
const doc: GoldDoc = { ...made, id: DOC_ID, split: 'hand' };

const post = (body: unknown) =>
  postReview(new Request('http://localhost/label/api/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

describe.skipIf(!usable)('확인 화면의 API', { timeout: 20_000, shuffle: false }, () => {
  const before = { db: process.env.DATABASE_URL, label: process.env.LABEL_ENABLED };

  const reviews = async () => {
    const { rows } = await getPool().query('SELECT pass, verdict, fixed_fields, seconds, reviewed_at FROM gold_reviews WHERE gold_doc_id = $1 ORDER BY id', [DOC_ID]);
    return rows as { pass: number; verdict: string; fixed_fields: number; seconds: number | null; reviewed_at: Date }[];
  };

  /** 시험용 DB 에 연결해 한 가지 일을 하고 닫는다. */
  const admin = async (sql: string) => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    await admin(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
    // 이 스키마만 보는 주소. 표도 여기에 새로 만든다.
    const scoped = new URL(url as string);
    scoped.searchParams.set('options', `-c search_path=${SCHEMA}`);
    await migrate(scoped.toString());
    // 앱이 읽는 주소를 바꾼다.
    process.env.DATABASE_URL = scoped.toString();
    await loadDocs(getPool(), [doc]);
  });

  beforeEach(() => {
    process.env.LABEL_ENABLED = '1';
  });

  afterAll(async () => {
    await closePool();
    await admin(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    process.env.DATABASE_URL = before.db;
    process.env.LABEL_ENABLED = before.label;
  });

  it('LABEL_ENABLED 가 1 이 아니면 404 이고 아무것도 적지 않는다', async () => {
    delete process.env.LABEL_ENABLED;
    expect((await post({ docId: DOC_ID, pass: 1, seconds: 5 })).status).toBe(404);
    expect((await getQueue(new Request(`http://localhost/label/api/queue?id=${DOC_ID}`))).status).toBe(404);
    process.env.LABEL_ENABLED = '0';
    expect((await post({ docId: DOC_ID, pass: 1, seconds: 5 })).status).toBe(404);
    expect(await reviews()).toEqual([]);
  });

  it('줄을 물으면 문서가 원문과 정답과 함께 온다', async () => {
    const res = await getQueue(new Request(`http://localhost/label/api/queue?id=${DOC_ID}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { docs: GoldDoc[] };
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0]).toMatchObject({ id: DOC_ID, content: doc.content });
    expect(body.docs[0]?.truth.fields.name).toBe(doc.truth.fields.name);
  });

  it('맞음을 보내면 확인 기록에 한 줄이 남는다(판정, 고친 칸 0, 걸린 초)', async () => {
    const res = await post({ docId: DOC_ID, pass: 1, drop: false, fixes: {}, seconds: 37.4 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verdict: 'ok', fixedFields: 0 });
    const rows = await reviews();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pass: 1, verdict: 'ok', fixed_fields: 0, seconds: 37 });
    expect(rows[0]?.reviewed_at).toBeInstanceOf(Date);
  });

  it('적은 줄은 다른 연결에서도 보인다(커밋까지 갔다)', async () => {
    const other = new Client({ connectionString: url });
    await other.connect();
    try {
      const { rows } = await other.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.gold_reviews WHERE gold_doc_id = $1`, [DOC_ID]);
      expect(rows[0]).toEqual({ n: 1 });
    } finally {
      await other.end();
    }
  });

  it('고친 칸을 보내면 정답이 바뀌고 한 줄이 더 남는다', async () => {
    const res = await post({ docId: DOC_ID, pass: 1, fixes: { name: '고친 이름', vat_included: doc.truth.fields.vat_included ?? null }, seconds: 12 });
    expect(await res.json()).toEqual({ verdict: 'fixed', fixedFields: 1 });
    const { rows } = await getPool().query("SELECT truth->'fields'->>'name' AS name FROM gold_docs WHERE id = $1", [DOC_ID]);
    expect(rows[0]).toEqual({ name: '고친 이름' });
    expect((await reviews()).map((r) => r.verdict)).toEqual(['ok', 'fixed']);
  });

  it('다시 보기는 pass 2 로 남는다', async () => {
    expect((await post({ docId: DOC_ID, pass: 2, seconds: 8 })).status).toBe(200);
    expect((await reviews()).map((r) => r.pass)).toEqual([1, 1, 2]);
  });

  it('꼴이 다른 요청은 400, 없는 문서는 404 이고 줄이 늘지 않는다', async () => {
    const count = (await reviews()).length;
    expect((await post({ docId: DOC_ID })).status).toBe(400);
    expect((await post({ docId: DOC_ID, pass: 3 })).status).toBe(400);
    expect((await post({ docId: DOC_ID, pass: 1, fixes: { price_krw: '백만원' } })).status).toBe(400);
    expect((await post({ docId: DOC_ID, pass: 1, fixes: { material: '아크릴' } })).status).toBe(400);
    expect((await post({ docId: 'hand-000', pass: 1 })).status).toBe(404);
    expect((await reviews()).length).toBe(count);
  });
});
