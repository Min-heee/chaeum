// API·저장·작업 줄·화면이 함께 쓰는 값. 숫자와 이름을 한곳에 둔다.
// 뒤쪽에는 본체 경로 18개의 요청·응답 꼴이 있다. 화면과 API 시험은 그 꼴만 보고 붙는다.
// 딸린 도구의 경로(19번부터)와 그 꼴·상한은 tools/ 아래에 도구별 파일로 있다(tools/index.ts 에 표).
// 브라우저 코드도 이 파일을 읽는다. llm-types.ts(환경 변수 이름이 들어 있다)는 여기서 값으로 가져오지 않는다.
import { z } from 'zod';
import { LANGS, TEXT_FIELDS, TEXT_SOURCES, TEXT_STATUSES } from './content';
import { EVAL_METHODS, GOLD_SPLITS, GOLD_STYLES, VERDICTS } from './eval-types';
import { DOC_TYPES, EDIT_LIMITS, EXTRACTED_BY, FIELD_KEYS, PRODUCT_TYPES, type FieldKey } from './fields';
import { ATTACHMENT_KINDS } from './attachments';
import { CONTENT_FAIL_CODES, LLM_SKIP_CAUSES, REASON_CODES, REJECT_CODES, type LlmSkipCause } from './reasons';
import { DRAFT_STATUSES } from './transitions';

// ── 작업 공간 ──────────────────────────────────────────────

/** 작업 공간 번호를 싣는 요청 헤더. */
export const WORKSPACE_HEADER = 'X-Workspace';

/** 읽기 전용 본보기 공간의 번호. 헤더 없이 읽으면 이 공간을 본다. */
export const PUBLIC_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000';

/** public: 읽기 전용 본보기, sandbox: 방문자의 첫 쓰기 때 생김, local: 내 컴퓨터. */
export const WORKSPACE_KINDS = ['public', 'sandbox', 'local'] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

// ── 상한 ───────────────────────────────────────────────────

export const LIMITS = {
  /** 글 한 건의 글자 수 */
  textMaxChars: 4000,
  /** 방문자 글에 진짜 LLM 을 돌릴 때의 글자 수 */
  liveLlmTextMaxChars: 2000,
  /** 한 번에 넣는 건수 */
  bulkMaxDocs: 50,
  /** 공간 하나의 초안 수 */
  draftsPerWorkspace: 100,
  /** 하루 전체 접수 건수 */
  intakePerDay: 2000,
  /** 이 날수가 넘도록 쓰기가 없던 방문자 공간은 지운다 */
  workspaceTtlDays: 2,
  /** 쓰기 요청 한 번에 지우는 낡은 공간 수 */
  workspaceSweepBatch: 50,
  /** 검수함 한 쪽의 건수 */
  pageSize: 30,
  /** 초안 하나의 변경 기록 줄 수. 넘으면 칸 고치기와 다시 돌리기를 받지 않는다(승인·반려는 된다). */
  eventsPerDraft: 200,
  /** 반려 메모의 글자 수 */
  rejectMemoMaxChars: 500,
} as const;

/** 하루 상한을 세는 이름(daily_counters.key). */
export const COUNTER_KEYS = ['intake', 'live_llm'] as const;
export type CounterKey = (typeof COUNTER_KEYS)[number];

/** 하루의 경계는 한국 시각이다. 주어진 시각의 한국 날짜를 'YYYY-MM-DD' 로 낸다. */
export function kstDay(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ── 원문 종류 ──────────────────────────────────────────────

/**
 * 원문이 무엇으로 들어왔나(source_docs.source_kind).
 * text: 붙여 넣은 글. image·pdf: 올린 파일을 모델이 옮긴 글.
 * import: 모으기 도구가 정리해 온 줄 하나를 "이름표: 값" 글로 적은 것(tools/collect.ts). 파일도 모델도 거치지 않았다.
 */
export const SOURCE_KINDS = ['text', 'image', 'pdf', 'import'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

// ── 작업 줄 ────────────────────────────────────────────────

/** extract: ref_id 는 초안 번호. content: ref_id 는 상품 번호. */
export const JOB_KINDS = ['extract', 'content'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ['queued', 'running', 'done', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const QUEUE = {
  /** 집은 작업을 붙잡아 두는 시간. 넘으면 다른 작업자가 가져간다. */
  leaseMs: 60_000,
  /** 다시 하기 전 기다리는 시간: retryBaseMs × 2^(지금까지 한 횟수 - 1) */
  retryBaseMs: 5_000,
  /** 이 횟수만큼 해 보고도 안 되면 dead */
  maxAttempts: 3,
  /** 요청 한 번이 줄을 굴리는 시간과 건수 */
  drainBudgetMs: 6_000,
  drainMaxJobs: 5,
  /** 로컬 작업자가 줄을 보는 간격 */
  workerPollMs: 1_000,
} as const;

// ── 변경 기록 ──────────────────────────────────────────────

export const EVENT_ACTORS = ['system', 'seller', 'admin'] as const;
export type EventActor = (typeof EVENT_ACTORS)[number];

/** status: 상태가 바뀜. edit: 사람이 칸을 고침(이 줄이 곧 정답 후보다). */
export const EVENT_ACTIONS = ['status', 'edit'] as const;
export type EventAction = (typeof EVENT_ACTIONS)[number];

/**
 * 사람이 아니라 시스템이 상태를 바꿨을 때 변경 기록(reason_code)에 남기는 까닭.
 * 반려 사유(REJECT_CODES)와는 다른 목록이다.
 */
export const SYSTEM_EVENT_REASONS = {
  JOB_DEAD: '처리를 세 번 해 보고도 끝내지 못해 실패로 돌렸다',
  PRODUCT_INVALID: '상품으로 등록할 수 없는 값이 있어 확인 필요로 돌렸다',
} as const;
export type SystemEventReason = keyof typeof SYSTEM_EVENT_REASONS;

// ── 오류 ───────────────────────────────────────────────────

/**
 * 오류 본문은 { code, message } 다. VERSION_CONFLICT 와 PRODUCT_INVALID 에는 current 가 함께 간다.
 * PRODUCT_INVALID: 승인했지만 값이 상품 표의 조건에 안 맞아 등록하지 못했다(초안은 확인 필요로 간다).
 * 그림·PDF 올리기에서만 나는 것 넷:
 * - FILE_TOO_LARGE: 파일이나 요청 본문이 상한을 넘는다.   - UNSUPPORTED_FILE: 받지 않는 형식이다.
 * - UNREADABLE_FILE: 모델이 글자를 읽지 못한 파일이다.
 * - LLM_UNAVAILABLE: 글로 옮길 모델을 부를 수 없다(skipCause 가 함께 간다). 그림은 규칙만 길이 없어 접수하지 않는다.
 *   오늘 실제 호출 상한이 찬 경우(daily_cap)만은 LIMIT_EXCEEDED(429)로 낸다.
 * 딸린 도구에서 더한 것 하나:
 * - ALREADY_EXISTS: 같은 것이 이미 있어 새로 만들지 못한다(용어 사전의 같은 공간·같은 한국어 낱말).
 *   낡은 version 의 VERSION_CONFLICT 와 달리 current 가 없다. 다시 읽어 올 것이 아니라 입력을 바꿔야 한다.
 * 딸린 도구는 그 밖에는 위의 코드를 그대로 쓴다(시안 파일의 형식·크기 415·413, 조건 뽑기 모델을 못 부름 503 등).
 */
export const API_ERRORS = {
  BAD_INPUT: 400,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  ALREADY_EXISTS: 409,
  BAD_TRANSITION: 422,
  PRODUCT_INVALID: 422,
  LIMIT_EXCEEDED: 429,
  READ_ONLY_WORKSPACE: 403,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE: 415,
  UNREADABLE_FILE: 422,
  LLM_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const;
export type ApiErrorCode = keyof typeof API_ERRORS;

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  /** VERSION_CONFLICT·PRODUCT_INVALID 일 때 초안의 지금 상태 */
  current?: { status: string; version: number };
  /** LLM_UNAVAILABLE·LIMIT_EXCEEDED(그림 올리기)일 때 모델을 못 부른 까닭 */
  skipCause?: LlmSkipCause;
}

/** 내려받기의 종류. products: 양식 꼴. corrections: 사람이 고친 값(정답 후보). */
export const EXPORT_KINDS = ['products', 'corrections'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

// ════════════════════════════════════════════════════════════
// 경로별 요청·응답의 꼴 (모두 /api 아래)
// ════════════════════════════════════════════════════════════
//
//  #  메서드·경로                        하는 일
//  1  POST  /source-docs                글 한 건 접수. 새 글 201, 같은 글 200
//  2  POST  /source-docs/bulk           여러 건(50건까지). 202
//  3  GET   /drafts                     검수함
//  4  GET   /drafts/:id                 초안 상세
//  5  PATCH /drafts/:id/fields          칸 고치기
//  6  POST  /drafts/:id/approve         승인
//  7  POST  /drafts/:id/reject          반려
//  8  POST  /drafts/:id/reprocess       다시 돌리기
//  9  GET   /products                   등록된 상품
// 10  GET   /products/:id               상품 + 언어별 글
// 11  GET   /export.csv                 양식 꼴 CSV / 사람이 고친 값 (응답은 text/csv)
// 12  GET   /eval/runs                  평가 실행 목록
// 13  GET   /eval/runs/:id              지표와 건별 결과
// 14  POST  /jobs/drain                 줄 굴리기
// 15  GET   /health                     살아 있는지
// 16  POST  /source-files               그림·PDF 올리기(multipart). 새 글 201, 같은 파일·같은 글 200
// 17  POST  /content-checks             번역 검사 (꼴은 content.ts 의 ContentCheckRequestSchema / ResponseSchema)
// 18  GET   /samples                    보기 글 목록
//
// 공통 규칙
// - 작업 공간: 요청 헤더 X-Workspace. 없으면 읽기는 본보기 공간을 본다.
//   쓰기에 헤더가 없으면 그때 새 공간을 만들고 응답의 workspace 에 돌려준다(화면이 브라우저에 저장한다).
// - 오류는 언제나 ApiErrorBodySchema 의 꼴이고, 상태 번호는 API_ERRORS 표를 따른다.
// - 시각은 ISO 8601 글자, 번호는 수다.
// - 응답 스키마는 "꼭 있는 것"을 적은 것이다. 서버가 칸을 더 실어도 화면은 깨지지 않게 읽는다.

const id = z.number().int().positive();
const isoTime = z.string().min(1);
const version = z.number().int().min(1);
const fieldKey = z.enum(FIELD_KEYS as readonly [FieldKey, ...FieldKey[]]);
const workspaceId = z.string().uuid();
/** 칸 값. 꼴은 칸마다 다르므로(fields.ts 의 FIELD_SCHEMAS) 여기서는 묻지 않는다. 없으면 null. */
const fieldValue = z.unknown();

export const ApiErrorBodySchema = z.object({
  code: z.enum(Object.keys(API_ERRORS) as [ApiErrorCode, ...ApiErrorCode[]]),
  message: z.string(),
  current: z.object({ status: z.string(), version: z.number().int() }).optional(),
  skipCause: z.enum(LLM_SKIP_CAUSES).optional(),
});

// ── 1·2·16. 접수 ───────────────────────────────────────────

/** 1. POST /source-docs 의 요청. */
export const IntakeRequestSchema = z.object({ text: z.string() });
export type IntakeRequest = z.infer<typeof IntakeRequestSchema>;

/** 1·16 의 응답. 새 글이면 201, 이미 있던 글(또는 파일)이면 200 이고 duplicate 가 true. */
export const IntakeResponseSchema = z.object({
  workspace: workspaceId,
  sourceDocId: id,
  draftId: id,
  status: z.enum(DRAFT_STATUSES),
  duplicate: z.boolean(),
});
export type IntakeResponse = z.infer<typeof IntakeResponseSchema>;

/**
 * 2. POST /source-docs/bulk 의 요청. 둘 가운데 하나만 준다.
 * - texts: 글의 목록.
 * - csv: CSV 글. 첫 열이 글이다. 첫 줄의 첫 칸이 "text" 면 머리줄로 보고 건너뛴다. 큰따옴표 안의 줄바꿈은 글의 일부다.
 */
export const BulkIntakeRequestSchema = z.union([
  z.strictObject({ texts: z.array(z.string()).min(1).max(LIMITS.bulkMaxDocs) }),
  z.strictObject({ csv: z.string().min(1) }),
]);
export type BulkIntakeRequest = z.infer<typeof BulkIntakeRequestSchema>;

export const BulkIntakeItemSchema = z.discriminatedUnion('result', [
  z.object({ index: z.number().int().min(0), result: z.literal('new'), sourceDocId: id, draftId: id, status: z.enum(DRAFT_STATUSES) }),
  z.object({ index: z.number().int().min(0), result: z.literal('duplicate'), sourceDocId: id, draftId: id, status: z.enum(DRAFT_STATUSES) }),
  z.object({ index: z.number().int().min(0), result: z.literal('error'), code: z.string(), message: z.string() }),
]);

/** 2 의 응답(202). 한 건이 틀려도 나머지는 들어간다. 하나도 못 넣었으면 workspace 는 받은 번호 그대로(없었으면 null). */
export const BulkIntakeResponseSchema = z.object({
  workspace: workspaceId.nullable(),
  items: z.array(BulkIntakeItemSchema),
  counts: z.object({ new: z.number().int(), duplicate: z.number().int(), error: z.number().int() }),
});
export type BulkIntakeResponse = z.infer<typeof BulkIntakeResponseSchema>;

/**
 * 16. POST /source-files — multipart/form-data, 파일 칸 이름은 "file"(UPLOAD_LIMITS.formField), 한 번에 하나.
 * 요청 안에서 모델이 파일을 글로 옮기고, 그 글이 1번과 같은 길로 접수된다. 파일 자체는 저장하지 않는다.
 * 같은 공간에 같은 파일을 다시 올리면 모델을 부르지 않고 기존 건을 돌려준다(200, duplicate).
 * 오류: 형식 415 · 크기 413 · 글자를 못 읽음 422 · 옮긴 글이 글 상한을 넘음 400
 *       · 모델을 못 부름 503(skipCause) · 오늘 실제 호출 상한이 참 429(skipCause: daily_cap).
 */
export const SourceFileResponseSchema = IntakeResponseSchema.extend({
  source: z.object({
    kind: z.enum(ATTACHMENT_KINDS),
    /** 올린 파일 이름. 없으면 null. */
    originName: z.string().nullable(),
    /** 옮긴 글의 글자 수 */
    chars: z.number().int().min(0),
  }),
  /** 글로 옮긴 호출의 기록. 같은 파일을 다시 올려 모델을 안 불렀으면 null. */
  transcribe: z
    .object({ recorded: z.boolean(), live: z.boolean(), originalLatencyMs: z.number(), originalCostUsd: z.number() })
    .nullable(),
});
export type SourceFileResponse = z.infer<typeof SourceFileResponseSchema>;

// ── 3. 검수함 ──────────────────────────────────────────────

/** 검수함의 두 갈래. review = 확인 필요(NEEDS_REVIEW), ready = 바로 승인 가능(READY). */
export const INBOX_LANES = ['review', 'ready'] as const;
export type InboxLane = (typeof INBOX_LANES)[number];

/** 3. GET /drafts 의 주소 값. 모두 선택이다. 주소 값은 글자로 오므로 cursor 는 글자를 수로 바꿔 읽는다. */
export const DraftListQuerySchema = z.object({
  status: z.enum(DRAFT_STATUSES).optional(),
  reason: z.enum(REASON_CODES).optional(),
  type: z.enum(DOC_TYPES).optional(),
  /** 지난 응답의 nextCursor */
  cursor: z.coerce.number().int().positive().optional(),
});
export type DraftListQuery = z.infer<typeof DraftListQuerySchema>;

export const DraftListItemSchema = z.object({
  id,
  status: z.enum(DRAFT_STATUSES),
  version,
  type: z.enum(DOC_TYPES).nullable(),
  subtype: z.string().nullable(),
  /** 상품 이름 칸의 값. 아직 없으면 null. */
  name: z.string().nullable(),
  /** 초안 사유와 칸 사유를 합친 것(겹침 없이) */
  reasons: z.array(z.enum(REASON_CODES)),
  extractedBy: z.enum(EXTRACTED_BY).nullable(),
  /** 글·그림·PDF 가운데 무엇으로 들어왔나 */
  sourceKind: z.enum(SOURCE_KINDS),
  /** 원문 앞머리 */
  preview: z.string(),
  updatedAt: isoTime,
});
export type DraftListItemBody = z.infer<typeof DraftListItemSchema>;

export const DraftListResponseSchema = z.object({
  items: z.array(DraftListItemSchema),
  /** 다음 쪽이 없으면 null */
  nextCursor: id.nullable(),
  /** 이 공간의 상태별 건수(걸러 내기 전의 전체) */
  counts: z.record(z.enum(DRAFT_STATUSES), z.number().int().min(0)),
});
export type DraftListResponse = z.infer<typeof DraftListResponseSchema>;

// ── 4. 초안 상세 ───────────────────────────────────────────

export const DraftFieldSchema = z.object({
  field: fieldKey,
  raw: z.string().nullable(),
  modelValue: fieldValue,
  codeValue: fieldValue,
  finalValue: fieldValue,
  evidence: z.string().nullable(),
  reasons: z.array(z.enum(REASON_CODES)),
  editedByHuman: z.boolean(),
});
export type DraftFieldBody = z.infer<typeof DraftFieldSchema>;

export const DraftEventSchema = z.object({
  id,
  actor: z.enum(EVENT_ACTORS),
  action: z.enum(EVENT_ACTIONS),
  from: z.enum(DRAFT_STATUSES).nullable(),
  to: z.enum(DRAFT_STATUSES).nullable(),
  field: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  reasonCode: z.string().nullable(),
  at: isoTime,
});
export type DraftEventBody = z.infer<typeof DraftEventSchema>;

/**
 * 초안이 어떤 LLM 길로 뽑혔는지. 화면의 "녹화본 · 원래 걸린 시간 ○초 · 원래 비용 ○달러"가 여기서 나온다.
 * - recorded: 장부에서 꺼낸 답(보기 글의 녹화본, 또는 전에 받아 둔 답)으로 뽑았다.
 * - live: 이번에 실제로 불러 뽑았다.
 * - 둘 다 거짓: 규칙만으로 뽑았다(skipCause 에 까닭) 또는 아직 처리 중이다(skipCause 도 null).
 * - originalLatencyMs·originalCostUsd: 그 답을 실제로 받았을 때 잰 값. 녹화본이면 녹화할 때의 값이다. 모델을 안 거쳤으면 null.
 */
export const DraftLlmSchema = z.object({
  recorded: z.boolean(),
  live: z.boolean(),
  skipCause: z.enum(LLM_SKIP_CAUSES).nullable(),
  originalLatencyMs: z.number().nullable(),
  originalCostUsd: z.number().nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
});
export type DraftLlmBody = z.infer<typeof DraftLlmSchema>;

/** 4. GET /drafts/:id 의 응답. */
export const DraftDetailResponseSchema = z.object({
  id,
  status: z.enum(DRAFT_STATUSES),
  version,
  type: z.enum(DOC_TYPES).nullable(),
  subtype: z.string().nullable(),
  /** 초안 전체에 붙은 사유 */
  reasons: z.array(z.enum(REASON_CODES)),
  extractedBy: z.enum(EXTRACTED_BY).nullable(),
  llm: DraftLlmSchema,
  source: z.object({
    id,
    kind: z.enum(SOURCE_KINDS),
    /** 올린 파일 이름. 글로 넣었거나 이름이 없으면 null. */
    originName: z.string().nullable(),
    /** 정리된 원문. 그림·PDF 면 모델이 옮긴 글이다. */
    text: z.string(),
  }),
  /** 그 종류의 칸 전부(FIELDS_BY_TYPE 순서). 처리 중이면 빈 목록. */
  fields: z.array(DraftFieldSchema),
  /** 반려됐을 때만 값이 있다 */
  reject: z.object({ code: z.enum(REJECT_CODES), memo: z.string().nullable() }).nullable(),
  /** 승인돼 상품이 됐으면 그 번호 */
  productId: id.nullable(),
  /** 오래된 것부터 */
  events: z.array(DraftEventSchema),
  createdAt: isoTime,
  updatedAt: isoTime,
});
export type DraftDetailResponse = z.infer<typeof DraftDetailResponseSchema>;

// ── 5~8. 고치기와 결정 ─────────────────────────────────────

/**
 * 5. PATCH /drafts/:id/fields 의 요청.
 * edits: 칸 이름 → 새 값(표준 꼴). null 은 "없음"으로 비운다는 뜻. 그 종류에 없는 칸이나 꼴이 다른 값은 400.
 * type·subtype 을 주면 종류·갈래도 고친다(종류가 바뀌면 칸 목록이 달라진다).
 * 값의 크기에는 상한이 있다(fields.ts 의 EDIT_LIMITS: 글자 칸 200자, 갈래 60자, 목록 30개). 넘으면 400.
 * 초안 하나의 변경 기록이 LIMITS.eventsPerDraft 줄에 닿으면 429.
 */
export const PatchFieldsRequestSchema = z
  .object({
    version,
    edits: z.record(z.string(), z.unknown()).default({}),
    type: z.enum(DOC_TYPES).optional(),
    subtype: z.string().max(EDIT_LIMITS.subtypeMaxChars).nullable().optional(),
    /** 누가 고쳤나. 화면의 "셀러로 보기 / 운영자로 보기"가 준다. 비우면 admin. */
    actor: z.enum(['seller', 'admin']).optional(),
  })
  .refine((v) => Object.keys(v.edits).length > 0 || v.type !== undefined || v.subtype !== undefined, '고칠 것이 없다');
export type PatchFieldsRequest = z.infer<typeof PatchFieldsRequestSchema>;

/** 5 의 응답. 고친 뒤의 초안 상세 그대로다(규칙이 다시 돌아 상태·사유·version 이 바뀌어 있다). */
export const PatchFieldsResponseSchema = DraftDetailResponseSchema;

/** 6. POST /drafts/:id/approve, 8. POST /drafts/:id/reprocess 의 요청. */
export const DecisionRequestSchema = z.object({
  version,
  /** 누가 눌렀나. 화면의 "셀러로 보기 / 운영자로 보기"가 준다. 비우면 admin. */
  actor: z.enum(['seller', 'admin']).optional(),
});
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

/** 7. POST /drafts/:id/reject 의 요청. 사유 코드가 꼭 있다. */
export const RejectRequestSchema = z.object({
  version,
  reasonCode: z.enum(REJECT_CODES),
  memo: z.string().max(LIMITS.rejectMemoMaxChars).nullable().optional(),
  actor: z.enum(['seller', 'admin']).optional(),
});
export type RejectRequest = z.infer<typeof RejectRequestSchema>;

/** 6·7·8 의 응답(200). productId 는 승인일 때만 있다. */
export const DecisionResponseSchema = z.object({
  id,
  status: z.enum(DRAFT_STATUSES),
  version,
  productId: id.optional(),
});
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

/**
 * 낡은 version 으로 누르면 409 이고 본문은 이 꼴이다.
 * 예: {"code":"VERSION_CONFLICT","message":"다른 사람이 먼저 바꿨습니다","current":{"status":"APPROVED","version":3}}
 * 화면은 current 를 보고 다시 읽어 온다. PRODUCT_INVALID(422)도 current 가 함께 온다.
 */
export const ConflictBodySchema = ApiErrorBodySchema.extend({
  current: z.object({ status: z.enum(DRAFT_STATUSES), version }),
});
export type ConflictBody = z.infer<typeof ConflictBodySchema>;

// ── 9·10. 상품 ─────────────────────────────────────────────

export const ProductTextSchema = z.object({
  field: z.enum(TEXT_FIELDS),
  lang: z.enum(LANGS),
  /** 숫자가 들어간 끝 글 */
  text: z.string(),
  source: z.enum(TEXT_SOURCES),
  status: z.enum(TEXT_STATUSES),
  failCodes: z.array(z.enum(CONTENT_FAIL_CODES)),
});

/** 글 넷의 상태를 한마디로. pending: 글 작업이 아직 안 끝났다. */
export const PRODUCT_TEXT_STATES = ['pending', 'ok', 'needs_review'] as const;
export type ProductTextState = (typeof PRODUCT_TEXT_STATES)[number];

export const ProductSchema = z.object({
  id,
  draftId: id,
  type: z.enum(PRODUCT_TYPES),
  subtype: z.string(),
  name: z.string(),
  price_krw: z.number().int(),
  list_price_krw: z.number().int().nullable(),
  vat_included: z.boolean().nullable(),
  /** 종류별 규격 칸(칸 이름 → 값) */
  spec: z.record(z.string(), z.unknown()),
  /** 기간 옵션 또는 수량 옵션 */
  options: z.array(z.unknown()),
  textState: z.enum(PRODUCT_TEXT_STATES),
  createdAt: isoTime,
});
export type ProductBody = z.infer<typeof ProductSchema>;

/** 9. GET /products 의 응답. 새것부터. */
export const ProductListResponseSchema = z.object({ items: z.array(ProductSchema) });
export type ProductListResponse = z.infer<typeof ProductListResponseSchema>;

/** 10. GET /products/:id 의 응답. texts 는 글 작업이 끝나기 전에는 빈 목록이다. */
export const ProductDetailResponseSchema = ProductSchema.extend({
  texts: z.array(ProductTextSchema),
});
export type ProductDetailResponse = z.infer<typeof ProductDetailResponseSchema>;

// ── 11. 내려받기 ───────────────────────────────────────────

/**
 * 11. GET /export.csv 의 주소 값. 응답은 text/csv; charset=utf-8 이고 파일로 내려받게 한다.
 * template 은 kind=products 일 때만 쓴다. 양식 맞춤 파일의 이름이다(export-template.ts). 없는 이름이면 404.
 */
export const ExportQuerySchema = z.object({
  kind: z.enum(EXPORT_KINDS).default('products'),
  template: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
});
export type ExportQuery = z.infer<typeof ExportQuerySchema>;

/** kind=corrections 의 열 이름과 순서(고정). 사람이 고친 값 한 번이 한 줄이다. */
export const CORRECTION_COLUMNS = ['draft_id', 'source_doc_id', 'field', 'raw', 'before', 'after', 'edited_at'] as const;

// ── 12·13. 평가 ────────────────────────────────────────────

/** 지표의 꼴은 eval-types.ts 의 EvalMetrics 다. 여기서는 통째로 실어 보낸다. */
const metrics = z.record(z.string(), z.unknown());

export const EvalRunSchema = z.object({
  id,
  split: z.enum(GOLD_SPLITS),
  method: z.enum(EVAL_METHODS),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  goldVersion: z.number().int(),
  gitCommit: z.string(),
  metrics,
  costUsd: z.number(),
  startedAt: isoTime,
});

/**
 * 12. GET /eval/runs 의 응답. 새것부터. 공간과 상관없는 공용 읽기다.
 * goldVersions: 묶음별 지금 정답 버전(정답 표에 그 묶음이 실려 있을 때만). 실행의 정답 버전이 이보다 낮으면 화면이 "옛 정답으로 잰 값"이라고 적는다.
 * 실행의 metrics.runInfo.includeUnreviewed 가 참이면 사람이 확인하지 않은 문서가 채점에 든 실행이다.
 */
export const EvalRunListResponseSchema = z.object({
  items: z.array(EvalRunSchema),
  goldVersions: z.partialRecord(z.enum(GOLD_SPLITS), z.number().int()).optional(),
});
export type EvalRunListResponse = z.infer<typeof EvalRunListResponseSchema>;

/** 13. GET /eval/runs/:id 의 주소 값. against 는 견줄 실행의 번호(묶음·정답 버전·방식이 같아야 한다. 아니면 400). */
export const EvalRunQuerySchema = z.object({ against: z.coerce.number().int().positive().optional() });

export const EvalCellSchema = z.object({
  field: z.string(),
  expected: z.unknown(),
  actual: z.unknown(),
  verdict: z.enum(VERDICTS),
  flagged: z.boolean(),
});

/**
 * 13 의 응답.
 * docs: 문서별 결과. 실제 자료 묶음(real)은 원문을 싣지 않으므로 값(expected·actual)을 비워(null) 보낸다.
 * comparison: against 를 줬을 때만. 꼴은 eval-types.ts 의 RunComparison.
 */
export const EvalRunDetailResponseSchema = z.object({
  run: EvalRunSchema,
  docs: z.array(
    z.object({
      goldDocId: z.string(),
      /** 모든 칸이 맞았는가(종류·갈래 포함) */
      allCorrect: z.boolean(),
      /** 표시가 하나라도 붙었는가 */
      flagged: z.boolean(),
      cells: z.array(EvalCellSchema),
    }),
  ),
  comparison: z
    .object({
      baseRunId: id,
      otherRunId: id,
      improved: z.array(z.string()),
      regressed: z.array(z.string()),
      unchanged: z.number().int(),
      /** 한쪽 실행에만 있어 견주지 못한 문서 */
      onlyInBase: z.array(z.string()),
      onlyInOther: z.array(z.string()),
    })
    .nullable(),
});
export type EvalRunDetailResponse = z.infer<typeof EvalRunDetailResponseSchema>;

// ── 14·15. 줄 굴리기와 살아 있는지 ─────────────────────────

/** 14. POST /jobs/drain 의 응답. 요청 본문은 없다. 시간 예산(QUEUE.drainBudgetMs)과 최대 건수 안에서 굴린다. */
export const DrainResponseSchema = z.object({
  done: z.number().int(),
  retried: z.number().int(),
  dead: z.number().int(),
  lost: z.number().int(),
  reclaimed: z.number().int(),
  /** 굴린 뒤에도 줄에 남은 일(queued + running). 0 이 아니면 화면이 다시 부른다. */
  remaining: z.number().int(),
});
export type DrainResponse = z.infer<typeof DrainResponseSchema>;

/**
 * 15. GET /health 의 응답. DB 가 죽었으면 503 이고 ok·db 가 false, 뒤의 칸은 없다.
 * llm.provider 는 환경 변수로 정해진 방식이다. 환경 변수 값이 틀렸으면 'invalid'.
 * llm.live 는 방문자 글에 실제 호출이 열려 있는가(키가 있고 하루 상한이 0 보다 크다).
 */
export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  db: z.boolean(),
  dbMs: z.number().optional(),
  queue: z.object({ queued: z.number().int(), running: z.number().int(), dead: z.number().int() }).optional(),
  llm: z.object({
    provider: z.enum(['anthropic', 'replay', 'fake', 'invalid']),
    live: z.boolean(),
    model: z.string(),
    /** 오늘의 실제 호출 상한과 남은 수. 꺼져 있으면 둘 다 0. */
    liveCap: z.number().int(),
    liveLeftToday: z.number().int(),
  }),
  intakeLeftToday: z.number().int().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// ── 18. 보기 글 ────────────────────────────────────────────

/**
 * 보기 글 한 건(data/seed/samples.json 의 한 줄이기도 하다).
 * 보기 글의 LLM 답은 미리 받아 둔 녹화본이라 바로 뜬다. 화면이 이 글을 1번 경로로 그대로 접수한다.
 */
export const SampleSchema = z.object({
  /** 'sample-01' 처럼 */
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  /** 화면의 고르는 칸에 보이는 이름("메신저 말투", "중국어 섞인 문의") */
  label: z.string().min(1),
  style: z.enum(GOLD_STYLES),
  /** 이 글이 무엇으로 뽑힐 글인지(화면의 안내용). 등록 대상이 아닌 글도 있다. */
  type: z.enum(DOC_TYPES),
  /** 원문. 그림·PDF 보기는 두지 않는다(파일을 저장소에 두지 않으려는 것). */
  text: z.string().min(1).max(LIMITS.textMaxChars),
});
export type Sample = z.infer<typeof SampleSchema>;

/** 18. GET /samples 의 응답. 첫 줄이 첫 화면에 미리 들어가는 글이다. recorded: 이 글의 뽑기 녹화본이 장부에 있는가. */
export const SampleListResponseSchema = z.object({
  items: z.array(SampleSchema.extend({ recorded: z.boolean() })),
});
export type SampleListResponse = z.infer<typeof SampleListResponseSchema>;
