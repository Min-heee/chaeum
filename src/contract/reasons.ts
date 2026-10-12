// 사유 코드의 약속. 확신 점수 대신 "왜 사람이 봐야 하는지"를 코드로 남긴다.

/** 초안과 칸에 붙는 사유 코드 13개. */
export const REASON_CODES = [
  'NO_EVIDENCE',
  'VALUE_MISMATCH',
  'PARSE_FAILED',
  'UNIT_CONVERTED',
  'OUT_OF_RANGE',
  'REQUIRED_MISSING',
  'EMPTY_REQUIRED_OPTIONS',
  'TYPE_SUBTYPE_MISMATCH',
  'PLACEHOLDER_VALUE',
  'NOT_A_PRODUCT',
  'LLM_SKIPPED',
  'INSTRUCTION_LIKE',
  'TRANSCRIBED',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface ReasonDef {
  /** 화면에 보이는 짧은 이름 */
  label: string;
  /** 사람이 읽는 한 줄 설명 */
  description: string;
  /** 칸에 붙는가, 초안 전체에 붙는가 */
  scope: 'field' | 'draft';
  /** 이 사유가 있으면 "확인 필요"로 보내는가 */
  blocking: boolean;
  /** 어디서 붙이는가 */
  source: 'normalize' | 'checks/evidence' | 'checks/mismatch' | 'checks/range' | 'checks/required' | 'checks/structure' | 'extract' | 'pipeline';
}

/**
 * 사유 표.
 * blocking 은 첫 판에서 전부 true 다(조용히 통과시키지 않는 쪽에서 시작).
 * 어느 사유를 풀지는 연습 세트의 헛경보·놓침을 보고 정한 뒤 얼린다. 바꾸면 이유를 기록에 남긴다.
 */
export const REASONS: Record<ReasonCode, ReasonDef> = {
  NO_EVIDENCE: {
    label: '근거 없음',
    description: '근거 구절이나 원문 표현(raw)이 원문에 없습니다.',
    scope: 'field',
    blocking: true,
    source: 'checks/evidence',
  },
  VALUE_MISMATCH: {
    label: '값 불일치',
    description: '코드가 읽은 값과 모델이 읽은 값이 다릅니다. 둘 다 보여 드립니다.',
    scope: 'field',
    blocking: true,
    source: 'checks/mismatch',
  },
  PARSE_FAILED: {
    label: '읽지 못함',
    description: '코드가 원문 표현을 읽지 못했습니다. 원문 표현 없이 값만 온 칸도 여기에 듭니다.',
    scope: 'field',
    blocking: true,
    source: 'normalize',
  },
  UNIT_CONVERTED: {
    label: '단위 바꿈',
    description: '단위를 바꾸거나(예: 월 → 하루) 빠진 단위(만원)를 짐작해 적었습니다. 원문과 견주어 주세요.',
    scope: 'field',
    blocking: true,
    source: 'normalize',
  },
  OUT_OF_RANGE: {
    label: '범위 밖',
    description: '값이 말이 안 됩니다(0 이하, 판매가가 정가보다 큼, 기간이 길수록 총액이 작아짐, 운영 24시간 초과, 상품 이름이 한 글자).',
    scope: 'field',
    blocking: true,
    source: 'checks/range',
  },
  REQUIRED_MISSING: {
    label: '필수 칸 빔',
    description: '이 종류에 꼭 있어야 하는 칸이 비었습니다.',
    scope: 'field',
    blocking: true,
    source: 'checks/required',
  },
  EMPTY_REQUIRED_OPTIONS: {
    label: '옵션 0개',
    description: '필수 옵션인데 고를 것이 하나도 없습니다.',
    scope: 'field',
    blocking: true,
    source: 'checks/structure',
  },
  TYPE_SUBTYPE_MISMATCH: {
    label: '종류·갈래 불일치',
    description: '종류와 갈래가 서로 맞지 않습니다.',
    scope: 'draft',
    blocking: true,
    source: 'checks/structure',
  },
  PLACEHOLDER_VALUE: {
    label: '자리 채움 글자',
    description: '".", "-", "추후 안내" 같은 자리 채움 글자가 값으로 들어왔습니다.',
    scope: 'field',
    blocking: true,
    source: 'checks/structure',
  },
  NOT_A_PRODUCT: {
    label: '등록 대상 아님',
    description: '상품 소개가 아닌 글로 보입니다(잔금 안내, 인사말 등).',
    scope: 'draft',
    blocking: true,
    source: 'extract',
  },
  LLM_SKIPPED: {
    label: '규칙만으로 뽑음',
    // 왜 AI 를 거치지 않았는지는 초안의 llm_skip_cause 에 따로 남는다(LLM_SKIP_CAUSES).
    description: '규칙만으로 뽑았습니다. AI를 거치지 않았습니다.',
    scope: 'draft',
    blocking: true,
    source: 'pipeline',
  },
  INSTRUCTION_LIKE: {
    label: '지시문 같은 문장',
    description: '원문에 지시문처럼 보이는 문장이 있습니다. 자료로만 읽었습니다.',
    scope: 'draft',
    blocking: true,
    source: 'checks/structure',
  },
  TRANSCRIBED: {
    label: '원본과 대조 필요',
    description: '그림·PDF에서 옮긴 글입니다. 옮기다 틀렸을 수 있으니 원본과 대조해 주세요.',
    scope: 'draft',
    blocking: true,
    source: 'pipeline',
  },
};

export function isReasonCode(code: string): code is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(code);
}

/** "확인 필요"로 막는 사유인가. */
export function isBlocking(code: ReasonCode): boolean {
  return REASONS[code].blocking;
}

/** 막는 사유가 하나라도 있는가. 표시(노란 표시)의 정의이기도 하다. */
export function hasBlocking(codes: readonly ReasonCode[]): boolean {
  return codes.some(isBlocking);
}

// ── 규칙만 길로 내려간 까닭 ─────────────────────────────────

/**
 * LLM_SKIPPED 의 원인(drafts.llm_skip_cause). 화면이 "왜 AI 를 거치지 않았는지"를 이 말로 적는다.
 * - no_key: 키가 없다(또는 키가 거절됐다)       - cache_miss: 녹화만 쓰는 방식인데 이 글의 녹화가 없다
 * - off: 실제 호출이 꺼져 있다(하루 상한 0)     - too_long: 글이 실제 호출 길이 상한을 넘는다
 * - daily_cap: 오늘 실제 호출 상한이 다 찼다    - refusal: 모델이 거절했다
 * - error: 호출이 실패했다(잘린 답, 형식 오류, 요청 거절, 되풀이한 잠깐의 오류)
 */
export const LLM_SKIP_CAUSES = ['no_key', 'cache_miss', 'off', 'too_long', 'daily_cap', 'refusal', 'error'] as const;
export type LlmSkipCause = (typeof LLM_SKIP_CAUSES)[number];

export const LLM_SKIP_LABELS: Record<LlmSkipCause, string> = {
  no_key: 'API 키가 없습니다.',
  cache_miss: '미리 받아 둔 응답이 없는 글입니다.',
  off: '이 서버는 실제 호출이 꺼져 있습니다.',
  too_long: '글이 길어 실제 호출을 하지 않았습니다.',
  daily_cap: '오늘 실제 호출 상한이 다 찼습니다.',
  refusal: '모델이 답을 거절했습니다.',
  error: '호출이 실패했습니다.',
};

export function isLlmSkipCause(value: string): value is LlmSkipCause {
  return (LLM_SKIP_CAUSES as readonly string[]).includes(value);
}

// ── 글 검사 ────────────────────────────────────────────────

/** 글 검사 실패 코드 6개(검사는 5종. 한글 섞임과 빈 칸이 한 검사다). */
export const CONTENT_FAIL_CODES = [
  'PLACEHOLDER_LOST',
  'STRAY_NUMBER',
  'HANGUL_IN_TEXT',
  'EMPTY_TEXT',
  'MONOLOGUE',
  'GLOSSARY_MISS',
] as const;
export type ContentFailCode = (typeof CONTENT_FAIL_CODES)[number];

/** 글 검사 5종. */
export const CONTENT_CHECKS = ['placeholder', 'number', 'language', 'monologue', 'glossary'] as const;
export type ContentCheck = (typeof CONTENT_CHECKS)[number];

export const CONTENT_FAILS: Record<ContentFailCode, { label: string; description: string; check: ContentCheck }> = {
  PLACEHOLDER_LOST: {
    label: '자리표시 빠짐',
    description: '숫자가 들어갈 자리표시가 빠졌거나 모르는 자리표시가 있습니다.',
    check: 'placeholder',
  },
  STRAY_NUMBER: {
    label: '자리표시 밖 숫자',
    description: '자리표시 밖에 숫자가 적혀 있습니다. 숫자는 코드가 넣습니다.',
    check: 'number',
  },
  HANGUL_IN_TEXT: {
    label: '한글 섞임',
    description: '다른 언어 글에 한글이 섞였습니다.',
    check: 'language',
  },
  EMPTY_TEXT: {
    label: '빈 글',
    description: '글이 비었거나 점·줄표뿐입니다.',
    check: 'language',
  },
  MONOLOGUE: {
    label: '혼잣말 흔적',
    description: '모델의 혼잣말이나 머리말이 글에 남았습니다.',
    check: 'monologue',
  },
  GLOSSARY_MISS: {
    label: '용어 표기 다름',
    description: '용어 사전에 정한 표기가 글에 없습니다.',
    check: 'glossary',
  },
};

// ── 반려 사유 ──────────────────────────────────────────────

/** 사람이 반려할 때 고르는 사유. 반려에는 이 가운데 하나가 꼭 있어야 한다. */
export const REJECT_CODES = ['NOT_A_PRODUCT', 'DUPLICATE', 'NOT_ENOUGH_INFO', 'WRONG_INFO', 'OTHER'] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

export const REJECT_LABELS: Record<RejectCode, string> = {
  NOT_A_PRODUCT: '등록 대상이 아님',
  DUPLICATE: '이미 있는 상품',
  NOT_ENOUGH_INFO: '정보가 모자람',
  WRONG_INFO: '내용이 틀림',
  OTHER: '그 밖',
};
