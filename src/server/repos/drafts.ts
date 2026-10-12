// 초안: 조회, 목록, 칸 저장, 조건부 상태 변경.
//
// 상태를 바꾸는 문장은 하나뿐이다:
//   UPDATE drafts SET … version = version + 1 WHERE id = … AND status = … AND version = …
// 0줄이면 그사이 누가 먼저 바꾼 것이다(409). 어디로 갈 수 있는지는 약속의 이동 표만 본다.
import type { PoolClient } from 'pg';
import { LIMITS, type EventActor, type SourceKind } from '@/contract/api';
import type { EvaluatedField } from '@/contract/core-api';
import { DOC_TYPES, FIELD_KEYS, type DocType, type ExtractedBy, type FieldKey, type FieldValue } from '@/contract/fields';
import { isReasonCode, REJECT_CODES, type LlmSkipCause, type ReasonCode, type RejectCode } from '@/contract/reasons';
import { canTransition, isDraftStatus, STATUS_LABELS, type DraftStatus } from '@/contract/transitions';
import { AppError } from '../errors';
import { toId, type Db } from '../types';
import { addStatusEvent, listEvents, type DraftEvent } from './draft-events';
import { getSource, type SourceDoc } from './source-docs';

export interface Draft {
  id: number;
  workspaceId: string;
  sourceDocId: number;
  status: DraftStatus;
  version: number;
  type: DocType | null;
  subtype: string | null;
  reasons: ReasonCode[];
  rejectCode: RejectCode | null;
  rejectMemo: string | null;
  promptVersion: string | null;
  model: string | null;
  extractedBy: ExtractedBy | null;
  /** 규칙만 길로 내려간 까닭. LLM 으로 뽑았거나 아직 처리 중이면 null. */
  llmSkipCause: LlmSkipCause | null;
  /** LLM 으로 뽑았을 때만 값이 있다: 장부에서 꺼낸 답인가, 그 답을 받을 때 잰 시간과 비용. */
  llmRecorded: boolean | null;
  llmLatencyMs: number | null;
  llmCostUsd: number | null;
  createdAt: Date;
  updatedAt: Date;
}

interface DraftRow {
  id: string;
  workspace_id: string;
  source_doc_id: string;
  status: DraftStatus;
  version: number;
  type: DocType | null;
  subtype: string | null;
  reasons: ReasonCode[];
  reject_code: RejectCode | null;
  reject_memo: string | null;
  prompt_version: string | null;
  model: string | null;
  extracted_by: ExtractedBy | null;
  llm_skip_cause: LlmSkipCause | null;
  llm_recorded: boolean | null;
  llm_latency_ms: number | null;
  llm_cost_usd: string | null;
  created_at: Date;
  updated_at: Date;
}

const toDraft = (r: DraftRow): Draft => ({
  id: toId(r.id),
  workspaceId: r.workspace_id,
  sourceDocId: toId(r.source_doc_id),
  status: r.status,
  version: r.version,
  type: r.type,
  subtype: r.subtype,
  reasons: r.reasons,
  rejectCode: r.reject_code,
  rejectMemo: r.reject_memo,
  promptVersion: r.prompt_version,
  model: r.model,
  extractedBy: r.extracted_by,
  llmSkipCause: r.llm_skip_cause,
  llmRecorded: r.llm_recorded,
  llmLatencyMs: r.llm_latency_ms,
  llmCostUsd: r.llm_cost_usd === null ? null : Number(r.llm_cost_usd),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

// ── 조회 ───────────────────────────────────────────────────

/** 공간 안의 초안 하나. 다른 공간의 초안은 없는 것으로 본다. */
export async function getDraft(db: Db, workspaceId: string, draftId: number): Promise<Draft | null> {
  const { rows } = await db.query<DraftRow>('SELECT * FROM drafts WHERE id = $1 AND workspace_id = $2', [draftId, workspaceId]);
  return rows[0] ? toDraft(rows[0]) : null;
}

/**
 * 번호만으로 찾는다. 작업 줄의 처리기가 쓴다(작업에는 공간 번호가 없다).
 * 공간을 보지 않는다. 화면·API 길에서는 쓰지 않는다(getDraft, getDraftDetail 을 쓴다).
 */
export async function getDraftById(db: Db, draftId: number): Promise<Draft | null> {
  const { rows } = await db.query<DraftRow>('SELECT * FROM drafts WHERE id = $1', [draftId]);
  return rows[0] ? toDraft(rows[0]) : null;
}

interface FieldRow {
  field: string;
  raw: string | null;
  model_value: FieldValue | null;
  code_value: FieldValue | null;
  final_value: FieldValue | null;
  evidence: string | null;
  reasons: ReasonCode[];
  edited_by_human: boolean;
}

/** 초안의 칸들. 약속의 칸 순서대로. 공간을 보지 않으므로 getDraft 로 공간을 확인한 뒤에 부른다. */
export async function listFields(db: Db, draftId: number): Promise<EvaluatedField[]> {
  const { rows } = await db.query<FieldRow>('SELECT * FROM draft_fields WHERE draft_id = $1', [draftId]);
  const order = (f: string) => FIELD_KEYS.indexOf(f as FieldKey);
  return rows
    .filter((r) => order(r.field) >= 0)
    .sort((a, b) => order(a.field) - order(b.field))
    .map((r) => ({
      field: r.field as FieldKey,
      raw: r.raw,
      modelValue: r.model_value,
      codeValue: r.code_value,
      finalValue: r.final_value,
      evidence: r.evidence,
      reasons: r.reasons,
      editedByHuman: r.edited_by_human,
    }));
}

export interface DraftDetail {
  draft: Draft;
  sourceText: string;
  source: SourceDoc;
  fields: EvaluatedField[];
  events: DraftEvent[];
  /** 승인돼 상품이 됐으면 그 번호 */
  productId: number | null;
}

/** 화면 한 장에 필요한 것 전부: 원문 + 칸 + 상태 + 변경 기록. */
export async function getDraftDetail(db: Db, workspaceId: string, draftId: number): Promise<DraftDetail | null> {
  const draft = await getDraft(db, workspaceId, draftId);
  if (!draft) return null;
  const source = (await getSource(db, draft.sourceDocId)) ?? { id: draft.sourceDocId, kind: 'text' as const, originName: null, text: '' };
  const product = await db.query<{ id: string }>('SELECT id FROM products WHERE draft_id = $1 AND workspace_id = $2', [draftId, workspaceId]);
  return {
    draft,
    sourceText: source.text,
    source,
    fields: await listFields(db, draftId),
    events: await listEvents(db, draftId),
    productId: product.rows[0] ? toId(product.rows[0].id) : null,
  };
}

// ── 목록(검수함) ───────────────────────────────────────────

export interface DraftListFilter {
  status?: string;
  /** 초안이나 칸에 이 사유가 붙은 것만 */
  reason?: string;
  type?: string;
  /** 이 번호보다 앞(작은 번호)부터. 지난 쪽의 nextCursor 를 그대로 넘긴다. */
  cursor?: number;
  limit?: number;
}

export interface DraftListItem {
  id: number;
  status: DraftStatus;
  version: number;
  type: DocType | null;
  subtype: string | null;
  /** 상품 이름 칸의 값. 아직 없으면 null. */
  name: string | null;
  /** 초안 사유와 칸 사유를 합친 것(겹침 없이) */
  reasons: ReasonCode[];
  extractedBy: ExtractedBy | null;
  /** 글·그림·PDF 가운데 무엇으로 들어왔나 */
  sourceKind: SourceKind;
  /** 원문 앞머리 */
  preview: string;
  updatedAt: Date;
}

export async function listDrafts(
  db: Db,
  workspaceId: string,
  filter: DraftListFilter = {},
): Promise<{ items: DraftListItem[]; nextCursor: number | null }> {
  if (filter.status !== undefined && !isDraftStatus(filter.status)) throw new AppError('BAD_INPUT', '모르는 상태입니다.');
  if (filter.reason !== undefined && !isReasonCode(filter.reason)) throw new AppError('BAD_INPUT', '모르는 사유입니다.');
  if (filter.type !== undefined && !(DOC_TYPES as readonly string[]).includes(filter.type)) throw new AppError('BAD_INPUT', '모르는 종류입니다.');
  if (filter.cursor !== undefined && !(Number.isSafeInteger(filter.cursor) && filter.cursor > 0)) throw new AppError('BAD_INPUT', '쪽 번호가 틀렸습니다.');
  const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? LIMITS.pageSize)), 100);

  const { rows } = await db.query<{
    id: string; status: DraftStatus; version: number; type: DocType | null; subtype: string | null;
    name: unknown; all_reasons: ReasonCode[]; extracted_by: ExtractedBy | null; source_kind: SourceKind; preview: string; updated_at: Date;
  }>(
    `SELECT d.id, d.status, d.version, d.type, d.subtype, d.extracted_by, d.updated_at,
            (SELECT f.final_value FROM draft_fields f WHERE f.draft_id = d.id AND f.field = 'name') AS name,
            ARRAY(SELECT DISTINCT r FROM (
                    SELECT unnest(d.reasons) AS r
                    UNION ALL
                    SELECT unnest(f.reasons) FROM draft_fields f WHERE f.draft_id = d.id) x ORDER BY r) AS all_reasons,
            s.source_kind, left(s.clean_text, 80) AS preview
       FROM drafts d JOIN source_docs s ON s.id = d.source_doc_id
      WHERE d.workspace_id = $1
        AND ($2::text IS NULL OR d.status = $2)
        AND ($3::text IS NULL OR d.type = $3)
        AND ($4::text IS NULL OR $4 = ANY(d.reasons)
             OR EXISTS (SELECT 1 FROM draft_fields f WHERE f.draft_id = d.id AND $4 = ANY(f.reasons)))
        AND ($5::bigint IS NULL OR d.id < $5)
      ORDER BY d.id DESC
      LIMIT $6`,
    [workspaceId, filter.status ?? null, filter.type ?? null, filter.reason ?? null, filter.cursor ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const items = page.map((r) => ({
    id: toId(r.id),
    status: r.status,
    version: r.version,
    type: r.type,
    subtype: r.subtype,
    name: typeof r.name === 'string' ? r.name : null,
    reasons: r.all_reasons,
    extractedBy: r.extracted_by,
    sourceKind: r.source_kind,
    preview: r.preview,
    updatedAt: r.updated_at,
  }));
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? last.id : null };
}

/** 상태별 건수(검수함 머리의 숫자). */
export async function countByStatus(db: Db, workspaceId: string): Promise<Record<DraftStatus, number>> {
  const { rows } = await db.query<{ status: DraftStatus; n: string }>(
    'SELECT status, count(*) AS n FROM drafts WHERE workspace_id = $1 GROUP BY status',
    [workspaceId],
  );
  const counts: Record<DraftStatus, number> = { PROCESSING: 0, NEEDS_REVIEW: 0, READY: 0, FAILED: 0, APPROVED: 0, REJECTED: 0 };
  for (const r of rows) counts[r.status] = Number(r.n);
  return counts;
}

// ── 칸 저장 ────────────────────────────────────────────────

/**
 * 칸들을 통째로 바꿔 쓴다. 목록에 없는 칸은 지운다(종류가 바뀌면 칸이 달라진다).
 * 공간을 보지 않는다. 같은 트랜잭션에서 transitionDraft·reviseDraft(공간 조건이 있다)가 성공한 뒤에만 부른다.
 */
export async function saveFields(db: Db, draftId: number, fields: readonly EvaluatedField[]): Promise<void> {
  await db.query('DELETE FROM draft_fields WHERE draft_id = $1 AND NOT (field = ANY($2::text[]))', [
    draftId,
    fields.map((f) => f.field),
  ]);
  for (const f of fields) {
    await db.query(
      `INSERT INTO draft_fields (draft_id, field, raw, model_value, code_value, final_value, evidence, reasons, edited_by_human)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9)
       ON CONFLICT (draft_id, field) DO UPDATE
         SET raw = EXCLUDED.raw, model_value = EXCLUDED.model_value, code_value = EXCLUDED.code_value,
             final_value = EXCLUDED.final_value, evidence = EXCLUDED.evidence, reasons = EXCLUDED.reasons,
             edited_by_human = EXCLUDED.edited_by_human`,
      [draftId, f.field, f.raw, json(f.modelValue), json(f.codeValue), json(f.finalValue), f.evidence, f.reasons, f.editedByHuman],
    );
  }
}

// ── 조건부 변경 ────────────────────────────────────────────

/** 상태와 함께 바꿀 수 있는 열. 적지 않은 열은 그대로 둔다. */
export interface DraftPatch {
  type?: DocType | null;
  subtype?: string | null;
  reasons?: ReasonCode[];
  rejectCode?: RejectCode | null;
  rejectMemo?: string | null;
  promptVersion?: string | null;
  model?: string | null;
  extractedBy?: ExtractedBy | null;
  llmSkipCause?: LlmSkipCause | null;
  llmRecorded?: boolean | null;
  llmLatencyMs?: number | null;
  llmCostUsd?: number | null;
}

const PATCH_COLUMNS: Record<keyof DraftPatch, string> = {
  type: 'type',
  subtype: 'subtype',
  reasons: 'reasons',
  rejectCode: 'reject_code',
  rejectMemo: 'reject_memo',
  promptVersion: 'prompt_version',
  model: 'model',
  extractedBy: 'extracted_by',
  llmSkipCause: 'llm_skip_cause',
  llmRecorded: 'llm_recorded',
  llmLatencyMs: 'llm_latency_ms',
  llmCostUsd: 'llm_cost_usd',
};

/** 한 문장으로 바꾼다. 조건(번호·공간·상태·version)이 안 맞으면 null. */
async function conditionalUpdate(
  db: Db,
  where: { workspaceId: string; draftId: number; status: DraftStatus; version: number },
  toStatus: DraftStatus,
  patch: DraftPatch,
  now: Date,
): Promise<Draft | null> {
  const params: unknown[] = [where.draftId, where.workspaceId, where.status, where.version, toStatus, now];
  const sets = ['status = $5', 'version = version + 1', 'updated_at = $6'];
  for (const key of Object.keys(PATCH_COLUMNS) as (keyof DraftPatch)[]) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
  }
  const { rows } = await db.query<DraftRow>(
    `UPDATE drafts SET ${sets.join(', ')}
      WHERE id = $1 AND workspace_id = $2 AND status = $3 AND version = $4
      RETURNING *`,
    params,
  );
  return rows[0] ? toDraft(rows[0]) : null;
}

async function currentOrNotFound(db: Db, workspaceId: string, draftId: number): Promise<{ status: DraftStatus; version: number }> {
  const { rows } = await db.query<{ status: DraftStatus; version: number }>(
    'SELECT status, version FROM drafts WHERE id = $1 AND workspace_id = $2',
    [draftId, workspaceId],
  );
  const row = rows[0];
  if (!row) throw new AppError('NOT_FOUND', '초안이 없습니다.');
  return row;
}

const conflict = (current: { status: DraftStatus; version: number }) =>
  new AppError('VERSION_CONFLICT', '다른 사람이 먼저 바꿨습니다.', { status: current.status, version: current.version });

export interface TransitionInput {
  workspaceId: string;
  draftId: number;
  to: DraftStatus;
  /** 화면이 보고 있던 version. 지금과 다르면 409. */
  expectedVersion: number;
  actor: EventActor;
  /** 변경 기록에 남길 사유 코드. 반려면 반려 사유가 저절로 들어간다. */
  reasonCode?: string | null;
  patch?: DraftPatch;
  now: Date;
}

/**
 * 초안의 상태를 바꾸고 변경 기록 한 줄을 남긴다. 부르는 쪽의 트랜잭션 안에서 돈다.
 * 풀이 아니라 연결 하나(PoolClient)만 받는다. 풀로 부르면 상태 변경과 기록이 서로 다른 트랜잭션이 되기 때문이다.
 * - 없는 초안 NOT_FOUND(404) · 낡은 version VERSION_CONFLICT(409) · 표에 없는 이동 BAD_TRANSITION(422)
 * - 반려에는 반려 사유가 꼭 있어야 한다. 다시 돌리기(→ PROCESSING)는 반려 사유, 지난 결과(종류·갈래·사유), 지난 LLM 길 기록을 지운다.
 */
export async function transitionDraft(db: PoolClient, input: TransitionInput): Promise<Draft> {
  const { workspaceId, draftId, to, expectedVersion, now } = input;
  const current = await currentOrNotFound(db, workspaceId, draftId);
  if (current.version !== expectedVersion) throw conflict(current);
  if (!canTransition(current.status, to)) {
    throw new AppError('BAD_TRANSITION', `'${STATUS_LABELS[current.status]}'에서 '${STATUS_LABELS[to]}'(으)로는 바꿀 수 없습니다.`);
  }

  const patch: DraftPatch = { ...input.patch };
  if (to === 'REJECTED') {
    if (!patch.rejectCode || !(REJECT_CODES as readonly string[]).includes(patch.rejectCode)) {
      throw new AppError('BAD_INPUT', '반려 사유를 골라 주세요.');
    }
  } else if (to === 'PROCESSING') {
    patch.rejectCode = null;
    patch.rejectMemo = null;
    // 다시 돌리면 지난 결과(종류·갈래·사유)와 지난번에 어떤 길로 뽑았는지도 비운다(끝나면 새로 적힌다).
    // 처리 중인 초안에 지난 결과가 보이면 안 된다. 칸은 부르는 쪽(reprocessDraft)이 같은 트랜잭션에서 지운다.
    patch.type = null;
    patch.subtype = null;
    patch.reasons = [];
    patch.extractedBy = null;
    patch.model = null;
    patch.promptVersion = null;
    patch.llmSkipCause = null;
    patch.llmRecorded = null;
    patch.llmLatencyMs = null;
    patch.llmCostUsd = null;
  }

  const updated = await conditionalUpdate(db, { workspaceId, draftId, status: current.status, version: expectedVersion }, to, patch, now);
  // 읽은 뒤 바꾸기 전에 누가 먼저 바꿨다.
  if (!updated) throw conflict(await currentOrNotFound(db, workspaceId, draftId));

  await addStatusEvent(db, {
    draftId,
    actor: input.actor,
    from: current.status,
    to,
    reasonCode: input.reasonCode ?? (to === 'REJECTED' ? patch.rejectCode : null),
    now,
  });
  return updated;
}

/**
 * 상태는 그대로 두고 내용만 바꾼다(칸을 고쳤는데 갈래가 그대로일 때). version 은 하나 오른다.
 * allowed 에 없는 상태면 BAD_TRANSITION.
 */
export async function reviseDraft(
  db: PoolClient,
  input: { workspaceId: string; draftId: number; expectedVersion: number; allowed: readonly DraftStatus[]; patch?: DraftPatch; now: Date },
): Promise<Draft> {
  const { workspaceId, draftId, expectedVersion, now } = input;
  const current = await currentOrNotFound(db, workspaceId, draftId);
  if (current.version !== expectedVersion) throw conflict(current);
  if (!input.allowed.includes(current.status)) {
    throw new AppError('BAD_TRANSITION', `'${STATUS_LABELS[current.status]}' 상태에서는 고칠 수 없습니다.`);
  }
  const updated = await conditionalUpdate(db, { workspaceId, draftId, status: current.status, version: expectedVersion }, current.status, input.patch ?? {}, now);
  if (!updated) throw conflict(await currentOrNotFound(db, workspaceId, draftId));
  return updated;
}
