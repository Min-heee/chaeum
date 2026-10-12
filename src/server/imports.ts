// 모으기: 수집기가 정리해 보낸 줄 묶음을 받는다. 꼴은 docs/IMPORT-FORMAT.md 와 src/contract/tools/collect.ts 에 있다.
// 줄의 꼴·중복 열쇠·표시는 순수 함수(src/tools/collect 의 checkImportRow)가 정하고, 여기서는 상한을 보고 표에 쓴다.
// 같은 공간의 받기는 공간 줄을 잠가 한 줄로 선다. 그래서 같은 열쇠가 동시에 와도 한 건만 들어간다(표의 유일 제약이 한 번 더 막는다).
import type { Pool, PoolClient } from 'pg';
import { PUBLIC_WORKSPACE_ID } from '@/contract/api';
import {
  COLLECT_LIMITS,
  ImportRequestSchema,
  type ImportBatch,
  type ImportItem,
  type ImportListResponse,
  type ImportRequest,
  type ImportResponse,
} from '@/contract/tools/collect';
import { checkImportRow } from '@/tools/collect';
import collectedSample from '../../data/seed/collected-sample.json';
import { getPool, withTx } from './db';
import { AppError } from './errors';
import { toId, type Db } from './types';
import { workspaceForWrite } from './workspace';

interface BatchRow {
  id: string;
  source_id: string;
  source_name: string;
  source_url: string;
  license: string;
  fetched_at: Date;
  rows_received: number;
  rows_new: number;
  rows_duplicate: number;
  rows_unreadable: number;
  collector_unreadable: number;
  collector_duplicates: number;
  received_at: Date;
}

const toBatch = (r: BatchRow): ImportBatch => ({
  id: toId(r.id),
  source: { id: r.source_id, name: r.source_name, url: r.source_url, license: r.license, fetchedAt: r.fetched_at.toISOString() },
  received: r.rows_received,
  new: r.rows_new,
  duplicate: r.rows_duplicate,
  unreadable: r.rows_unreadable,
  collectorUnreadable: r.collector_unreadable,
  collectorDuplicates: r.collector_duplicates,
  receivedAt: r.received_at.toISOString(),
});

async function count(db: Db, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/**
 * 줄 묶음 하나를 받는다. 줄마다 결과(new / duplicate / error)를 돌려준다. 한 줄이 틀려도 나머지는 들어간다.
 * 한 줄도 못 넣었어도 묶음은 남는다(무엇을 받았다가 못 넣었는지가 기록이다).
 * 요청 전체를 거절하는 경우: 본보기 공간(403), 공간의 묶음 수 상한(429), 받은 곳 주소가 http(s) 가 아님(400).
 */
export async function receiveImport(request: ImportRequest, options: { workspaceId: string | null; now: Date }): Promise<ImportResponse> {
  const { source } = request;
  const { now } = options;
  // 주소는 화면에 나온다. 눌러서 열리는 주소가 될 수 있는 것은 http(s) 뿐이다.
  if (!/^https?:\/\//i.test(source.url)) throw new AppError('BAD_INPUT', '출처의 주소(source.url)는 http 또는 https 로 시작해야 합니다.');

  // 꼴 검사는 DB 를 열기 전에 끝낸다.
  const checked = request.rows.map((row) => checkImportRow(row));

  return withTx(async (client) => {
    const workspace = await workspaceForWrite(client, options.workspaceId, now);
    return storeImport(client, workspace.id, request, checked, now);
  });
}

/** 꼴을 본 줄 묶음을 한 공간에 쓴다. 부르는 쪽의 트랜잭션 안에서 돈다(공간을 쓸 수 있는지는 부르는 쪽이 먼저 본다). */
async function storeImport(
  client: PoolClient,
  workspaceId: string,
  request: ImportRequest,
  checked: ReturnType<typeof checkImportRow>[],
  now: Date,
): Promise<ImportResponse> {
  const { source } = request;
  const workspace = { id: workspaceId };
  {
    const batches = await count(client, 'SELECT count(*) AS n FROM import_batches WHERE workspace_id = $1', [workspace.id]);
    if (batches >= COLLECT_LIMITS.batchesPerWorkspace) {
      throw new AppError('LIMIT_EXCEEDED', `한 공간에는 받은 묶음을 ${COLLECT_LIMITS.batchesPerWorkspace}개까지 둘 수 있습니다.`);
    }

    const batch = await client.query<{ id: string }>(
      `INSERT INTO import_batches (workspace_id, source_id, source_name, source_url, license, fetched_at,
                                   collector_unreadable, collector_duplicates, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [workspace.id, source.id, source.name, source.url, source.license, new Date(source.fetchedAt),
        request.collector?.unreadable ?? 0, request.collector?.duplicates ?? 0, now],
    );
    const batchId = toId(batch.rows[0]?.id as string);

    // 이미 있는 줄을 한 번에 찾아 둔다. 이번 요청에서 새로 넣은 줄도 여기에 더해 뒷줄의 중복을 가른다.
    const keys = checked.flatMap((c) => (c.ok ? [c.dedupeKey] : []));
    const existing = await client.query<{ id: string; dedupe_key: string }>(
      'SELECT id, dedupe_key FROM collected_items WHERE workspace_id = $1 AND dedupe_key = ANY($2::text[])',
      [workspace.id, keys],
    );
    const known = new Map(existing.rows.map((r) => [r.dedupe_key, toId(r.id)]));
    let stored = await count(client, 'SELECT count(*) AS n FROM collected_items WHERE workspace_id = $1', [workspace.id]);

    const items: ImportItem[] = [];
    const tally = { new: 0, duplicate: 0, unreadable: 0 };
    for (const [index, c] of checked.entries()) {
      if (!c.ok) {
        items.push({ index, result: 'error', code: 'BAD_ROW', message: c.message });
        tally.unreadable += 1;
        continue;
      }
      const { row } = c;
      const had = known.get(c.dedupeKey);
      if (had !== undefined) {
        items.push({ index, line: row.line, result: 'duplicate', itemId: had });
        tally.duplicate += 1;
        continue;
      }
      if (stored >= COLLECT_LIMITS.itemsPerWorkspace) {
        const message = `한 공간에는 모은 줄을 ${COLLECT_LIMITS.itemsPerWorkspace.toLocaleString('ko-KR')}줄까지 둘 수 있습니다.`;
        items.push({ index, result: 'error', code: 'LIMIT_EXCEEDED', message });
        tally.unreadable += 1;
        continue;
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO collected_items (workspace_id, batch_id, source_id, source_line, kind, name, region, address, subway_line, station,
                                      media_type, width_m, height_m, quantity, lat, lng, operator, raw, dedupe_key, flags, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21)
         ON CONFLICT (workspace_id, dedupe_key) DO NOTHING RETURNING id`,
        [workspace.id, batchId, source.id, row.line, row.kind, row.name, row.region, row.address, row.subway_line, row.station,
          row.media_type, row.width_m, row.height_m, row.quantity, row.lat, row.lng, row.operator, JSON.stringify(row.raw), c.dedupeKey, c.flags, now],
      );
      const insertedRow = inserted.rows[0];
      if (!insertedRow) throw new Error('모은 줄을 넣지 못했다');
      const itemId = toId(insertedRow.id);
      known.set(c.dedupeKey, itemId);
      stored += 1;
      items.push({ index, line: row.line, result: 'new', itemId });
      tally.new += 1;
    }

    const done = await client.query<BatchRow>(
      `UPDATE import_batches SET rows_received = $2, rows_new = $3, rows_duplicate = $4, rows_unreadable = $5
        WHERE id = $1 RETURNING *`,
      [batchId, checked.length, tally.new, tally.duplicate, tally.unreadable],
    );
    const doneRow = done.rows[0];
    if (!doneRow) throw new Error('받은 묶음을 적지 못했다');
    return { workspace: workspace.id, batch: toBatch(doneRow), items };
  }
}

/**
 * 본보기 묶음(data/seed/collected-sample.json)을 본보기 공간에 싣는다. 씨앗만 부른다. 두 번 불러도 한 번만 실린다.
 * 본보기 공간은 방문자에게 읽기 전용이라 받기 경로(403)가 아니라 여기서 직접 쓴다. 줄의 꼴·중복 열쇠·표시는 받기와 같은 함수가 정한다.
 */
export async function seedCollectedSample(pool: Pool, now: Date): Promise<{ added: number; kept: number }> {
  const request = ImportRequestSchema.parse({ source: collectedSample.source, rows: collectedSample.rows });
  const had = await count(pool, 'SELECT count(*) AS n FROM import_batches WHERE workspace_id = $1 AND source_id = $2', [PUBLIC_WORKSPACE_ID, request.source.id]);
  if (had > 0) return { added: 0, kept: request.rows.length };
  const checked = request.rows.map((row) => checkImportRow(row));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const done = await storeImport(client, PUBLIC_WORKSPACE_ID, request, checked, now);
    await client.query('COMMIT');
    return { added: done.batch.new, kept: done.batch.duplicate };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** 받은 묶음 목록(새것부터)과 합계. 다른 공간의 것은 섞이지 않는다. */
export async function listImports(workspaceId: string, db: Db = getPool()): Promise<ImportListResponse> {
  const { rows } = await db.query<BatchRow>('SELECT * FROM import_batches WHERE workspace_id = $1 ORDER BY id DESC', [workspaceId]);
  const batches = rows.map(toBatch);
  const sum = (pick: (b: ImportBatch) => number) => batches.reduce((total, b) => total + pick(b), 0);
  const stored = await db.query<{ items: string; drafted: string }>(
    'SELECT count(*) AS items, count(draft_id) AS drafted FROM collected_items WHERE workspace_id = $1',
    [workspaceId],
  );
  return {
    batches,
    totals: {
      sources: new Set(batches.map((b) => b.source.id)).size,
      received: sum((b) => b.received),
      new: sum((b) => b.new),
      duplicate: sum((b) => b.duplicate),
      unreadable: sum((b) => b.unreadable),
      collectorUnreadable: sum((b) => b.collectorUnreadable),
      collectorDuplicates: sum((b) => b.collectorDuplicates),
      items: Number(stored.rows[0]?.items ?? 0),
      drafted: Number(stored.rows[0]?.drafted ?? 0),
    },
  };
}
