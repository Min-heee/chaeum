// LLM 공급자 자리의 약속. 구현 셋(실제 호출 / 녹화 재생 / 시험용)이 같은 자리에 끼워진다.
import { z } from 'zod';
import type { ContentDraft, ContentInput } from './content';
import type { LlmAttachment } from './attachments';
import type { Extraction } from './fields';

/** transcribe: 그림·PDF 를 글로 옮김. extract: 칸 뽑기. content: 다른 언어 글 만들기. */
export const LLM_TASKS = ['transcribe', 'extract', 'content'] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

// 첨부(그림·PDF)의 약속은 attachments.ts 에 있다. 브라우저 코드도 읽는 것이라 따로 뒀다.
export {
  ATTACHMENT_KINDS,
  ATTACHMENT_MEDIA_TYPES,
  attachmentKindOf,
  isMediaTypeOf,
  type AttachmentKind,
  type AttachmentMediaType,
  type LlmAttachment,
} from './attachments';

/**
 * 글로 옮긴 결과.
 * - text: 파일에 보이는 글자를 보이는 그대로. 표는 줄마다 한 줄로. 덧붙이거나 고치지 않는다.
 * - readable: 글자를 읽을 수 없는 파일(사진뿐인 그림, 깨진 스캔)이면 false. 이때 text 는 빈 글.
 */
export const TranscriptionSchema = z.object({ text: z.string(), readable: z.boolean() });
export type Transcription = z.infer<typeof TranscriptionSchema>;

export const LLM_PROVIDER_NAMES = ['anthropic', 'replay', 'fake'] as const;
export type LlmProviderName = (typeof LLM_PROVIDER_NAMES)[number];

/** 모델 이름을 정하지 않았을 때 쓰는 가장 작은 모델. */
export const DEFAULT_LLM_MODEL = 'claude-haiku-5-5';

export interface LlmRequest<T> {
  task: LlmTask;
  /** 'extract-v1' 처럼. 프롬프트를 바꾸면 이름도 바꾼다. */
  promptVersion: string;
  system: string;
  /** JSON 으로만 넘긴다. 원문은 값이지 지시가 아니다. */
  input: unknown;
  /** 답을 다시 검사하는 스키마. */
  schema: z.ZodType<T>;
  maxTokens: number;
  /**
   * (선택) 붙이는 파일. transcribe 에서만 쓴다. 지금은 한 요청에 하나다.
   * 장부 키에는 파일마다 { kind, mediaType, sha256(파일 바이트) } 가 꼭 들어가야 한다.
   * 안 그러면 다른 그림이 같은 키가 되어 남의 녹화 답이 나온다. base64 글 자체는 키에도 장부에도 넣지 않는다.
   */
  attachments?: LlmAttachment[];
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResult<T> {
  output: T;
  stopReason: string;
  usage: LlmUsage;
  /** 녹화본이면 녹화할 때 잰 값. */
  latencyMs: number;
  /** 녹화본이면 true. */
  recorded: boolean;
}

export interface LlmProvider {
  name: LlmProviderName;
  model: string;
  /** 못 하면 LlmUnavailable 을 던진다. */
  complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

/**
 * 답을 못 받은 까닭.
 * - NO_KEY: 키가 없다           - CACHE_MISS: 녹화가 없다
 * - REFUSAL: 모델이 거절했다     - MAX_TOKENS: 답이 잘렸다
 * - BAD_OUTPUT: 답이 스키마와 다르다
 * - BAD_REQUEST: 요청이 거절됐다(틀린 요청, 없는 모델, 잔액 부족 같은 4xx). 다시 해도 같다.
 * - TRANSIENT: 잠깐의 오류(429, 5xx, 시간 초과). 이것만 다시 해 볼 만하다.
 */
export const LLM_UNAVAILABLE_CODES = ['NO_KEY', 'CACHE_MISS', 'REFUSAL', 'MAX_TOKENS', 'BAD_OUTPUT', 'BAD_REQUEST', 'TRANSIENT'] as const;
export type LlmUnavailableCode = (typeof LLM_UNAVAILABLE_CODES)[number];

/**
 * 공급자가 답을 못 줄 때 던지는 오류.
 * retryable 이 true 면 작업을 다시 줄에 넣는다. false 면 규칙만으로 뽑는 길로 내려간다.
 */
export class LlmUnavailable extends Error {
  readonly code: LlmUnavailableCode;
  readonly retryable: boolean;
  /** 답은 못 썼지만 호출은 끝나 토큰이 나간 경우(거절, 잘림, 형식 오류)에만 있다. 비용을 셀 때 쓴다. */
  readonly usage?: LlmUsage;

  constructor(code: LlmUnavailableCode, message?: string, usage?: LlmUsage) {
    super(message ?? code);
    this.name = 'LlmUnavailable';
    this.code = code;
    this.retryable = code === 'TRANSIENT';
    this.usage = usage;
  }
}

export function isLlmUnavailable(err: unknown): err is LlmUnavailable {
  return err instanceof LlmUnavailable || (err instanceof Error && err.name === 'LlmUnavailable');
}

// ── 호출 장부(= 캐시 = 녹화본) ──────────────────────────────

/** 장부 한 줄(llm_calls). */
export interface LlmCallRecord {
  task: LlmTask;
  provider: LlmProviderName;
  model: string;
  promptVersion: string;
  /**
   * sha256(task + model + promptVersion + 스키마 버전 + 시스템 글·보내는 스키마의 해시 + 생각 깊이 + 정리한 입력).
   * 첨부가 있으면 "정리한 입력"에 첨부마다의 종류·형식·파일 해시가 함께 들어간다.
   */
  cacheKey: string;
  /** 검사를 통과한 답 */
  response: unknown;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  /** 녹화본으로 심은 줄인가 */
  isRecorded: boolean;
}

/**
 * 장부를 읽고 쓰는 자리. src/llm 은 DB 를 모른다. 저장하는 쪽(src/server)이 이 자리를 채워 넘긴다.
 * 시험에서는 메모리로 만든 것을 넘긴다.
 */
export interface LlmCallStore {
  /** 같은 키의 가장 최근 줄. 없으면 null. */
  find(cacheKey: string): Promise<LlmCallRecord | null>;
  save(record: LlmCallRecord): Promise<void>;
}

// ── src/llm 이 내보낼 함수 ──────────────────────────────────

export interface CreateProviderOptions {
  kind: LlmProviderName;
  /** 비우면 DEFAULT_LLM_MODEL. */
  model?: string;
  /** anthropic 은 쓰기, replay 는 읽기에 쓴다. fake 는 없어도 된다. */
  store?: LlmCallStore;
  /** anthropic 에만. 없으면 complete 가 NO_KEY 를 던진다. 코드에 적지 말고 환경 변수에서 읽어 넘긴다. */
  apiKey?: string;
  /** fake 에만. 요청을 받아 답을 정한다. 없으면 정해 둔 기본 답. */
  fakeAnswer?: (req: LlmRequest<unknown>) => unknown;
}

/** 단가(100만 토큰당 달러)와 확인한 날짜·주소. */
export interface ModelPrice {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  checkedOn: string;
  sourceUrl: string;
}

/** src/llm/index.ts 가 이 꼴대로 내보낸다. */
export interface LlmApi {
  createProvider(options: CreateProviderOptions): LlmProvider;
  /** 장부의 키. 같은 요청이면 같은 키, 프롬프트·모델·스키마·첨부 파일이 바뀌면 다른 키. */
  cacheKeyFor(req: LlmRequest<unknown>, model: string): string;
  /** 글로 옮기기 요청을 만든다. 파일은 attachments 로, 파일 이름은 넣지 않는다(이름이 달라도 같은 키). */
  buildTranscribeRequest(attachment: LlmAttachment): LlmRequest<Transcription>;
  /** 뽑기 요청을 만든다. 원문은 input 안의 값으로 들어간다. */
  buildExtractRequest(cleanText: string): LlmRequest<Extraction>;
  /** 글 만들기 요청을 만든다. retryHint 는 지난 답에서 걸린 검사를 알려 줄 때만. */
  buildContentRequest(input: ContentInput, retryHint?: string): LlmRequest<ContentDraft>;
  /** 토큰 수와 단가로 비용(달러)을 낸다. 모르는 모델이면 오류. */
  costUsd(model: string, usage: LlmUsage): number;
  priceOf(model: string): ModelPrice;
}

/**
 * 환경 변수에서 LLM 방식을 정한다.
 * LLM_PROVIDER 가 있으면 그것, 없으면 키가 있을 때 anthropic, 없을 때 replay.
 */
export function llmKindFromEnv(env: Record<string, string | undefined>): LlmProviderName {
  const asked = env.LLM_PROVIDER?.trim();
  if (asked) {
    if ((LLM_PROVIDER_NAMES as readonly string[]).includes(asked)) return asked as LlmProviderName;
    throw new Error(`LLM_PROVIDER 는 ${LLM_PROVIDER_NAMES.join(' | ')} 가운데 하나여야 한다`);
  }
  return env.ANTHROPIC_API_KEY ? 'anthropic' : 'replay';
}
