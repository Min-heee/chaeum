// 이행 0003(그림·PDF, 규칙만 길로 내려간 까닭)의 꼴을 본다. 시험용 DB 가 필요하다.
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { SOURCE_KINDS } from '@/contract/api';
import { LLM_TASKS } from '@/contract/llm-types';
import { LLM_SKIP_CAUSES } from '@/contract/reasons';
import { closePool, getPool } from '@/server/db';

afterAll(async () => {
  await closePool();
});

/** 표의 CHECK 정의를 한 글로 모은다. */
async function checksOf(table: string): Promise<string> {
  const { rows } = await getPool().query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'c'`,
    [table],
  );
  return rows.map((r) => r.def).join(' ');
}

/** 되돌릴 트랜잭션 안에서 해 본다. 실패한 문장은 그 문장만 되돌린다. */
async function inRollback(run: (tryQuery: (sql: string, params?: unknown[]) => Promise<boolean>, wsId: string) => Promise<void>) {
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
    await run(tryQuery, ws.rows[0]?.id as string);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('이행 0003', () => {
  it('닫힌 목록의 CHECK 가 약속의 목록과 같다', async () => {
    const source = await checksOf('source_docs');
    for (const kind of SOURCE_KINDS) expect(source).toContain(`'${kind}'`);
    const drafts = await checksOf('drafts');
    for (const cause of LLM_SKIP_CAUSES) expect(drafts).toContain(`'${cause}'`);
    const calls = await checksOf('llm_calls');
    for (const task of LLM_TASKS) expect(calls).toContain(`'${task}'`);
  });

  it('파일 한 번 더 돌려도 오류가 없다', async () => {
    const sql = await readFile('db/migrations/0003_files_and_live_llm.sql', 'utf8');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('붙여 넣은 글에는 파일 해시가 없고, 올린 파일에는 꼭 있다', async () => {
    await inRollback(async (tryQuery, wsId) => {
      const insert = (hash: string, kind: string | null, fileHash: string | null, name: string | null) =>
        tryQuery(
          `INSERT INTO source_docs (workspace_id, clean_text, content_hash, source_kind, file_hash, origin_name)
           VALUES ($1, '글', $2, COALESCE($3, 'text'), $4, $5)`,
          [wsId, hash, kind, fileHash, name],
        );
      expect(await insert('t1', null, null, null)).toBe(true);
      expect(await insert('t2', 'text', 'f0', null)).toBe(false);
      expect(await insert('t3', 'text', null, '단가표.png')).toBe(false);
      expect(await insert('i1', 'image', 'f1', '단가표.png')).toBe(true);
      expect(await insert('p1', 'pdf', 'f2', null)).toBe(true);
      expect(await insert('i2', 'image', null, null)).toBe(false);
      expect(await insert('g1', 'gif', 'f3', null)).toBe(false);
      // 같은 공간에 같은 파일 두 번은 안 된다(옮긴 글이 달라도).
      expect(await insert('i3', 'image', 'f1', null)).toBe(false);
    });
  });

  it('규칙만으로 뽑은 초안에는 원인만 남고 호출 기록은 없다', async () => {
    await inRollback(async (tryQuery, wsId) => {
      const draft = (hash: string, cause: string | null, recorded: boolean | null) =>
        tryQuery(
          `WITH doc AS (INSERT INTO source_docs (workspace_id, clean_text, content_hash) VALUES ($1, '글', $2) RETURNING id)
           INSERT INTO drafts (workspace_id, source_doc_id, llm_skip_cause, llm_recorded, llm_latency_ms, llm_cost_usd)
           SELECT $1, id, $3, $4, CASE WHEN $4::boolean IS NULL THEN NULL ELSE 1200 END, CASE WHEN $4::boolean IS NULL THEN NULL ELSE 0.0009 END FROM doc`,
          [wsId, hash, cause, recorded],
        );
      expect(await draft('d1', null, null)).toBe(true);
      expect(await draft('d2', 'daily_cap', null)).toBe(true);
      expect(await draft('d3', null, true)).toBe(true);
      expect(await draft('d4', 'busy', null)).toBe(false);
      expect(await draft('d5', 'off', false)).toBe(false);
    });
  });

  it('장부에 글로 옮기기 줄이 들어간다. 작업 줄의 종류는 그대로 둘이다', async () => {
    await inRollback(async (tryQuery) => {
      const call = (task: string) =>
        tryQuery(`INSERT INTO llm_calls (task, provider, model, prompt_version, cache_key) VALUES ($1, 'fake', 'm', 'p', 'k')`, [task]);
      expect(await call('transcribe')).toBe(true);
      expect(await call('translate')).toBe(false);
      const job = (kind: string) => tryQuery(`INSERT INTO jobs (kind, ref_id, run_at) VALUES ($1, 987654321, now())`, [kind]);
      expect(await job('extract')).toBe(true);
      expect(await job('transcribe')).toBe(false);
    });
  });
});
