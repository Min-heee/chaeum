// 점검의 약속. 이미 올라간 상품 전체(또는 양식 꼴 파일)를 한 번에 살핀다.
// 새 규칙을 만들지 않는다. 본체의 구조 규칙(src/core 의 checkRange·checkRequired·checkStructure)과
// 글 검사(checkContent)를 전 상품에 돌리고, 그 사유 코드를 그대로 쓴다. LLM 을 부르지 않고 아무것도 저장하지 않는다.
//
//   POST /api/audits
//     · 본문이 JSON { "source": "workspace" }  → 요청 헤더의 작업 공간(없으면 본보기 공간)에 등록된 상품 전체
//     · 본문이 multipart/form-data            → 양식 꼴 파일 하나(칸 이름 "file"). (선택) 글자 칸 "template" 에 양식 이름
//     · 주소 값 format=csv 를 주면 같은 결과를 CSV 로 내려준다(열은 AUDIT_CSV_COLUMNS)
//   판단은 src/tools/audit/ 의 순수 함수, 상품 읽기는 src/server/audit.ts, 경로는 app/api/audits/route.ts.
import { z } from 'zod';
import type { TextSource, TextStatus } from '../content';
import { PRODUCT_TYPES } from '../fields';
import { CONTENT_FAIL_CODES, CONTENT_FAILS, REASONS, type ContentFailCode, type ReasonCode } from '../reasons';

// ── 입력 ───────────────────────────────────────────────────

export const AUDIT_SOURCES = ['workspace', 'file'] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

/** 받는 파일 형식. CSV 는 내려받기(GET /api/export.csv)의 꼴, XLSX 는 GET /api/export.xlsx 의 꼴(xlsx.ts)이다. */
export const AUDIT_FILE_FORMATS = ['csv', 'xlsx'] as const;
export type AuditFileFormat = (typeof AUDIT_FILE_FORMATS)[number];

export const AUDIT_LIMITS = {
  /** 파일 하나의 크기(바이트) */
  fileMaxBytes: 1024 * 1024,
  /** 한 번에 살피는 상품(줄) 수. 넘으면 앞의 이만큼만 보고 truncated 를 참으로 낸다. */
  maxItems: 500,
  /** multipart 에서 파일이 실리는 칸 이름 */
  formField: 'file',
  /** multipart 에서 양식 이름이 실리는 칸 이름(없으면 기본 양식) */
  templateField: 'template',
} as const;

/** JSON 본문의 꼴. 파일을 올릴 때는 본문이 multipart 라 이 꼴을 쓰지 않는다. */
export const AuditRequestSchema = z.strictObject({ source: z.literal('workspace') });
export type AuditRequest = z.infer<typeof AuditRequestSchema>;

export const AUDIT_OUTPUT_FORMATS = ['json', 'csv'] as const;
export const AuditQuerySchema = z.object({ format: z.enum(AUDIT_OUTPUT_FORMATS).default('json') });

/**
 * 파일을 읽는 법(양식 꼴을 거꾸로 읽는다).
 * - 첫 줄은 칸 이름이다. 양식 맞춤 파일(export-template.ts)의 header 로 어느 칸인지 찾는다. 모르는 칸 이름은 무시한다.
 * - 값은 내려받기가 적은 꼴 그대로 읽는다: 크기 "7x12", 시간 "05:00~01:00(+1)", 옵션 "7일:1500000;14일:2800000",
 *   형식 "jpg;mp4", 참·거짓 "Y"/"N". 수식 막기로 붙은 맨 앞의 ' 는 뗀다. 빈칸은 "없음"이다.
 * - 꼴대로 읽지 못한 칸은 값을 비우고 UNREADABLE_CELL 을 붙인다(값을 짐작하지 않는다).
 * - XLSX 는 "상품" 시트를 읽고, "옵션" 시트가 있으면 상품 열쇠로 이어 옵션 칸을 채운다.
 * - 종류는 type(코드) 또는 type_label(이름) 열에서 읽는다. 둘 다 없거나 모르는 값이면 그 줄의 종류는 null 이고
 *   TYPE_SUBTYPE_MISMATCH 가 붙는다(종류를 모르면 그 줄의 칸 규칙은 돌리지 않는다).
 */
export const AUDIT_FILE_RULES = { skipFormulaPrefix: "'" } as const;

// ── 문제의 종류 ────────────────────────────────────────────

/** 점검이 돌리는 본체의 구조 규칙 사유. 원문이 있어야 하는 사유(근거, 값 불일치 등)는 등록된 상품에 해당이 없다. */
export const AUDIT_STRUCTURE_CODES = [
  'REQUIRED_MISSING',
  'EMPTY_REQUIRED_OPTIONS',
  'TYPE_SUBTYPE_MISMATCH',
  'PLACEHOLDER_VALUE',
  'OUT_OF_RANGE',
] as const satisfies readonly ReasonCode[];

/**
 * 공간의 상품에서만 나는 것. 본체가 글을 저장할 때 붙인 상태를 그대로 옮긴다.
 * TEXT_NEEDS_REVIEW: 상품 화면에 "글 확인 필요"로 나오는 글이다(모델 글이 두 번 걸렸거나 모델을 못 불러 코드의 틀 문장이 들어가 있다).
 * 틀 문장 자체는 지금의 글 검사를 통과하기도 한다. 그래서 글자만 다시 검사해서는 이 상태가 보이지 않는다.
 * 파일에는 이 상태가 실려 있지 않아 파일 점검에서는 나지 않는다.
 */
export const AUDIT_STORED_CODES = ['TEXT_NEEDS_REVIEW'] as const;

/** 파일을 읽다가만 나는 것. */
export const AUDIT_FILE_CODES = ['UNREADABLE_CELL'] as const;

/** 점검이 내는 문제 코드: 구조 5 + 글 검사 6 + 저장된 글 상태 1 + 파일 1. */
export const AUDIT_CODES = [...AUDIT_STRUCTURE_CODES, ...CONTENT_FAIL_CODES, ...AUDIT_STORED_CODES, ...AUDIT_FILE_CODES] as const;
export type AuditCode = (typeof AUDIT_CODES)[number];

/** error: 상품 값이 틀렸다(본체라면 검수로 막는 사유). warning: 다른 언어 글을 손봐야 한다. */
export const AUDIT_SEVERITIES = ['error', 'warning'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

export const AUDIT_SEVERITY_LABELS: Record<AuditSeverity, string> = { error: '값 문제', warning: '글 문제' };

export const AUDIT_GROUPS = ['structure', 'content', 'file'] as const;
export type AuditGroup = (typeof AUDIT_GROUPS)[number];

export interface AuditCodeDef {
  label: string;
  description: string;
  severity: AuditSeverity;
  group: AuditGroup;
}

const fromReason = (code: ReasonCode): AuditCodeDef => ({
  label: REASONS[code].label,
  description: REASONS[code].description,
  severity: 'error',
  group: 'structure',
});
const fromContentFail = (code: ContentFailCode): AuditCodeDef => ({
  label: CONTENT_FAILS[code].label,
  description: CONTENT_FAILS[code].description,
  severity: 'warning',
  group: 'content',
});

/**
 * 코드별 이름·설명·심각도. 이름과 설명은 본체의 사유 표(reasons.ts)에서 그대로 온다.
 * EMPTY_TEXT 는 "빈 번역"이다. 글이 비었을 때와, 그 언어의 글 줄이 아예 없을 때(글 작업이 안 끝났거나 죽었다) 모두 붙는다.
 * STRAY_NUMBER("숫자 어긋남")는 글에 적힌 숫자가 본체가 자리표시로 넣는 값(판매가, 가장 짧은 기간, 가장 적은 수량·최소 주문 수량)이나
 * 이름·지역·용어 표기에 든 숫자 어느 것과도 맞지 않을 때다. 다른 옵션의 값, 해상도, 크기 같은 다른 칸의 숫자는 글에 나와도 되는 숫자가 아니다.
 * 못 잡는 것: 값은 맞는데 짝이 틀린 글("7일 값"을 "14일" 옆에 쓴 경우처럼 되는 숫자끼리 자리가 바뀐 것).
 */
export const AUDIT_CODE_DEFS: Record<AuditCode, AuditCodeDef> = {
  REQUIRED_MISSING: fromReason('REQUIRED_MISSING'),
  EMPTY_REQUIRED_OPTIONS: fromReason('EMPTY_REQUIRED_OPTIONS'),
  TYPE_SUBTYPE_MISMATCH: fromReason('TYPE_SUBTYPE_MISMATCH'),
  PLACEHOLDER_VALUE: fromReason('PLACEHOLDER_VALUE'),
  OUT_OF_RANGE: fromReason('OUT_OF_RANGE'),
  PLACEHOLDER_LOST: fromContentFail('PLACEHOLDER_LOST'),
  STRAY_NUMBER: fromContentFail('STRAY_NUMBER'),
  HANGUL_IN_TEXT: fromContentFail('HANGUL_IN_TEXT'),
  EMPTY_TEXT: fromContentFail('EMPTY_TEXT'),
  MONOLOGUE: fromContentFail('MONOLOGUE'),
  GLOSSARY_MISS: fromContentFail('GLOSSARY_MISS'),
  TEXT_NEEDS_REVIEW: {
    label: '글 확인 필요',
    description: '상품에 "확인 필요"로 저장된 글입니다. 모델 글이 검사에 걸렸거나 모델을 부르지 못해 코드의 틀 문장이 들어가 있습니다. 사람이 읽어 봐야 합니다.',
    severity: 'warning',
    group: 'content',
  },
  UNREADABLE_CELL: {
    label: '읽지 못한 칸',
    description: '파일의 칸을 양식 꼴대로 읽지 못했습니다. 값을 짐작하지 않고 비워 두었습니다.',
    severity: 'error',
    group: 'file',
  },
};

// ── 결과 ───────────────────────────────────────────────────

export const AuditFindingSchema = z.object({
  code: z.enum(AUDIT_CODES),
  severity: z.enum(AUDIT_SEVERITIES),
  /**
   * 어느 자리의 문제인가. 상품 칸이면 칸 이름(price_krw), 글이면 양식의 글 자리 이름(title_en, summary_zh),
   * 상품 전체의 문제(종류·갈래 불일치)면 null.
   */
  field: z.string().nullable(),
  /** 사람이 읽는 한 줄. 무엇이 어떻게 틀렸는지(예: "기간 옵션이 0개입니다"). */
  message: z.string(),
});
export type AuditFinding = z.infer<typeof AuditFindingSchema>;

export const AuditItemSchema = z.object({
  /** 화면과 CSV 가 줄을 가리키는 이름. 공간의 상품이면 "product:12", 파일의 줄이면 "row:3"(머리줄 다음이 1). */
  key: z.string(),
  /** 공간의 상품이면 그 번호. 파일이면 파일에 상품번호 열이 있을 때만. */
  productId: z.number().int().positive().nullable(),
  /** 파일의 몇째 줄인가(머리줄 다음이 1). 공간의 상품이면 null. */
  rowNumber: z.number().int().positive().nullable(),
  name: z.string().nullable(),
  type: z.enum(PRODUCT_TYPES).nullable(),
  subtype: z.string().nullable(),
  /** 문제가 없으면 빈 목록. error 가 먼저, 그 안에서는 코드 목록(AUDIT_CODES) 순서. */
  findings: z.array(AuditFindingSchema),
});
export type AuditItem = z.infer<typeof AuditItemSchema>;

export const AuditCodeCountSchema = z.object({
  code: z.enum(AUDIT_CODES),
  label: z.string(),
  severity: z.enum(AUDIT_SEVERITIES),
  /** 이 코드의 문제 수 */
  findings: z.number().int().min(0),
  /** 이 코드가 하나라도 붙은 상품 수 */
  items: z.number().int().min(0),
});

/** POST /api/audits 의 응답(200). */
export const AuditResponseSchema = z.object({
  source: z.enum(AUDIT_SOURCES),
  /** 파일을 올렸을 때만 */
  file: z
    .object({
      name: z.string().nullable(),
      format: z.enum(AUDIT_FILE_FORMATS),
      /** 읽는 데 쓴 양식 이름 */
      template: z.string(),
      /** 머리줄을 뺀 줄 수(자르기 전) */
      rows: z.number().int().min(0),
      /** 양식의 칸 이름 가운데 파일에 없던 것 */
      missingHeaders: z.array(z.string()),
    })
    .nullable(),
  totals: z.object({
    /** 살핀 상품(줄) 수 */
    items: z.number().int().min(0),
    /** 문제가 하나라도 있는 상품 수 */
    itemsWithFindings: z.number().int().min(0),
    findings: z.number().int().min(0),
    bySeverity: z.record(z.enum(AUDIT_SEVERITIES), z.number().int().min(0)),
  }),
  /** 사유별 묶음. 문제가 0 인 코드는 빠진다. error 가 먼저, 그 안에서는 문제가 많은 것부터. */
  byCode: z.array(AuditCodeCountSchema),
  /** 상품별 문제 목록. 문제 없는 상품도 들어 있다(findings 가 빈 목록). 문제가 있는 것이 먼저, 그 안에서는 들어온 순서. */
  items: z.array(AuditItemSchema),
  /** 상한(AUDIT_LIMITS.maxItems)에 걸려 뒤쪽을 살피지 않았는가 */
  truncated: z.boolean(),
});
export type AuditResponse = z.infer<typeof AuditResponseSchema>;

/** format=csv 의 열(고정). 문제 하나가 한 줄이다. 쓰는 규칙은 export-template.ts 의 CSV_RULES 그대로. */
export const AUDIT_CSV_COLUMNS = ['key', 'product_id', 'row', 'name', 'type', 'severity', 'code', 'label', 'field', 'message'] as const;

// ── src/tools/audit 가 내보낼 순수 함수의 꼴 ────────────────

/** 점검할 상품 하나. 공간의 상품(products + product_texts)이든 파일의 한 줄이든 이 꼴로 맞춘 뒤 같은 함수에 넣는다. */
export interface AuditSubject {
  key: string;
  productId: number | null;
  rowNumber: number | null;
  type: (typeof PRODUCT_TYPES)[number] | null;
  subtype: string | null;
  /** 칸 이름 → 표준 꼴의 값. 없으면 null. 공통 칸(name, price_krw …)과 종류별 칸, 옵션 칸이 한데 들어 있다. */
  values: Record<string, unknown>;
  /** 다른 언어 글. 양식의 글 자리 이름(title_en …) → 글. 줄이 없으면 그 자리가 빠져 있다. */
  texts: Partial<Record<'title_en' | 'summary_en' | 'title_zh' | 'summary_zh', string>>;
  /** 파일을 읽다 못 읽은 칸(칸 이름). 공간의 상품이면 빈 목록. */
  unreadable: string[];
  /**
   * 본체가 그 글을 저장할 때 붙인 상태(product_texts 의 source·status·fail_codes). 공간의 상품에만 있다. 파일의 줄에는 없다.
   * 점검은 글자를 다시 검사하는 것과 함께 이 상태를 읽는다. 그래야 상품 화면의 "글 확인 필요"와 점검이 같은 말을 한다.
   */
  stored?: Partial<Record<'title_en' | 'summary_en' | 'title_zh' | 'summary_zh', { source: TextSource; status: TextStatus; failCodes: ContentFailCode[] }>>;
}

export interface AuditApi {
  /** 상품 하나의 문제 목록. 승인된 용어(glossary)는 부르는 쪽이 넘긴다. */
  auditSubject(subject: AuditSubject, glossary: readonly { ko: string; en: string; 'zh-Hans': string }[]): AuditFinding[];
  /** 문제 목록들을 응답의 totals·byCode·items 로 묶는다. */
  summarize(items: readonly AuditItem[]): Pick<AuditResponse, 'totals' | 'byCode' | 'items'>;
}
