// 모으기: 모은 줄의 목록과, 고른 줄을 본체의 초안으로 만드는 일.
// 줄 → 초안은 모델을 부르지 않는다. 줄의 값을 원문 글로 적고(src/tools/collect), 본체의 맞추기·따지기(evaluateDraft)를 그대로 거친다.
import { COLLECT_LIMITS, type CollectedDraftResponse, type CollectedItem, type CollectedListResponse, type CollectedQuery, type CollectFlag } from '@/contract/tools/collect';
import type { DraftStatus } from '@/contract/transitions';
import { evaluateDraft } from '@/core';
import { itemToExtraction, itemToSourceText } from '@/tools/collect';
import { getPool, withTx } from './db';
import { AppError, isAppError } from './errors';
import { assertWorkspaceRoom, countIntake, prepareText } from './limits';
import { saveFields, transitionDraft } from './repos/drafts';
import { receiveDoc } from './repos/source-docs';
import { toId, type Db } from './types';
import { touchWorkspaceForWrite } from './workspace';

interface ItemRow {
  id: string;
  batch_id: string;
  source_id: string;
  source_name: string;
  source_line: number;
  kind: string | null;
  name: string | null;
  region: string | null;
  address: string | null;
  subway_line: string | null;
  station: string | null;
  media_type: string | null;
  width_m: number | null;
  height_m: number | null;
  quantity: number | null;
  lat: number | null;
  lng: number | null;
  operator: string | null;
  raw: Record<string, unknown>;
  flags: CollectFlag[];
  draft_id: string | null;
  created_at: Date;
}

const toItem = (r: ItemRow): CollectedItem => ({
  id: toId(r.id),
  batchId: toId(r.batch_id),
  sourceId: r.source_id,
  sourceName: r.source_name,
  line: r.source_line,
  kind: r.kind,
  name: r.name,
  region: r.region,
  address: r.address,
  subwayLine: r.subway_line,
  station: r.station,
  mediaType: r.media_type,
  widthM: r.width_m,
  heightM: r.height_m,
  quantity: r.quantity,
  lat: r.lat,
  lng: r.lng,
  operator: r.operator,
  raw: r.raw,
  flags: r.flags,
  draftId: r.draft_id === null ? null : toId(r.draft_id),
  createdAt: r.created_at.toISOString(),
});

/** 줄과 그 줄이 든 묶음의 자료 이름을 함께 읽는다. */
const ITEM_SELECT = `SELECT i.*, b.source_name FROM collected_items i JOIN import_batches b ON b.id = i.batch_id`;

/** LIKE 에서 뜻이 있는 글자(%, _, \)를 글자 그대로 찾게 한다. */
const likeText = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** 모은 줄 목록. 새것부터, 한 쪽 50건. total 은 걸러 낸 뒤의 전체 수(쪽과 상관없다). */
export async function listCollected(workspaceId: string, query: CollectedQuery = {}, db: Db = getPool()): Promise<CollectedListResponse> {
  const where = `i.workspace_id = $1
     AND ($2::text IS NULL OR i.source_id = $2)
     AND ($3::text IS NULL OR $3 = ANY(i.flags))
     AND ($4::boolean IS NULL OR (i.draft_id IS NOT NULL) = $4)
     AND ($5::text IS NULL OR i.name ILIKE $5 OR i.address ILIKE $5 OR i.region ILIKE $5 OR i.station ILIKE $5)`;
  const params = [
    workspaceId,
    query.sourceId ?? null,
    query.flag ?? null,
    query.drafted === undefined ? null : query.drafted === 'yes',
    query.q === undefined ? null : likeText(query.q),
  ];
  const limit = COLLECT_LIMITS.pageSize;
  const { rows } = await db.query<ItemRow>(
    `${ITEM_SELECT} WHERE ${where} AND ($6::bigint IS NULL OR i.id < $6) ORDER BY i.id DESC LIMIT $7`,
    [...params, query.cursor ?? null, limit + 1],
  );
  const total = await db.query<{ n: string }>(`SELECT count(*) AS n FROM collected_items i WHERE ${where}`, params);
  const items = rows.slice(0, limit).map(toItem);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? last.id : null, total: Number(total.rows[0]?.n ?? 0) };
}

const noItem = () => new AppError('NOT_FOUND', '모은 줄이 없습니다.');

/**
 * 모은 줄 하나를 본체의 초안으로 만든다. 새 초안이면 created 가 참(201), 이 줄로 이미 만들었으면 있던 초안을 돌려준다(200).
 * - 공간 줄과 그 줄을 잠근 트랜잭션 하나에서 원문·초안·칸·상태를 함께 쓴다. 같은 줄을 동시에 두 번 보내도 초안은 하나다.
 * - 뽑은 방식은 'import' 다. 가격이 없는 자료라 필수 칸이 비어 "확인 필요"로 간다(갈래는 본체의 따지기가 정한다).
 * - 없는 줄·다른 공간의 줄·공간 번호 없이 온 요청은 NOT_FOUND, 본보기 공간은 READ_ONLY_WORKSPACE, 초안 수·오늘 접수 상한은 LIMIT_EXCEEDED.
 */
export async function draftFromCollected(
  input: { workspaceId: string | null; itemId: number; now: Date },
): Promise<{ body: CollectedDraftResponse; created: boolean }> {
  const { itemId, now } = input;
  // 공간 번호 없이 왔으면 그 줄이 있을 공간이 없다. 새 공간을 만들지 않는다.
  if (!input.workspaceId) throw noItem();
  const workspaceId = input.workspaceId;

  return withTx(async (client) => {
    await touchWorkspaceForWrite(client, workspaceId, now).catch((err: unknown) => {
      throw isAppError(err) && err.code === 'NOT_FOUND' ? noItem() : err;
    });
    const { rows } = await client.query<ItemRow>(`${ITEM_SELECT} WHERE i.id = $1 AND i.workspace_id = $2 FOR UPDATE OF i`, [itemId, workspaceId]);
    const row = rows[0];
    if (!row) throw noItem();
    const item = toItem(row);

    if (item.draftId !== null) {
      const draft = await client.query<{ source_doc_id: string; status: DraftStatus }>(
        'SELECT source_doc_id, status FROM drafts WHERE id = $1 AND workspace_id = $2',
        [item.draftId, workspaceId],
      );
      const had = draft.rows[0];
      if (!had) throw new Error('모은 줄에 적힌 초안을 찾지 못했다');
      return {
        body: { workspace: workspaceId, itemId, sourceDocId: toId(had.source_doc_id), draftId: item.draftId, status: had.status, duplicate: true },
        created: false,
      };
    }

    // 원문은 본체의 접수와 같은 정리를 거친다. 칸의 원문 표현(raw)은 정리된 글에서 읽어 저장된 원문과 글자까지 같게 한다.
    const { clean, hash } = prepareText(itemToSourceText(item));
    await assertWorkspaceRoom(client, workspaceId);
    await countIntake(client, now);
    const doc = await receiveDoc(client, { workspaceId, clean, hash, imported: true, now });

    let status = doc.status;
    if (!doc.duplicate) {
      const evaluation = evaluateDraft({ sourceText: clean, extraction: itemToExtraction(item, clean), extractedBy: 'import' });
      await saveFields(client, doc.draftId, evaluation.fields);
      const draft = await transitionDraft(client, {
        workspaceId,
        draftId: doc.draftId,
        to: evaluation.route,
        expectedVersion: 1,
        actor: 'system',
        patch: { type: evaluation.type, subtype: evaluation.subtype, reasons: evaluation.draftReasons, extractedBy: 'import' },
        now,
      });
      status = draft.status;
    }
    await client.query('UPDATE collected_items SET draft_id = $2 WHERE id = $1', [itemId, doc.draftId]);
    return {
      body: { workspace: workspaceId, itemId, sourceDocId: doc.sourceDocId, draftId: doc.draftId, status, duplicate: doc.duplicate },
      created: !doc.duplicate,
    };
  });
}
