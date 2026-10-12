// 종류와 칸의 약속. 모두가 읽기만 한다.
// 고치려면 이 파일을 쓰는 곳 전부(맞추기·따지기·저장·평가·화면)를 함께 봐야 한다.
import { z } from 'zod';

// ── 종류와 갈래 ─────────────────────────────────────────────

/** 상품으로 등록되는 종류 셋. */
export const PRODUCT_TYPES = ['ad', 'catering', 'goods'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

/** 글의 종류. not_product 는 "등록 대상이 아닌 글"(잔금 안내, 인사말 등). */
export const DOC_TYPES = ['ad', 'catering', 'goods', 'not_product'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const TYPE_LABELS: Record<DocType, string> = {
  ad: '광고 지면',
  catering: '케이터링',
  goods: '굿즈',
  not_product: '등록 대상 아님',
};

/** 종류별 갈래. 닫힌 목록이다. 여기 없는 갈래는 TYPE_SUBTYPE_MISMATCH. */
export const SUBTYPES = {
  ad: ['전광판', '지하철', '버스'],
  catering: ['커피차', '도시락'],
  goods: ['인쇄물', '잡화'],
  not_product: [],
} as const satisfies Record<DocType, readonly string[]>;

export type Subtype = (typeof SUBTYPES)[DocType][number];

/** 갈래가 그 종류의 목록에 있는가. not_product 는 갈래가 없어야(null) 맞다. */
export function isSubtypeOf(type: DocType, subtype: string | null): boolean {
  if (type === 'not_product') return subtype === null;
  if (subtype === null) return false;
  return (SUBTYPES[type] as readonly string[]).includes(subtype);
}

// ── 칸별 표준 값의 꼴 ───────────────────────────────────────
// 여기서는 "꼴"만 본다(정수인가, HH:MM 인가).
// 값이 0 이하인지, 판매가가 정가보다 큰지 같은 것은 꼴 오류가 아니라 사유(OUT_OF_RANGE)다.

const int = z.number().int();
const text = z.string().min(1);

/** 24시간제 시각. "24:00" 은 쓰지 않는다(자정은 "00:00" + 다음 날). */
export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * 운영 시간. "05시~25시" → { open: "05:00", close: "01:00", nextDay: true }.
 * nextDay: 끝 시각이 시작한 날의 다음 날이면 true. 24시간 운영은 open 과 close 가 같고 nextDay 가 true.
 */
export const HoursSchema = z.object({ open: HHMM, close: HHMM, nextDay: z.boolean() });
export type Hours = z.infer<typeof HoursSchema>;

/** 크기(m). 가로·세로 순서. 소수 둘째 자리까지. */
export const SizeMSchema = z.object({ width: z.number(), height: z.number() });
export type SizeM = z.infer<typeof SizeMSchema>;

/** 크기(mm). 가로·세로 순서. 정수. */
export const SizeMmSchema = z.object({ width: int, height: int });
export type SizeMm = z.infer<typeof SizeMmSchema>;

/** 해상도(px). 가로·세로 순서. */
export const ResolutionSchema = z.object({ width: int, height: int });
export type Resolution = z.infer<typeof ResolutionSchema>;

/** 기간 옵션 하나. "1주 150만원" → { days: 7, price_krw: 1500000 }. */
export const PeriodOptionSchema = z.object({ days: int, price_krw: int });
export type PeriodOption = z.infer<typeof PeriodOptionSchema>;

/** 수량 옵션 하나. "100잔 80만원" → { qty: 100, price_krw: 800000 }. */
export const QuantityOptionSchema = z.object({ qty: int, price_krw: int });
export type QuantityOption = z.infer<typeof QuantityOptionSchema>;

/**
 * 칸별 표준 값의 스키마.
 *
 * 값을 정하는 규칙(정답을 만드는 쪽과 맞추는 쪽이 같이 지킨다):
 * - 금액은 원 단위 정수. 원문에 적힌 금액 그대로이고 부가세를 더하거나 빼지 않는다.
 *   부가세가 들었는지는 vat_included 에 따로 적는다.
 * - price_krw 는 대표 판매가다. 기간·수량 옵션이 있으면 가장 짧은 기간(가장 적은 수량) 옵션의 값이다.
 * - list_price_krw 는 정가(할인 전 값). 원문에 정가가 따로 없으면 "없음".
 * - 날짜 수는 "며칠 전까지"를 일수로 적는다. 1주 = 7일, 1개월 = 30일.
 * - footfall_per_day 는 하루 유동인구. 월 단위는 30 으로, 주 단위는 7 로, 연 단위는 365 로 나눠 반올림한다.
 * - 글 칸(name, region, service_region, material)은 앞뒤 공백을 뗀 글자 그대로다.
 * - file_format 은 소문자 확장자 목록(가나다·알파벳 순). 예: ["jpg", "mp4"].
 * - 목록 칸은 키(일수·수량)가 작은 것부터 적는다.
 */
export const FIELD_SCHEMAS = {
  // 공통
  name: text,
  price_krw: int,
  list_price_krw: int,
  vat_included: z.boolean(),
  // 광고 지면
  region: text,
  size_m: SizeMSchema,
  resolution_px: ResolutionSchema,
  hours: HoursSchema,
  spot_seconds: int,
  plays_per_day: int,
  footfall_per_day: int,
  period_options: z.array(PeriodOptionSchema),
  material_deadline_days: int,
  file_format: z.array(text),
  refund_full_days: int,
  booking_deadline_days: int,
  // 케이터링
  service_region: text,
  quantity_options: z.array(QuantityOptionSchema),
  service_hours: HoursSchema,
  design_deadline_days: int,
  // 굿즈
  size_mm: SizeMmSchema,
  material: text,
  lead_time_days: int,
  min_order_qty: int,
} as const;

export type FieldKey = keyof typeof FIELD_SCHEMAS;
export type FieldValueMap = { [K in FieldKey]: z.infer<(typeof FIELD_SCHEMAS)[K]> };
export type FieldValue = FieldValueMap[FieldKey];

/** 칸 값들. 없으면 null. */
export type FieldValues = Partial<Record<FieldKey, FieldValue | null>>;

// ── 칸 정의 ────────────────────────────────────────────────

/** 값의 꼴 갈래. 맞추기와 일치 판정이 이것으로 길을 고른다. */
export type FieldKind =
  | 'text' // 글자
  | 'money' // 원
  | 'bool'
  | 'count' // 그냥 정수(초, 횟수, 개수)
  | 'days' // 일수
  | 'footfall' // 하루 유동인구
  | 'size_m'
  | 'size_mm'
  | 'resolution'
  | 'hours'
  | 'period_options'
  | 'quantity_options'
  | 'formats';

export type FieldGroup = 'common' | ProductType;

export interface FieldDef {
  key: FieldKey;
  /** 화면에 보이는 이름 */
  label: string;
  group: FieldGroup;
  kind: FieldKind;
  /** 뽑는 쪽이 읽는 한 줄 설명 */
  hint: string;
}

/** 칸 정의. 순서가 곧 화면과 양식의 순서다. */
export const FIELD_DEFS: readonly FieldDef[] = [
  { key: 'name', label: '상품 이름', group: 'common', kind: 'text', hint: '상품이나 지면의 이름' },
  { key: 'price_krw', label: '판매가(원)', group: 'common', kind: 'money', hint: '대표 판매가. 옵션이 있으면 가장 짧은 기간(가장 적은 수량)의 값' },
  { key: 'list_price_krw', label: '정가(원)', group: 'common', kind: 'money', hint: '할인 전 값. 따로 적혀 있을 때만' },
  { key: 'vat_included', label: '부가세 포함', group: 'common', kind: 'bool', hint: '적힌 금액에 부가세가 들었는가' },

  { key: 'region', label: '위치', group: 'ad', kind: 'text', hint: '역이나 동네' },
  { key: 'size_m', label: '크기(m)', group: 'ad', kind: 'size_m', hint: '가로·세로, m' },
  { key: 'resolution_px', label: '해상도(px)', group: 'ad', kind: 'resolution', hint: '가로·세로, px' },
  { key: 'hours', label: '운영 시간', group: 'ad', kind: 'hours', hint: '시작·끝·다음 날 여부' },
  { key: 'spot_seconds', label: '한 번 길이(초)', group: 'ad', kind: 'count', hint: '광고 한 번의 길이' },
  { key: 'plays_per_day', label: '하루 송출 횟수', group: 'ad', kind: 'count', hint: '하루에 몇 번 나오는가' },
  { key: 'footfall_per_day', label: '하루 유동인구(명)', group: 'ad', kind: 'footfall', hint: '하루 기준으로 바꾼 값' },
  { key: 'period_options', label: '기간 옵션', group: 'ad', kind: 'period_options', hint: '(일수, 원) 목록' },
  { key: 'material_deadline_days', label: '소재 마감(일 전)', group: 'ad', kind: 'days', hint: '게재 며칠 전까지 소재를 내야 하는가' },
  { key: 'file_format', label: '소재 파일 형식', group: 'ad', kind: 'formats', hint: '확장자 목록' },
  { key: 'refund_full_days', label: '전액 환불(일 전)', group: 'ad', kind: 'days', hint: '게재 며칠 전까지 전액 환불인가' },
  { key: 'booking_deadline_days', label: '예약 마감(일 전)', group: 'ad', kind: 'days', hint: '게재 며칠 전까지 예약해야 하는가' },

  { key: 'service_region', label: '출장 지역', group: 'catering', kind: 'text', hint: '갈 수 있는 지역' },
  { key: 'quantity_options', label: '수량 옵션', group: 'catering', kind: 'quantity_options', hint: '(수량, 원) 목록' },
  { key: 'service_hours', label: '운영 시간', group: 'catering', kind: 'hours', hint: '시작·끝·다음 날 여부' },
  { key: 'design_deadline_days', label: '시안 마감(일 전)', group: 'catering', kind: 'days', hint: '행사 며칠 전까지 시안을 내야 하는가' },

  { key: 'size_mm', label: '크기(mm)', group: 'goods', kind: 'size_mm', hint: '가로·세로, mm' },
  { key: 'material', label: '재질', group: 'goods', kind: 'text', hint: '종이나 소재 이름' },
  { key: 'lead_time_days', label: '제작 기간(일)', group: 'goods', kind: 'days', hint: '주문 뒤 만드는 데 걸리는 날' },
  { key: 'min_order_qty', label: '최소 주문 수량', group: 'goods', kind: 'count', hint: '한 번에 최소 몇 개' },
];

export const FIELD_KEYS = FIELD_DEFS.map((d) => d.key) as readonly FieldKey[];

const DEF_BY_KEY = new Map<string, FieldDef>(FIELD_DEFS.map((d) => [d.key, d]));

export function isFieldKey(key: string): key is FieldKey {
  return DEF_BY_KEY.has(key);
}

export function fieldDef(key: FieldKey): FieldDef {
  const def = DEF_BY_KEY.get(key);
  if (!def) throw new Error(`모르는 칸: ${key}`);
  return def;
}

const keysOf = (group: FieldGroup) => FIELD_DEFS.filter((d) => d.group === group).map((d) => d.key);

/** 공통 칸 가운데 값으로 저장되는 넷. 나머지 둘(type, subtype)은 초안에 따로 둔다. */
export const COMMON_FIELD_KEYS: readonly FieldKey[] = keysOf('common');

/** 종류별 칸(공통 넷 + 그 종류의 칸). not_product 는 칸이 없다. */
export const FIELDS_BY_TYPE: Record<DocType, readonly FieldKey[]> = {
  ad: [...COMMON_FIELD_KEYS, ...keysOf('ad')],
  catering: [...COMMON_FIELD_KEYS, ...keysOf('catering')],
  goods: [...COMMON_FIELD_KEYS, ...keysOf('goods')],
  not_product: [],
};

/** 종류별 필수 칸. 비어 있으면 REQUIRED_MISSING. */
export const REQUIRED_BY_TYPE: Record<DocType, readonly FieldKey[]> = {
  ad: ['name', 'price_krw', 'region', 'size_m', 'hours', 'footfall_per_day', 'period_options'],
  catering: ['name', 'price_krw', 'service_region', 'quantity_options'],
  goods: ['name', 'price_krw', 'size_mm'],
  not_product: [],
};

/** 필수 옵션 목록 칸. 값이 빈 목록([])이면 EMPTY_REQUIRED_OPTIONS. */
export const REQUIRED_OPTION_FIELDS: Record<DocType, readonly FieldKey[]> = {
  ad: ['period_options'],
  catering: ['quantity_options'],
  goods: [],
  not_product: [],
};

/** 칸 하나의 값이 표준 꼴인지 본다. null(없음)은 언제나 통과. */
export function parseFieldValue(field: FieldKey, value: unknown): { ok: true; value: FieldValue | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  const parsed = FIELD_SCHEMAS[field].safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data as FieldValue } : { ok: false };
}

/** 상품 이름의 최소 글자 수. 따지기(OUT_OF_RANGE)와 상품 등록 조건이 같은 값을 쓴다. */
export const PRODUCT_NAME_MIN_CHARS = 2;

// ── 사람이 고쳐 넣는 값 ────────────────────────────────────

/**
 * 사람이 고쳐 넣는 값의 크기 상한. 방문자가 큰 값을 되풀이해 넣어 DB 를 채우지 못하게 한다.
 * (모델이 뽑은 값에는 걸지 않는다. 그쪽은 원문 길이 상한과 답의 토큰 상한이 묶는다.)
 */
export const EDIT_LIMITS = {
  /** 글자 칸(상품 이름, 위치, 출장 지역, 재질)의 글자 수 */
  textMaxChars: 200,
  /** 갈래의 글자 수 */
  subtypeMaxChars: 60,
  /** 목록 칸(기간·수량 옵션, 파일 형식)의 항목 수 */
  listMaxItems: 30,
  /** 파일 형식 하나의 글자 수 */
  formatMaxChars: 20,
} as const;

/**
 * 짧은 글자 값을 정리한다. 제어 글자(NUL, 탭, 줄바꿈 등)는 빈칸으로, 짝이 없는 대리 글자는 물음표 꼴 글자로 바꾸고
 * 이어진 빈칸은 하나로, 앞뒤 빈칸은 뗀다. DB 가 받지 못하는 글자와 CSV 에서 수식으로 읽힐 수 있는 앞머리 탭이 여기서 사라진다.
 */
export function cleanShortText(input: string): string {
  return input
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type EditValueResult = { ok: true; value: FieldValue | null } | { ok: false; problem: 'shape' | 'too_long' };

/**
 * 사람이 고쳐 넣은 값 하나를 본다. 꼴(parseFieldValue)에 더해 크기 상한(EDIT_LIMITS)을 보고, 글자는 정리해 돌려준다.
 * null(없음)은 언제나 통과. 정리하고 나니 빈 글자면 꼴이 틀린 것이다.
 */
export function parseEditValue(field: FieldKey, value: unknown): EditValueResult {
  if (value === null || value === undefined) return { ok: true, value: null };
  const kind = fieldDef(field).kind;
  let input = value;
  if (kind === 'text' && typeof value === 'string') {
    input = cleanShortText(value);
    if ([...(input as string)].length > EDIT_LIMITS.textMaxChars) return { ok: false, problem: 'too_long' };
  }
  if (Array.isArray(value)) {
    if (value.length > EDIT_LIMITS.listMaxItems) return { ok: false, problem: 'too_long' };
    if (kind === 'formats') {
      input = value.map((v) => (typeof v === 'string' ? cleanShortText(v) : v));
      if ((input as unknown[]).some((v) => typeof v === 'string' && [...v].length > EDIT_LIMITS.formatMaxChars)) return { ok: false, problem: 'too_long' };
    }
  }
  const parsed = parseFieldValue(field, input);
  return parsed.ok ? parsed : { ok: false, problem: 'shape' };
}

// ── 뽑기 결과 ──────────────────────────────────────────────

/** 뽑기 방식. 모델이 뽑았나, 규칙(정규식)만으로 뽑았나. */
export const EXTRACTED_BY = ['llm', 'rules'] as const;
export type ExtractedBy = (typeof EXTRACTED_BY)[number];

/**
 * 뽑은 칸 하나.
 * - raw: 원문에 적힌 표현 그대로("05시~25시"). 코드가 이것을 읽어 표준 값으로 맞춘다.
 * - value: 뽑은 쪽이 읽은 표준 값. 규칙만으로 뽑았을 때는 null.
 * - evidence: 근거가 된 원문 구절. 원문에 그대로 있어야 한다.
 * 원문에 없는 칸은 셋 다 null 이거나 목록에서 빠진다.
 */
export interface ExtractedField {
  field: FieldKey;
  raw: string | null;
  value: FieldValue | null;
  evidence: string | null;
}

export interface Extraction {
  type: DocType;
  subtype: string | null;
  fields: ExtractedField[];
}

/**
 * 뽑기 결과의 스키마. 모델의 답은 반드시 이것으로 다시 검사한다.
 * - 모르는 칸 이름, 같은 칸 두 번, 표준 꼴이 아닌 값이면 실패한다.
 * - 갈래가 목록에 없는 것은 여기서 막지 않는다(TYPE_SUBTYPE_MISMATCH 사유로 사람에게 보인다).
 * - 그 종류에 없는 칸이 섞여 온 것도 여기서 막지 않는다. 따지는 쪽이 버린다.
 *
 * 모델에게 요구하는 출력 꼴은 src/llm 이 따로 정해도 된다. 받은 뒤 이 꼴로 바꿔 내보내면 된다.
 */
export const ExtractionSchema: z.ZodType<Extraction> = z
  .object({
    type: z.enum(DOC_TYPES),
    subtype: z.string().min(1).nullable(),
    fields: z.array(
      z.object({
        field: z.enum(FIELD_KEYS as [FieldKey, ...FieldKey[]]),
        raw: z.string().nullable(),
        value: z.unknown().nullable(),
        evidence: z.string().nullable(),
      }),
    ),
  })
  .superRefine((ex, ctx) => {
    const seen = new Set<string>();
    ex.fields.forEach((f, i) => {
      if (seen.has(f.field)) {
        ctx.addIssue({ code: 'custom', path: ['fields', i, 'field'], message: `같은 칸이 두 번 왔다: ${f.field}` });
      }
      seen.add(f.field);
      if (!parseFieldValue(f.field, f.value).ok) {
        ctx.addIssue({ code: 'custom', path: ['fields', i, 'value'], message: `값의 꼴이 다르다: ${f.field}` });
      }
    });
  })
  .transform((ex) => ({
    type: ex.type,
    subtype: ex.subtype,
    fields: ex.fields.map((f) => ({
      field: f.field,
      raw: f.raw,
      value: (f.value ?? null) as FieldValue | null,
      evidence: f.evidence,
    })),
  })) as unknown as z.ZodType<Extraction>;
