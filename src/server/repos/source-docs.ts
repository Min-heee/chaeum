// 원문 접수. 원문 1줄 + 초안 1줄(PROCESSING) + 작업 1줄을 부르는 쪽의 한 트랜잭션에 쓴다.
// 같은 공간에 같은 글(해시가 같음)이 오면 새로 만들지 않고 있던 건을 돌려준다.
import type { SourceKind } from '@/contract/api';
import type { DraftStatus } from '@/contract/transitions';
import { enqueue } from '../queue';
import { toId, type Db } from '../types';
import { addStatusEvent } from './draft-events';

export interface ReceivedDoc {
  sourceDocId: number;
  draftId: number;
  status: DraftStatus;
  duplicate: boolean;
}

/** 같은 글이 이미 있는지 본다. */
export async function findByHash(db: Db, workspaceId: string, hash: string): Promise<ReceivedDoc | null> {
  const { rows } = await db.query<{ source_doc_id: string; draft_id: string; status: DraftStatus }>(
    `SELECT s.id AS source_doc_id, d.id AS draft_id, d.status
       FROM source_docs s JOIN drafts d ON d.source_doc_id = s.id
      WHERE s.workspace_id = $1 AND s.content_hash = $2`,
    [workspaceId, hash],
  );
  const row = rows[0];
  return row ? { sourceDocId: toId(row.source_doc_id), draftId: toId(row.draft_id), status: row.status, duplicate: true } : null;
}

/** 같은 파일(파일 바이트의 해시)이 이미 있는지 본다. 모델을 부르기 전에 이것으로 먼저 찾는다. */
export async function findByFileHash(db: Db, workspaceId: string, fileHash: string): Promise<(ReceivedDoc & { chars: number }) | null> {
  const { rows } = await db.query<{ source_doc_id: string; draft_id: string; status: DraftStatus; chars: number }>(
    `SELECT s.id AS source_doc_id, d.id AS draft_id, d.status, length(s.clean_text) AS chars
       FROM source_docs s JOIN drafts d ON d.source_doc_id = s.id
      WHERE s.workspace_id = $1 AND s.file_hash = $2`,
    [workspaceId, fileHash],
  );
  const row = rows[0];
  if (!row) return null;
  return { sourceDocId: toId(row.source_doc_id), draftId: toId(row.draft_id), status: row.status, duplicate: true, chars: row.chars };
}

/** 올린 파일에서 온 글이면 붙는 것. 파일 자체는 어디에도 저장하지 않는다. */
export interface FileOrigin {
  kind: Exclude<SourceKind, 'text'>;
  originName: string | null;
  fileHash: string;
}

/**
 * 정리된 글 한 건을 받는다. 트랜잭션 안에서 부른다(셋이 함께 들어가거나 함께 안 들어간다).
 * 같은 글을 둘이 동시에 넣어도 UNIQUE 가 하나만 남기고, 진 쪽은 있던 건을 돌려받는다.
 */
export async function receiveDoc(
  db: Db,
  input: { workspaceId: string; clean: string; hash: string; batchNo?: number | null; file?: FileOrigin; now: Date },
): Promise<ReceivedDoc> {
  const { workspaceId, clean, hash, now } = input;
  const doc = await db.query<{ id: string }>(
    `INSERT INTO source_docs (workspace_id, clean_text, content_hash, batch_no, created_at, source_kind, origin_name, file_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workspace_id, content_hash) DO NOTHING RETURNING id`,
    [workspaceId, clean, hash, input.batchNo ?? null, now, input.file?.kind ?? 'text', input.file?.originName ?? null, input.file?.fileHash ?? null],
  );
  const docRow = doc.rows[0];
  if (!docRow) {
    const existing = await findByHash(db, workspaceId, hash);
    if (!existing) throw new Error('같은 글이 있다는데 찾지 못했다');
    return existing;
  }

  const sourceDocId = toId(docRow.id);
  const draft = await db.query<{ id: string }>(
    `INSERT INTO drafts (workspace_id, source_doc_id, status, created_at, updated_at)
     VALUES ($1, $2, 'PROCESSING', $3, $3) RETURNING id`,
    [workspaceId, sourceDocId, now],
  );
  const draftRow = draft.rows[0];
  if (!draftRow) throw new Error('초안을 만들지 못했다');
  const draftId = toId(draftRow.id);

  await addStatusEvent(db, { draftId, actor: 'system', from: null, to: 'PROCESSING', now });
  await enqueue(db, 'extract', draftId, now);
  return { sourceDocId, draftId, status: 'PROCESSING', duplicate: false };
}

/** 공간의 다음 묶음 번호(여러 건을 한 번에 넣을 때 붙인다). */
export async function nextBatchNo(db: Db, workspaceId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    'SELECT COALESCE(max(batch_no), 0) + 1 AS n FROM source_docs WHERE workspace_id = $1',
    [workspaceId],
  );
  return rows[0]?.n ?? 1;
}

export interface SourceDoc {
  id: number;
  kind: SourceKind;
  originName: string | null;
  text: string;
}

/** 원문 한 건. 공간을 보지 않는다. 공간을 확인한 초안의 원문 번호로만 부른다. */
export async function getSource(db: Db, sourceDocId: number): Promise<SourceDoc | null> {
  const { rows } = await db.query<{ id: string; source_kind: SourceKind; origin_name: string | null; clean_text: string }>(
    'SELECT id, source_kind, origin_name, clean_text FROM source_docs WHERE id = $1',
    [sourceDocId],
  );
  const row = rows[0];
  return row ? { id: toId(row.id), kind: row.source_kind, originName: row.origin_name, text: row.clean_text } : null;
}

export async function getSourceText(db: Db, sourceDocId: number): Promise<string | null> {
  return (await getSource(db, sourceDocId))?.text ?? null;
}
