// 파이프라인의 약속: 단계 셋(글로 옮기기 / 뽑기 / 글 만들기), 어느 LLM 길을 쓸지, 실제 호출과 올리기의 상한.
// 이 파일은 순수하다. DB 도 환경 변수도 직접 읽지 않는다(부르는 쪽이 읽어 인자로 넘긴다).
// 브라우저 코드(올리기 화면)도 읽으므로 llm-types.ts 에서는 타입만 가져온다.
import { LIMITS, QUEUE, type JobKind } from './api';
import type { ContentGeneration, GenerateContentInput } from './content';
import type { DraftEvaluation } from './core-api';
import type { ExtractedBy } from './fields';
import { attachmentKindOf, type AttachmentKind, type AttachmentMediaType, type LlmAttachment } from './attachments';
import type { LlmProvider, LlmProviderName, LlmTask, LlmUnavailableCode } from './llm-types';
import type { LlmSkipCause } from './reasons';

// ── 단계 ───────────────────────────────────────────────────

/**
 * LLM 을 쓰는 단계 셋. 이름은 LLM_TASKS 와 같다.
 * - transcribe: 그림·PDF → 글. 올리기 요청 안에서 바로 돈다(작업 줄에 넣지 않는다).
 *     파일을 저장하지 않기로 했으므로, 파일 바이트가 살아 있는 그 요청 안에서 끝내야 한다.
 *     끝나면 옮긴 글이 붙여 넣은 글과 같은 길(접수 → extract 작업)을 탄다.
 * - extract: 작업 줄의 'extract' 작업. 뽑기 → 맞추기 → 따지기 → 갈래.
 * - content: 작업 줄의 'content' 작업. 두 언어 글 만들기 → 글 검사.
 */
export const PIPELINE_STEPS = ['transcribe', 'extract', 'content'] as const satisfies readonly LlmTask[];
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

/** 단계가 작업 줄의 어느 작업인가. transcribe 는 줄을 타지 않는다(null). */
export const STEP_JOB_KIND: Record<PipelineStep, JobKind | null> = {
  transcribe: null,
  extract: 'extract',
  content: 'content',
};

// ── 올리기 상한 ────────────────────────────────────────────

/**
 * 그림·PDF 올리기의 상한.
 * 호스팅이 받는 요청 본문이 4.5MB 까지라, 파일 하나 3MB 로 묶는다(multipart 머리와 여유를 남긴다).
 * 한 번에 파일 하나만 받는다.
 */
export const UPLOAD_LIMITS = {
  /** 파일 하나의 크기(바이트). 그림과 PDF 가 같다. */
  fileMaxBytes: 3 * 1024 * 1024,
  /** 요청 본문 전체(바이트). 이보다 크면 파일을 읽기 전에 413. */
  requestMaxBytes: 4 * 1024 * 1024,
  /** 요청 하나의 파일 수 */
  filesPerRequest: 1,
  /** PDF 쪽수. 쪽마다 토큰이 들어 비용이 쪽수만큼 는다. 세는 법은 countPdfPagesRoughly(브라우저)와 서버의 countPdfPages. */
  pdfMaxPages: 10,
  /** 올린 파일 이름을 남길 때의 길이(글자). 넘으면 자른다. 경로는 떼고 이름만 남긴다. */
  originNameMaxChars: 120,
  /** multipart 에서 파일이 실리는 칸 이름 */
  formField: 'file',
} as const;

/**
 * 파일 머리 바이트로 형식을 알아낸다. 받지 않는 형식이면 null.
 * 브라우저가 보낸 형식 이름(Content-Type)은 믿지 않고 이것으로 정한다.
 */
export function sniffMediaType(bytes: Uint8Array): AttachmentMediaType | null {
  const starts = (sig: readonly number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // RIFF....WEBP
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  // %PDF-
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  return null;
}

/** 바이트를 한 글자씩 그대로 옮긴다(latin1). PDF 의 표식은 ASCII 라 이것으로 충분하다. */
export function latin1Text(bytes: Uint8Array): string {
  let text = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return text;
}

/**
 * 글 안의 쪽 표식("/Type /Page", "/Pages" 는 빼고)을 센다.
 * PDF 의 이름은 글자를 #16진수로 적어도 같은 이름이다("/P#61ge" = "/Page"). 그래서 먼저 풀어 놓고 센다.
 */
export function countPageMarks(text: string): number {
  const plain = text.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return (plain.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

/**
 * PDF 쪽수를 어림한다. 바이트 안의 쪽 표식을 센다.
 * 쪽 목록이 눌려(압축되어) 들어 있는 PDF 는 0 이 나온다. 0 이면 "모름"이다.
 * 브라우저에서도 도는 대강의 검사다. 서버는 눌린 묶음까지 풀어 다시 세고, 그래도 모르면 받지 않는다(src/server/pdf-pages.ts).
 */
export function countPdfPagesRoughly(bytes: Uint8Array): number {
  return countPageMarks(latin1Text(bytes));
}

/** 암호가 걸린 PDF 인가. 꼬리표(trailer) 쪽의 "/Encrypt" 표식을 본다. 모델 쪽이 받지 않으므로 호출 전에 막는다. */
export function isEncryptedPdf(bytes: Uint8Array): boolean {
  const mark = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]; // "/Encrypt"
  outer: for (let i = 0; i + mark.length <= bytes.length; i += 1) {
    for (let j = 0; j < mark.length; j += 1) if (bytes[i + j] !== mark[j]) continue outer;
    return true;
  }
  return false;
}

/** unknown_pages 는 서버만 낸다(눌린 묶음까지 풀어 봐도 쪽수를 세지 못한 PDF). checkUpload 는 내지 않는다. */
export type UploadProblem = 'empty' | 'too_large' | 'unsupported' | 'too_many_pages' | 'encrypted' | 'unknown_pages';

export type UploadCheck =
  | { ok: true; kind: AttachmentKind; mediaType: AttachmentMediaType }
  | { ok: false; problem: UploadProblem };

/** 올린 파일을 받아도 되는지 본다. 크기 → 형식 → (PDF 면) 쪽수 → 암호 순서. */
export function checkUpload(bytes: Uint8Array): UploadCheck {
  if (bytes.length === 0) return { ok: false, problem: 'empty' };
  if (bytes.length > UPLOAD_LIMITS.fileMaxBytes) return { ok: false, problem: 'too_large' };
  const mediaType = sniffMediaType(bytes);
  const kind = mediaType ? attachmentKindOf(mediaType) : null;
  if (!mediaType || !kind) return { ok: false, problem: 'unsupported' };
  if (kind === 'pdf' && countPdfPagesRoughly(bytes) > UPLOAD_LIMITS.pdfMaxPages) return { ok: false, problem: 'too_many_pages' };
  if (kind === 'pdf' && isEncryptedPdf(bytes)) return { ok: false, problem: 'encrypted' };
  return { ok: true, kind, mediaType };
}

export const UPLOAD_PROBLEM_MESSAGES: Record<UploadProblem, string> = {
  empty: '파일이 비었습니다.',
  too_large: '파일은 3MB까지 올릴 수 있습니다.',
  unsupported: 'JPG, PNG, WEBP 그림이나 PDF만 올릴 수 있습니다.',
  too_many_pages: 'PDF는 10쪽까지 올릴 수 있습니다. 쪽을 나눠 올려 주세요.',
  encrypted: '암호가 걸린 PDF는 읽을 수 없습니다. 암호를 푼 파일을 올려 주세요.',
  unknown_pages: '쪽수를 셀 수 없는 PDF입니다. 그림으로 바꿔 올리거나 글자를 붙여 넣어 주세요.',
};

/** 올린 파일 이름을 남길 꼴로 정리한다. 경로를 떼고, 눈에 안 보이는 글자를 빼고, 길면 자른다. 남는 것이 없으면 null. */
export function cleanOriginName(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = [...base.normalize('NFC')].filter((ch) => ch >= ' ' && ch !== '\u007f').join('').trim();
  if (!clean) return null;
  return [...clean].slice(0, UPLOAD_LIMITS.originNameMaxChars).join('');
}

// ── 실제 호출의 상한 ───────────────────────────────────────

/**
 * 방문자 글에 진짜 LLM 을 돌릴 때의 장치.
 * - 하루 전체 건수 상한: 환경 변수 LIVE_LLM_DAILY_CAP. 비우거나 0 이면 꺼짐. daily_counters 의 'live_llm' 으로 센다.
 *   호출 하나가 한 건이다(글로 옮기기, 뽑기, 글 만들기가 각각 센다. 다시 한 시도도 센다).
 *   호출하기 전에 올린다. 실패해도 돌려놓지 않는다(돈은 이미 나갔을 수 있다).
 * - 글이 2,000자를 넘으면 실제 호출을 하지 않는다(LIMITS.liveLlmTextMaxChars).
 * - 모델은 가장 작은 것. 답의 최대 토큰 수는 아래 값으로 묶는다.
 * - 이 밖에 키 자체에 지출 한도를 건다(콘솔에서. 코드 밖의 마지막 줄).
 */
export const LIVE_LLM = {
  /** 하루 상한을 읽는 환경 변수의 이름 */
  capEnv: 'LIVE_LLM_DAILY_CAP',
  /** 환경 변수가 없을 때의 상한. 0 = 꺼짐 */
  defaultDailyCap: 0,
  /** 환경 변수에 큰 수를 잘못 적어도 이보다 커지지 않는다 */
  hardDailyCap: 1000,
  /** 실제 호출을 하는 글의 최대 길이(글자) */
  textMaxChars: LIMITS.liveLlmTextMaxChars,
  /** 단계별 답의 최대 토큰 수 */
  // 옮기기는 글 1자에 출력 약 1토큰이 나갔다(한 번 잰 값). 접수 상한 4,000자에 닿는 글이 잘리지 않게 넉넉히 둔다.
  maxTokens: { transcribe: 6000, extract: 4096, content: 2048 },
} as const satisfies { maxTokens: Record<PipelineStep, number> } & Record<string, unknown>;

/** 환경 변수의 글자를 하루 상한으로 읽는다. 비었거나 수가 아니거나 0 이하면 0(꺼짐). 위는 hardDailyCap 에서 자른다. */
export function parseDailyCap(raw: string | undefined): number {
  const n = Number((raw ?? '').trim());
  if (!Number.isInteger(n) || n <= 0) return LIVE_LLM.defaultDailyCap;
  return Math.min(n, LIVE_LLM.hardDailyCap);
}

// ── 어느 길을 쓸지 ─────────────────────────────────────────

/**
 * 한 건에 쓰는 LLM 길.
 * - replay: 장부에 이 요청의 답이 있다(보기 글의 녹화본, 또는 전에 실제로 받아 둔 답). 돈이 들지 않는다.
 * - anthropic: 실제 호출. 하루 상한의 자리를 하나 잡아야 한다.
 * - fake: 시험용 구현(LLM_PROVIDER=fake). 시험에서만.
 * - rules: LLM 없이 간다. 뽑기는 규칙만 길 + LLM_SKIPPED, 글 만들기는 틀 문장, 글로 옮기기는 실패(대신할 길이 없다).
 */
export const LLM_ROUTES = ['replay', 'anthropic', 'fake', 'rules'] as const;
export type LlmRoute = (typeof LLM_ROUTES)[number];

export interface LlmRouteInput {
  /** 장부에 이 요청의 키로 된 답이 있는가(시험용 구현이 적은 줄은 치지 않는다). */
  hasRecording: boolean;
  /** 환경 변수로 정해진 방식(llmKindFromEnv). */
  providerKind: LlmProviderName;
  /** API 키가 있는가. */
  hasKey: boolean;
  /** 하루 실제 호출 상한(parseDailyCap). 0 이면 꺼짐. */
  dailyCap: number;
  /** 모델에게 보낼 글의 길이(글자). 글로 옮기기처럼 글이 없으면 0. */
  textChars: number;
}

export type LlmRoutePlan =
  | { route: 'replay' }
  | { route: 'fake' }
  /** 부르기 전에 오늘 자리를 하나 잡는다. 못 잡으면 rules + 'daily_cap'. */
  | { route: 'anthropic'; needsSlot: true }
  | { route: 'rules'; cause: LlmSkipCause };

/**
 * 이 건에 어느 길을 쓸지 고른다. 순서대로 본다.
 *  1. 시험용 방식이면 fake.
 *  2. 장부에 답이 있으면 replay(실제 호출이 켜져 있어도 받아 둔 답을 먼저 쓴다).
 *  3. 키가 없으면 rules(no_key).
 *  4. 방식이 replay 로 묶여 있으면 rules(cache_miss).
 *  5. 하루 상한이 0 이면 rules(off).
 *  6. 글이 길면 rules(too_long).
 *  7. 아니면 anthropic. 자리 잡기는 부르는 쪽이 DB 에서 한다(needsSlot).
 */
export function planLlmRoute(input: LlmRouteInput): LlmRoutePlan {
  if (input.providerKind === 'fake') return { route: 'fake' };
  if (input.hasRecording) return { route: 'replay' };
  if (!input.hasKey) return { route: 'rules', cause: 'no_key' };
  if (input.providerKind === 'replay') return { route: 'rules', cause: 'cache_miss' };
  if (!(input.dailyCap > 0)) return { route: 'rules', cause: 'off' };
  if (input.textChars > LIVE_LLM.textMaxChars) return { route: 'rules', cause: 'too_long' };
  return { route: 'anthropic', needsSlot: true };
}

/**
 * 호출이 실패했을 때 어떻게 할지.
 * - 'retry': 잠깐의 오류이고 아직 시도가 남았다. 작업을 다시 줄에 넣는다(처리기가 그 오류를 그대로 던지면 줄이 한다).
 * - 그 밖: rules 길로 내려가고 이 원인을 남긴다. 잠깐의 오류도 마지막 시도였으면 'error' 로 내려간다
 *   (방문자의 글이 "처리 실패"로 끝나지 않고 규칙만 결과라도 받게).
 * attempt 는 이번이 몇 번째 시도인가(1부터. 줄의 attempts 값).
 */
export function afterLlmFailure(code: LlmUnavailableCode, attempt: number, maxAttempts: number = QUEUE.maxAttempts): 'retry' | LlmSkipCause {
  switch (code) {
    case 'TRANSIENT':
      return attempt < maxAttempts ? 'retry' : 'error';
    case 'NO_KEY':
      return 'no_key';
    case 'CACHE_MISS':
      return 'cache_miss';
    case 'REFUSAL':
      return 'refusal';
    case 'MAX_TOKENS':
    case 'BAD_OUTPUT':
    case 'BAD_REQUEST':
      return 'error';
  }
}

// ── 길을 고르는 자리와 단계의 꼴 ────────────────────────────

/** 고른 길과 그 길의 공급자. rules 면 공급자가 없다. */
export type LlmPick =
  | { route: Exclude<LlmRoute, 'rules'>; provider: LlmProvider }
  | { route: 'rules'; provider: null; cause: LlmSkipCause };

/**
 * 길을 고르는 자리. src/server 가 채운다(장부 조회, 환경 변수, 하루 자리 잡기를 여기서 한다).
 * 단계 코드는 DB 를 모르고 이것만 받는다. 시험에서는 정해 둔 길을 내주는 가짜를 넘긴다.
 * cacheKey 는 LlmApi.cacheKeyFor 로 만든 그 요청의 키다.
 */
export interface LlmRouter {
  pick(input: { task: LlmTask; cacheKey: string; textChars: number; now: Date }): Promise<LlmPick>;
  /** 이 자리가 쓰는 모델 이름(키를 만들 때 쓴다). */
  model: string;
}

/**
 * 호출 한 번의 기록. 초안 상세의 llm 칸이 여기서 나온다.
 * recorded 와 live 는 함께 참일 수 없다. 둘 다 거짓이면 시험용 구현이다.
 */
export interface LlmCallInfo {
  /** 장부에서 꺼낸 답인가 */
  recorded: boolean;
  /** 이번에 실제로 부른 답인가 */
  live: boolean;
  model: string;
  promptVersion: string;
  /** 녹화본이면 녹화할 때 잰 값 */
  latencyMs: number;
  costUsd: number;
}

// 1) 글로 옮기기 ─ 올리기 요청 안에서 돈다.

export interface TranscribeInput {
  attachment: LlmAttachment;
  now: Date;
}

export type TranscribeOutcome =
  | { ok: true; text: string; llm: LlmCallInfo }
  /** 모델을 못 불렀다. 대신할 길이 없으므로 접수하지 않는다. */
  | { ok: false; problem: 'llm_skipped'; cause: LlmSkipCause }
  /** 불렀지만 글자를 읽을 수 없는 파일이었다(readable 이 false 이거나 옮긴 글이 비었다). */
  | { ok: false; problem: 'unreadable'; llm: LlmCallInfo };

/**
 * 파일 하나를 글로 옮긴다. 던지지 않는다(잠깐의 오류도 한 번만 해 보고 'error' 로 돌려준다. 요청 안이라 기다릴 수 없다).
 * 옮긴 글은 접수의 글 정리(cleanText)를 거친 뒤 길이 상한(LIMITS.textMaxChars)을 본다. 그것은 부르는 쪽이 한다.
 */
export type TranscribeStep = (input: TranscribeInput, router: LlmRouter) => Promise<TranscribeOutcome>;

// 2) 뽑기 ─ 'extract' 작업의 처리기 안에서 돈다.

export interface ExtractInput {
  /** 정리된 원문(붙여 넣은 글 또는 옮긴 글) */
  sourceText: string;
  /** 그림·PDF 에서 옮긴 글인가. 참이면 초안 사유에 TRANSCRIBED 를 더한다. */
  transcribed: boolean;
  /** 이번이 몇 번째 시도인가(1부터) */
  attempt: number;
  now: Date;
}

export interface ExtractOutcome {
  /**
   * 맞추고 따진 결과. draftReasons 에는 이 단계가 더한 사유(LLM_SKIPPED, TRANSCRIBED)까지 들어 있고,
   * route 는 그 사유를 넣어 다시 낸 갈래다.
   */
  evaluation: DraftEvaluation;
  extractedBy: ExtractedBy;
  /** 규칙만 길로 갔을 때의 원인. LLM 으로 뽑았으면 null. */
  skipCause: LlmSkipCause | null;
  /** LLM 으로 뽑았을 때의 호출 기록. 규칙만이면 null. */
  llm: LlmCallInfo | null;
}

/**
 * 뽑기 → 맞추기 → 따지기 → 갈래. DB 를 모른다(저장은 처리기가 한다).
 * 잠깐의 오류이고 시도가 남았으면 그 LlmUnavailable 을 그대로 던진다(줄이 다시 한다). 그 밖에는 던지지 않는다.
 */
export type ExtractStep = (input: ExtractInput, router: LlmRouter) => Promise<ExtractOutcome>;

// 3) 글 만들기 ─ 'content' 작업의 처리기 안에서 돈다.

export interface ContentStepInput {
  generate: GenerateContentInput;
  attempt: number;
  now: Date;
}

/** 길을 고른 뒤 ContentApi.generateContent 를 부른다. 던지는 규칙은 뽑기와 같다. */
export type ContentStep = (input: ContentStepInput, router: LlmRouter) => Promise<ContentGeneration>;

/** src/server/pipeline/index.ts 의 createPipeline 이 이 꼴대로 내보낸다. */
export interface PipelineApi {
  transcribe: TranscribeStep;
  extract: ExtractStep;
  content: ContentStep;
}
