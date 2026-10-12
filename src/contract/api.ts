// API·저장·작업 줄·화면이 함께 쓰는 값. 숫자와 이름을 한곳에 둔다.

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
} as const;

/** 하루 상한을 세는 이름(daily_counters.key). */
export const COUNTER_KEYS = ['intake', 'live_llm'] as const;
export type CounterKey = (typeof COUNTER_KEYS)[number];

/** 하루의 경계는 한국 시각이다. 주어진 시각의 한국 날짜를 'YYYY-MM-DD' 로 낸다. */
export function kstDay(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

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
 */
export const API_ERRORS = {
  BAD_INPUT: 400,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  BAD_TRANSITION: 422,
  PRODUCT_INVALID: 422,
  LIMIT_EXCEEDED: 429,
  READ_ONLY_WORKSPACE: 403,
  INTERNAL: 500,
} as const;
export type ApiErrorCode = keyof typeof API_ERRORS;

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  /** VERSION_CONFLICT·PRODUCT_INVALID 일 때 초안의 지금 상태 */
  current?: { status: string; version: number };
}

/** 내려받기의 종류. products: 양식 꼴. corrections: 사람이 고친 값(정답 후보). */
export const EXPORT_KINDS = ['products', 'corrections'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
