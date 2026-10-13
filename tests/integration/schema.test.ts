// 이행을 적용한 DB 의 꼴을 본다. 시험용 DB 가 필요하다.
import { afterAll, describe, expect, it } from 'vitest';
import { DRAFT_STATUSES } from '@/contract/transitions';
import { closePool, getPool } from '@/server/db';
import { migrate } from '../../scripts/migrate';

// 본체 14개 + 딸린 도구 4개(용어 사전, 견적, 모으기의 묶음과 줄) + 실제 자료를 넣은 기록 1개.
const TABLES = [
  'collected_items', 'daily_counters', 'draft_events', 'draft_fields', 'drafts', 'eval_results', 'eval_runs', 'glossary_terms', 'gold_docs',
  'gold_real_intake', 'gold_reviews', 'import_batches', 'jobs', 'llm_calls', 'product_texts', 'products', 'quotes', 'source_docs', 'workspaces',
];

afterAll(async () => {
  await closePool();
});

describe('DB 꼴', () => {
  it('표는 19개이고 적용 기록 표가 따로 하나 있다', async () => {
    const { rows } = await getPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    const names = rows.map((r) => r.table_name);
    expect(names.filter((n) => n !== 'schema_migrations')).toEqual(TABLES);
    expect(names).toContain('schema_migrations');
  });

  it('이행을 다시 돌려도 새로 적용되는 것이 없다', async () => {
    const result = await migrate(process.env.DATABASE_URL as string);
    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('초안 상태의 CHECK 는 약속의 상태 6개와 같다', async () => {
    const { rows } = await getPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        WHERE c.conrelid = 'drafts'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%PROCESSING%'`,
    );
    const def = rows.map((r) => r.def).join(' ');
    for (const status of DRAFT_STATUSES) expect(def).toContain(`'${status}'`);
  });

  it('확정 상품은 엄격하다: 값이 0 이하이거나 정가가 판매가보다 작으면 들어가지 않는다', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const ws = await client.query<{ id: string }>(`INSERT INTO workspaces (kind) VALUES ('local') RETURNING id`);
      const wsId = ws.rows[0]?.id;
      const doc = await client.query<{ id: string }>(
        `INSERT INTO source_docs (workspace_id, clean_text, content_hash) VALUES ($1, '글', 'h1') RETURNING id`,
        [wsId],
      );
      const draft = await client.query<{ id: string }>(
        `INSERT INTO drafts (workspace_id, source_doc_id) VALUES ($1, $2) RETURNING id`,
        [wsId, doc.rows[0]?.id],
      );
      const insert = (price: number, listPrice: number | null) =>
        client.query(
          `INSERT INTO products (workspace_id, draft_id, type, subtype, name, price_krw, list_price_krw, spec)
           VALUES ($1, $2, 'goods', '인쇄물', '응원 슬로건', $3, $4, '{}')`,
          [wsId, draft.rows[0]?.id, price, listPrice],
        );

      await client.query('SAVEPOINT a');
      await expect(insert(0, null)).rejects.toThrow(/check/i);
      await client.query('ROLLBACK TO a');
      await expect(insert(5000, 3000)).rejects.toThrow(/check/i);
      await client.query('ROLLBACK TO a');
      await expect(insert(3000, 5000)).resolves.toBeDefined();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('같은 공간에 같은 글은 한 번만, 같은 작업도 한 번만 들어간다', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const ws = await client.query<{ id: string }>(`INSERT INTO workspaces (kind) VALUES ('local') RETURNING id`);
      const wsId = ws.rows[0]?.id;
      const addDoc = () =>
        client.query(`INSERT INTO source_docs (workspace_id, clean_text, content_hash) VALUES ($1, '글', 'same')`, [wsId]);
      const addJob = () =>
        client.query(`INSERT INTO jobs (kind, ref_id, run_at) VALUES ('extract', 987654321, '2026-01-01T00:00:00Z')`);

      await addDoc();
      await client.query('SAVEPOINT a');
      await expect(addDoc()).rejects.toThrow(/unique|duplicate/i);
      await client.query('ROLLBACK TO a');
      await addJob();
      await client.query('SAVEPOINT b');
      await expect(addJob()).rejects.toThrow(/unique|duplicate/i);
      await client.query('ROLLBACK TO b');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
