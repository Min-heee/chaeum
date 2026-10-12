// 경로 파일(app/api)이 부르는 묶음. 여기 있는 함수는 전부 작업 공간 번호를 받아 먼저 거른다.
// 번호만 받는 저장 함수(listFields, listEvents, getDraftById …)는 공간을 보지 않으므로 경로 파일에서 직접 부르지 않는다.
// 돌려주는 것은 약속(src/contract/api.ts)의 응답 꼴 그대로다.
import type {
  BulkIntakeResponse,
  DecisionResponse,
  DrainResponse,
  DraftDetailResponse,
  DraftListQuery,
  DraftListResponse,
  IntakeResponse,
  ProductBody,
  ProductDetailResponse,
  ProductListResponse,
} from '@/contract/api';
import type { ProductText } from '@/contract/content';
import { getPool } from './db';
import { editFields, type EditFieldsInput } from './edit-fields';
import { AppError } from './errors';
import { intakeMany, intakeOne, type IntakeOptions } from './intake';
import { defaultJobHandlers } from './job-handlers';
import { drain, type JobHandlers } from './queue';
import { countByStatus, getDraftDetail, listDrafts, type DraftDetail } from './repos/drafts';
import { getProduct, listProducts, listProductTexts, listProductTextsByWorkspace, textStateOf, type Product } from './repos/products';
import { approveDraft, rejectDraft, reprocessDraft, type Decision } from './review';
import type { RejectCode } from '@/contract/reasons';

export { editFields } from './edit-fields';
export { exportCsv, listExportTemplates } from './export-csv';
export { intakeFile } from './intake-file';
export { llmStatus } from './llm-router';
export { sampleList } from './samples';
export { textsFromCsv } from './bulk-csv';

// ── 접수 ───────────────────────────────────────────────────

/** 글 한 건. 새 글이면 created 가 true(201), 같은 글이면 false(200). 틀린 글 BAD_INPUT, 상한 LIMIT_EXCEEDED, 본보기 공간 READ_ONLY_WORKSPACE. */
export async function intakeText(text: unknown, options: IntakeOptions): Promise<{ body: IntakeResponse; created: boolean }> {
  const got = await intakeOne(text, options);
  return { body: got, created: !got.duplicate };
}

/** 여러 건(202). 한 건이 틀려도 나머지는 들어간다. 건수가 0 이거나 50 을 넘으면 오류. */
export async function intakeBulk(texts: readonly unknown[], options: IntakeOptions): Promise<BulkIntakeResponse> {
  const { workspace, items } = await intakeMany(texts, options);
  const counts = { new: 0, duplicate: 0, error: 0 };
  for (const item of items) counts[item.result] += 1;
  return { workspace, items: items.map((item, index) => ({ index, ...item })), counts };
}

// ── 초안 ───────────────────────────────────────────────────

function detailBody(d: DraftDetail): DraftDetailResponse {
  const { draft } = d;
  return {
    id: draft.id,
    status: draft.status,
    version: draft.version,
    type: draft.type,
    subtype: draft.subtype,
    reasons: draft.reasons,
    extractedBy: draft.extractedBy,
    llm: {
      // 둘 다 거짓이면 규칙만으로 뽑았거나(skipCause 에 까닭) 아직 처리 중이다.
      recorded: draft.llmRecorded === true,
      live: draft.llmRecorded === false,
      skipCause: draft.llmSkipCause,
      originalLatencyMs: draft.llmLatencyMs,
      originalCostUsd: draft.llmCostUsd,
      model: draft.model,
      promptVersion: draft.promptVersion,
    },
    source: { id: d.source.id, kind: d.source.kind, originName: d.source.originName, text: d.source.text },
    fields: d.fields,
    reject: draft.status === 'REJECTED' && draft.rejectCode ? { code: draft.rejectCode, memo: draft.rejectMemo } : null,
    productId: d.productId,
    events: d.events.map((e) => ({
      id: e.id, actor: e.actor, action: e.action, from: e.from, to: e.to, field: e.field,
      before: e.before, after: e.after, reasonCode: e.reasonCode, at: e.at.toISOString(),
    })),
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

/** 초안 상세. 다른 공간의 초안이나 없는 번호면 NOT_FOUND. */
export async function draftDetail(workspaceId: string, draftId: number): Promise<DraftDetailResponse> {
  const detail = await getDraftDetail(getPool(), workspaceId, draftId);
  if (!detail) throw new AppError('NOT_FOUND', '초안이 없습니다.');
  return detailBody(detail);
}

/** 검수함 한 쪽과 상태별 건수. 모르는 상태·사유·종류면 BAD_INPUT. */
export async function draftList(workspaceId: string, query: DraftListQuery = {}): Promise<DraftListResponse> {
  const pool = getPool();
  const page = await listDrafts(pool, workspaceId, query);
  return {
    items: page.items.map((item) => ({ ...item, updatedAt: item.updatedAt.toISOString() })),
    nextCursor: page.nextCursor,
    counts: await countByStatus(pool, workspaceId),
  };
}

/** 칸 고치기. 고친 뒤의 초안 상세를 돌려준다. 던지는 오류는 editFields 와 같다. */
export async function patchFields(input: EditFieldsInput): Promise<DraftDetailResponse> {
  await editFields(input);
  return draftDetail(input.workspaceId, input.draftId);
}

// ── 결정 ───────────────────────────────────────────────────

/** 승인. 상품 한 줄과 글 작업 한 건이 함께 생긴다. NOT_FOUND · VERSION_CONFLICT · BAD_TRANSITION · PRODUCT_INVALID · READ_ONLY_WORKSPACE. */
export async function approve(input: Decision): Promise<DecisionResponse> {
  return approveDraft(input);
}

/** 반려. 사유 코드가 꼭 있다. */
export async function reject(input: Decision & { reasonCode: RejectCode; memo?: string | null }): Promise<DecisionResponse> {
  return rejectDraft(input);
}

/** 다시 돌리기(FAILED·REJECTED → PROCESSING). */
export async function reprocess(input: Decision): Promise<DecisionResponse> {
  return reprocessDraft(input);
}

// ── 상품 ───────────────────────────────────────────────────

function productBody(p: Product, texts: readonly ProductText[]): ProductBody {
  return {
    id: p.id,
    draftId: p.draftId,
    type: p.type,
    subtype: p.subtype,
    name: p.name,
    price_krw: p.price_krw,
    list_price_krw: p.list_price_krw,
    vat_included: p.vat_included,
    spec: p.spec,
    options: p.options,
    textState: textStateOf(texts),
    createdAt: p.createdAt.toISOString(),
  };
}

/** 공간의 상품들. 새것부터. */
export async function productList(workspaceId: string): Promise<ProductListResponse> {
  const pool = getPool();
  const texts = await listProductTextsByWorkspace(pool, workspaceId);
  return { items: (await listProducts(pool, workspaceId)).map((p) => productBody(p, texts.get(p.id) ?? [])) };
}

/** 상품 하나와 언어별 글. 다른 공간의 상품이나 없는 번호면 NOT_FOUND. */
export async function productDetail(workspaceId: string, productId: number): Promise<ProductDetailResponse> {
  const pool = getPool();
  const product = await getProduct(pool, workspaceId, productId);
  if (!product) throw new AppError('NOT_FOUND', '상품이 없습니다.');
  const texts = await listProductTexts(pool, product.id);
  return { ...productBody(product, texts), texts };
}

// ── 줄 굴리기 ──────────────────────────────────────────────

/**
 * 줄을 한 번 굴린다(시간 예산 6초, 최대 5건). 시계는 부르는 쪽이 준다.
 * remaining 은 굴린 뒤에도 남은 일이다. 처리기가 있는 종류만 센다(처리할 수 없는 일 때문에 화면이 끝없이 다시 부르지 않게).
 */
export async function drainJobs(now: () => Date, handlers: JobHandlers = defaultJobHandlers(now)): Promise<DrainResponse> {
  const result = await drain({ handlers, now });
  const kinds = Object.keys(handlers);
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*) AS n FROM jobs WHERE status IN ('queued', 'running') AND kind = ANY($1::text[])`,
    [kinds],
  );
  return { ...result, remaining: Number(rows[0]?.n ?? 0) };
}
