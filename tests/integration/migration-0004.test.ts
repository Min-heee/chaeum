// 이행 0004(딸린 도구의 표 넷과 본체 목록에 더한 값)의 꼴을 본다. 시험용 DB 가 필요하다.
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { SOURCE_KINDS } from '@/contract/api';
import { EXTRACTED_BY } from '@/contract/fields';
import { LLM_TASKS } from '@/contract/llm-types';
import { GLOSSARY_STATUSES } from '@/contract/tools/glossary';
import { QUOTE_CATALOGS, QUOTE_LANGS, QUOTE_REPLY_SOURCES, QUOTE_STATUSES } from '@/contract/tools/quote';
import { closePool, getPool, withTx } from '@/server/db';
import { getDraft } from '@/server/repos/drafts';
import { receiveDoc } from '@/server/repos/source-docs';
import { dropWorkspaces, newWorkspace, T0 } from './helpers';

afterAll(async () => {
  await dropWorkspaces();
  await closePool();
});

async function checksOf(table: string): Promise<string> {
  const { rows } = await getPool().query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'c'`,
    [table],
  );
  return rows.map((r) => r.def).join(' ');
}

/** 되돌릴 트랜잭션 안에서 해 본다. 실패한 문장은 그 문장만 되돌린다. */
async function inRollback(run: (tryQuery: (sql: string, params?: unknown[]) => Promise<boolean>, wsId: string, one: (sql: string, params?: unknown[]) => Promise<string>) => Promise<void>) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const ws = await client.query<{ id: string }>(`INSERT INTO workspaces (kind) VALUES ('local') RETURNING id`);
    const tryQuery = async (sql: string, params: unknown[] = []) => {
      await client.query('SAVEPOINT s');
      try {
        await client.query(sql, params);
        return true;
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT s');
        return false;
      }
    };
    const one = async (sql: string, params: unknown[] = []) => String((await client.query<{ id: string }>(sql, params)).rows[0]?.id);
    await run(tryQuery, ws.rows[0]?.id as string, one);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('이행 0004', () => {
  it('닫힌 목록의 CHECK 가 약속의 목록과 같다', async () => {
    const source = await checksOf('source_docs');
    for (const kind of SOURCE_KINDS) expect(source).toContain(`'${kind}'`);
    const drafts = await checksOf('drafts');
    for (const by of EXTRACTED_BY) expect(drafts).toContain(`'${by}'`);
    const calls = await checksOf('llm_calls');
    for (const task of LLM_TASKS) expect(calls).toContain(`'${task}'`);
    const glossary = await checksOf('glossary_terms');
    for (const status of GLOSSARY_STATUSES) expect(glossary).toContain(`'${status}'`);
    const quotes = await checksOf('quotes');
    for (const value of [...QUOTE_LANGS, ...QUOTE_STATUSES, ...QUOTE_REPLY_SOURCES]) expect(quotes).toContain(`'${value}'`);
  });

  it('파일을 한 번 더 돌려도 오류가 없다', async () => {
    const sql = await readFile('db/migrations/0004_tools.sql', 'utf8');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(sql);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('이 이행은 정답 표를 건드리지 않는다', async () => {
    const sql = (await readFile('db/migrations/0004_tools.sql', 'utf8'))
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(sql).not.toMatch(/gold_docs|gold_reviews|eval_runs|eval_results/);
    expect(sql).not.toMatch(/\b(DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  });

  it('가져온 줄의 원문에는 파일 해시도 파일 이름도 없다. 그림·PDF 에는 여전히 해시가 꼭 있다', async () => {
    await inRollback(async (tryQuery, wsId) => {
      const insert = (hash: string, kind: string, fileHash: string | null, name: string | null) =>
        tryQuery(
          `INSERT INTO source_docs (workspace_id, clean_text, content_hash, source_kind, file_hash, origin_name) VALUES ($1, '글', $2, $3, $4, $5)`,
          [wsId, hash, kind, fileHash, name],
        );
      expect(await insert('m1', 'import', null, null)).toBe(true);
      expect(await insert('m2', 'import', 'f1', null)).toBe(false);
      expect(await insert('m3', 'import', null, '현황.csv')).toBe(false);
      expect(await insert('m4', 'image', null, null)).toBe(false);
      expect(await insert('m5', 'pdf', 'f2', '단가표.pdf')).toBe(true);
      expect(await insert('m6', 'crawl', null, null)).toBe(false);
    });
  });

  it('용어: 같은 공간에 같은 낱말은 한 줄이고, 승인된 줄에는 두 표기가 꼭 있다', async () => {
    await inRollback(async (tryQuery, wsId) => {
      const add = (ko: string, en: string | null, zh: string | null, status: string) =>
        tryQuery(`INSERT INTO glossary_terms (workspace_id, ko, en, zh_hans, status) VALUES ($1, $2, $3, $4, $5)`, [wsId, ko, en, zh, status]);
      expect(await add('포토존', null, null, 'proposed')).toBe(true);
      expect(await add('포토존', 'photo zone', '拍照区', 'approved')).toBe(false);
      expect(await add('응원봉', 'light stick', null, 'approved')).toBe(false);
      expect(await add('응원봉', 'light stick', '应援棒', 'approved')).toBe(true);
      expect(await add('현수막', 'banner', '横幅', 'done')).toBe(false);
      expect(await add('', 'x', 'y', 'proposed')).toBe(false);
      expect(await tryQuery(`UPDATE glossary_terms SET zh_hans = NULL WHERE workspace_id = $1 AND ko = '응원봉'`, [wsId])).toBe(false);
    });
  });

  it('견적: 확정에는 사람이 본 답장과 시각이 꼭 있고, 확정 전에는 없다', async () => {
    await inRollback(async (tryQuery, wsId) => {
      const add = (status: string, reply: string | null, at: string | null, lang = 'en') =>
        tryQuery(
          `INSERT INTO quotes (workspace_id, inquiry_text, lang, today, extraction, conditions, reply_template, reply_text, reply_source, reply_status, status, confirmed_reply, confirmed_at)
           VALUES ($1, 'Budget 3 million won near Hongdae', $2, '2026-10-12', '{}', '{}', 'Total {total}', 'Total KRW 2,800,000', 'llm', 'ok', $3, $4, $5)`,
          [wsId, lang, status, reply, at],
        );
      expect(await add('draft', null, null)).toBe(true);
      expect(await add('draft', '보냅니다', null)).toBe(false);
      expect(await add('confirmed', null, null)).toBe(false);
      expect(await add('confirmed', 'Total KRW 2,800,000', '2026-10-12T04:00:00Z')).toBe(true);
      expect(await add('sent', null, null)).toBe(false);
      expect(await add('draft', null, null, 'ja')).toBe(false);
    });
  });

  it('모으기: 묶음의 줄 수는 새 줄 + 중복 + 못 읽은 줄이고, 같은 공간에 같은 중복 열쇠는 한 건이다', async () => {
    await inRollback(async (tryQuery, wsId, one) => {
      const batch = (received: number, added: number, dup: number, bad: number) =>
        tryQuery(
          `INSERT INTO import_batches (workspace_id, source_id, source_name, source_url, license, fetched_at, rows_received, rows_new, rows_duplicate, rows_unreadable)
           VALUES ($1, 'sample-source', '가상 기관 옥외광고 현황', 'https://example.org/data.csv', '이용 조건 보기', '2026-10-12T03:00:00Z', $2, $3, $4, $5)`,
          [wsId, received, added, dup, bad],
        );
      expect(await batch(10, 7, 2, 1)).toBe(true);
      expect(await batch(10, 7, 2, 0)).toBe(false);
      const batchId = await one('SELECT id FROM import_batches WHERE workspace_id = $1', [wsId]);
      const item = (key: string, width: number | null = 7, lat: number | null = 37.5) =>
        tryQuery(
          `INSERT INTO collected_items (workspace_id, batch_id, source_id, source_line, name, width_m, height_m, lat, raw, dedupe_key)
           VALUES ($1, $2, 'sample-source', 1, '홍대입구역 전광판', $3, 12, $4, '{"명칭":"홍대입구역 전광판"}', $5)`,
          [wsId, batchId, width, lat, key],
        );
      expect(await item('a|b')).toBe(true);
      expect(await item('a|b')).toBe(false);
      expect(await item('a|c', 0)).toBe(false);
      expect(await item('a|d', null, 137)).toBe(false);
      expect(await item('a|e', null, null)).toBe(true);
      // 다른 공간이면 같은 열쇠도 들어간다.
      const other = await one(`INSERT INTO workspaces (kind) VALUES ('local') RETURNING id`);
      const otherBatch = await one(
        `INSERT INTO import_batches (workspace_id, source_id, source_name, source_url, license, fetched_at) VALUES ($1, 's', 'n', 'https://example.org', 'l', now()) RETURNING id`,
        [other],
      );
      expect(await tryQuery(`INSERT INTO collected_items (workspace_id, batch_id, source_id, source_line, raw, dedupe_key) VALUES ($1, $2, 's', 1, '{}', 'a|b')`, [other, otherBatch])).toBe(true);
    });
  });

  it('공간을 지우면 용어·견적·묶음·모은 줄이 함께 지워진다', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const ws = (await client.query<{ id: string }>(`INSERT INTO workspaces (kind) VALUES ('sandbox') RETURNING id`)).rows[0]?.id;
      await client.query(`INSERT INTO glossary_terms (workspace_id, ko) VALUES ($1, '포토존')`, [ws]);
      const batch = await client.query<{ id: string }>(
        `INSERT INTO import_batches (workspace_id, source_id, source_name, source_url, license, fetched_at) VALUES ($1, 's', 'n', 'https://example.org', 'l', now()) RETURNING id`,
        [ws],
      );
      await client.query(`INSERT INTO collected_items (workspace_id, batch_id, source_id, source_line, raw, dedupe_key) VALUES ($1, $2, 's', 1, '{}', 'k')`, [ws, batch.rows[0]?.id]);
      await client.query(
        `INSERT INTO quotes (workspace_id, inquiry_text, lang, today, extraction, conditions, reply_template, reply_text, reply_source, reply_status)
         VALUES ($1, '문의', 'ko', '2026-10-12', '{}', '{}', 't', 't', 'template', 'needs_review')`,
        [ws],
      );
      await client.query('DELETE FROM workspaces WHERE id = $1', [ws]);
      for (const table of ['glossary_terms', 'import_batches', 'collected_items', 'quotes']) {
        const left = await client.query(`SELECT 1 FROM ${table} WHERE workspace_id = $1`, [ws]);
        expect(left.rowCount).toBe(0);
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('가져온 줄 받기(receiveDoc)', () => {
  it('원문 종류가 import 로 남고 뽑기 작업을 줄에 넣지 않는다', async () => {
    const ws = await newWorkspace();
    const text = '출처: sample-source #3\n이름: 홍대입구역 9번 출구 전광판\n크기: 7x12m';
    const doc = await withTx((client) => receiveDoc(client, { workspaceId: ws, clean: text, hash: 'import-hash-1', imported: true, now: T0 }));
    expect(doc).toMatchObject({ status: 'PROCESSING', duplicate: false });
    const source = await getPool().query<{ source_kind: string; file_hash: string | null }>('SELECT source_kind, file_hash FROM source_docs WHERE id = $1', [doc.sourceDocId]);
    expect(source.rows[0]).toEqual({ source_kind: 'import', file_hash: null });
    const jobs = await getPool().query(`SELECT 1 FROM jobs WHERE kind = 'extract' AND ref_id = $1`, [doc.draftId]);
    expect(jobs.rowCount).toBe(0);
    expect((await getDraft(getPool(), ws, doc.draftId))?.status).toBe('PROCESSING');
    // 같은 글을 다시 받으면 있던 건을 돌려준다.
    const again = await withTx((client) => receiveDoc(client, { workspaceId: ws, clean: text, hash: 'import-hash-1', imported: true, now: T0 }));
    expect(again).toMatchObject({ draftId: doc.draftId, duplicate: true });
  });

  it('뽑은 방식 import 가 초안에 남는다', async () => {
    const ws = await newWorkspace();
    const doc = await withTx((client) => receiveDoc(client, { workspaceId: ws, clean: '출처: sample-source #4\n이름: 합정역 전광판', hash: 'import-hash-2', imported: true, now: T0 }));
    await getPool().query(`UPDATE drafts SET extracted_by = 'import' WHERE id = $1`, [doc.draftId]);
    expect((await getDraft(getPool(), ws, doc.draftId))?.extractedBy).toBe('import');
    await expect(getPool().query(`UPDATE drafts SET extracted_by = 'crawl' WHERE id = $1`, [doc.draftId])).rejects.toThrow(/check/i);
  });
});

describe('이행 0005', () => {
  it('견적이 살핀 상품의 자리(catalog)의 CHECK 가 약속의 목록과 같고, 전에 있던 줄은 own 이다', async () => {
    const quotes = await checksOf('quotes');
    for (const value of QUOTE_CATALOGS) expect(quotes).toContain(`'${value}'`);
    const { rows } = await getPool().query<{ column_default: string; is_nullable: string }>(
      `SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'quotes' AND column_name = 'catalog'`,
    );
    expect(rows[0]?.is_nullable).toBe('NO');
    expect(rows[0]?.column_default).toContain("'own'");
  });

  it('파일을 한 번 더 돌려도 오류가 없다', async () => {
    const sql = await readFile('db/migrations/0005_quote_catalog.sql', 'utf8');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
