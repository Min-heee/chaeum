// DB 시험이 함께 쓰는 도우미.
// 시험의 시계는 2001년이다. 낡은 공간 지우기가 다른 시험의 공간을 건드리지 않게 하려는 것이다.
import type { EvaluatedField } from '@/contract/core-api';
import type { DocType, FieldKey, FieldValue } from '@/contract/fields';
import type { DraftStatus } from '@/contract/transitions';
import { getPool, withTx } from '@/server/db';
import { intakeOne } from '@/server/intake';
import { saveFields, transitionDraft } from '@/server/repos/drafts';

export const T0 = new Date('2001-06-01T03:00:00Z');
export const at = (ms: number) => new Date(T0.getTime() + ms);

const made: string[] = [];
let serial = 0;

/** 시험용 공간 하나. 끝날 때 dropWorkspaces 가 지운다. */
export async function newWorkspace(kind: 'local' | 'sandbox' = 'local', lastWriteAt: Date = T0): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    'INSERT INTO workspaces (kind, created_at, last_write_at) VALUES ($1, $2, $2) RETURNING id',
    [kind, lastWriteAt],
  );
  const id = rows[0]?.id as string;
  made.push(id);
  return id;
}

export function track(workspaceId: string): string {
  made.push(workspaceId);
  return workspaceId;
}

export async function dropWorkspaces(): Promise<void> {
  if (made.length === 0) return;
  // 작업 줄은 공간에 묶여 있지 않다. 먼저 지우지 않으면 고아 작업이 남아 다른 시험이 집는다.
  await getPool().query(
    `DELETE FROM jobs j
      WHERE (j.kind = 'extract' AND j.ref_id IN (SELECT id FROM drafts WHERE workspace_id = ANY($1::uuid[])))
         OR (j.kind = 'content' AND j.ref_id IN (SELECT id FROM products WHERE workspace_id = ANY($1::uuid[])))`,
    [made],
  );
  await getPool().query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [made]);
  made.length = 0;
}

/** 서로 다른 글. */
export function sampleText(label = '글'): string {
  serial += 1;
  return `${label} ${serial}번. 응원 슬로건 200x600mm 반사 원단, 10장부터 장당 5,000원`;
}

export const field = (key: FieldKey, value: FieldValue | null): EvaluatedField => ({
  field: key,
  raw: value === null ? null : JSON.stringify(value),
  modelValue: value,
  codeValue: value,
  finalValue: value,
  evidence: null,
  reasons: [],
  editedByHuman: false,
});

export const GOODS_FIELDS: EvaluatedField[] = [
  field('name', '응원 슬로건'),
  field('price_krw', 5000),
  field('list_price_krw', 6000),
  field('vat_included', true),
  field('size_mm', { width: 200, height: 600 }),
  field('material', '반사 원단'),
  field('lead_time_days', null),
  field('min_order_qty', 10),
];

/** 접수한 뒤 따지기가 끝난 것처럼 만든 초안. version 은 2 다. */
export async function reviewableDraft(
  workspaceId: string,
  status: 'READY' | 'NEEDS_REVIEW' = 'READY',
  fields: EvaluatedField[] = GOODS_FIELDS,
  type: DocType = 'goods',
  subtype: string | null = '인쇄물',
): Promise<{ draftId: number; version: number }> {
  const doc = await intakeOne(sampleText(), { workspaceId, now: T0 });
  const draft = await withTx(async (client) => {
    await saveFields(client, doc.draftId, fields);
    return transitionDraft(client, {
      workspaceId, draftId: doc.draftId, to: status, expectedVersion: 1, actor: 'system',
      patch: { type, subtype, extractedBy: 'rules' }, now: T0,
    });
  });
  return { draftId: draft.id, version: draft.version };
}

/** 표에 직접 써서 아무 상태의 초안을 만든다(이동 표 시험용). */
export async function rawDraft(workspaceId: string, status: DraftStatus): Promise<number> {
  serial += 1;
  const pool = getPool();
  const doc = await pool.query<{ id: string }>(
    'INSERT INTO source_docs (workspace_id, clean_text, content_hash, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [workspaceId, `글 ${serial}`, `raw-${serial}-${status}`, T0],
  );
  const draft = await pool.query<{ id: string }>(
    `INSERT INTO drafts (workspace_id, source_doc_id, status, reject_code, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
    [workspaceId, doc.rows[0]?.id, status, status === 'REJECTED' ? 'OTHER' : null, T0],
  );
  return Number(draft.rows[0]?.id);
}

export async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(`SELECT count(*) AS n FROM ${sql}`, params);
  return Number(rows[0]?.n ?? 0);
}
