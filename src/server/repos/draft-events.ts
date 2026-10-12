// 변경 기록. 추가만 한다. 이 표를 고치거나 지우는 문장은 어디에도 두지 않는다(시험이 본다).
// 상태 변경·칸 고침과 같은 트랜잭션에서 쓴다. action = 'edit' 줄이 곧 "사람이 고친 값 = 정답 후보"다.
import type { EventAction, EventActor } from '@/contract/api';
import type { FieldKey, FieldValue } from '@/contract/fields';
import type { DraftStatus } from '@/contract/transitions';
import { toId, type Db } from '../types';

export interface DraftEvent {
  id: number;
  draftId: number;
  actor: EventActor;
  action: EventAction;
  from: DraftStatus | null;
  to: DraftStatus | null;
  field: string | null;
  before: unknown;
  after: unknown;
  reasonCode: string | null;
  at: Date;
}

interface EventRow {
  id: string;
  draft_id: string;
  actor: EventActor;
  action: EventAction;
  from_status: DraftStatus | null;
  to_status: DraftStatus | null;
  field: string | null;
  before: unknown;
  after: unknown;
  reason_code: string | null;
  created_at: Date;
}

const toEvent = (r: EventRow): DraftEvent => ({
  id: toId(r.id),
  draftId: toId(r.draft_id),
  actor: r.actor,
  action: r.action,
  from: r.from_status,
  to: r.to_status,
  field: r.field,
  before: r.before,
  after: r.after,
  reasonCode: r.reason_code,
  at: r.created_at,
});

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

export async function addStatusEvent(
  db: Db,
  e: { draftId: number; actor: EventActor; from: DraftStatus | null; to: DraftStatus; reasonCode?: string | null; now: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO draft_events (draft_id, actor, action, from_status, to_status, reason_code, created_at)
     VALUES ($1, $2, 'status', $3, $4, $5, $6)`,
    [e.draftId, e.actor, e.from, e.to, e.reasonCode ?? null, e.now],
  );
}

export async function addEditEvent(
  db: Db,
  e: { draftId: number; actor: EventActor; field: FieldKey; before: FieldValue | null; after: FieldValue | null; now: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO draft_events (draft_id, actor, action, field, before, after, created_at)
     VALUES ($1, $2, 'edit', $3, $4::jsonb, $5::jsonb, $6)`,
    [e.draftId, e.actor, e.field, json(e.before), json(e.after), e.now],
  );
}

export async function listEvents(db: Db, draftId: number): Promise<DraftEvent[]> {
  const { rows } = await db.query<EventRow>('SELECT * FROM draft_events WHERE draft_id = $1 ORDER BY id', [draftId]);
  return rows.map(toEvent);
}

/** 사람이 고친 값 한 줄(정답 후보). 내려받기에 쓴다. */
export interface Correction {
  draftId: number;
  sourceDocId: number;
  field: string;
  before: unknown;
  after: unknown;
  /** 그 칸의 원문 표현 */
  raw: string | null;
  at: Date;
}

export async function listCorrections(db: Db, workspaceId: string): Promise<Correction[]> {
  const { rows } = await db.query<{
    draft_id: string; source_doc_id: string; field: string; before: unknown; after: unknown; raw: string | null; created_at: Date;
  }>(
    `SELECT e.draft_id, d.source_doc_id, e.field, e.before, e.after, f.raw, e.created_at
       FROM draft_events e
       JOIN drafts d ON d.id = e.draft_id
       LEFT JOIN draft_fields f ON f.draft_id = e.draft_id AND f.field = e.field
      WHERE d.workspace_id = $1 AND e.action = 'edit'
      ORDER BY e.id`,
    [workspaceId],
  );
  return rows.map((r) => ({
    draftId: toId(r.draft_id),
    sourceDocId: toId(r.source_doc_id),
    field: r.field,
    before: r.before,
    after: r.after,
    raw: r.raw,
    at: r.created_at,
  }));
}
