// 비교의 약속. 등록된 상품을 같은 잣대로 나란히 놓는다. 결정 문서는 docs/PRD-TOOLS.md 3-7.
// 본체가 채운 칸(기간·수량 옵션, 유동인구, 크기, 운영 시간, 마감 일수)을 그대로 읽는다. LLM 을 쓰지 않고 저장하지 않는다.
//
//   GET /api/compare                                   이 공간의 상품 전부(번호순). 차례를 매기지 않는다
//   GET /api/compare?type=ad&subtype=전광판&region=합정   종류·갈래·지역 글자로 거른다
//   &sort=per_day_krw&order=asc                        잣대 하나로 차례를 매긴다(order 를 비우면 그 잣대의 좋은 쪽이 앞)
//   &ids=5,7,10                                        2~4개를 골라 나란히 놓는다(거르기와 따로다. 모르는 번호가 있으면 404)
//
// 지키는 것(계산은 src/tools/compare 의 순수 함수가 한다):
// - 값이 없는 칸은 없음이다. 다른 칸에서 짐작해 채우지 않는다. 왜 없는지(missing)를 함께 낸다.
// - 하루당 값은 실제 옵션 하나의 값 ÷ 그 옵션의 일수다. 옵션에 없는 기간의 값을 지어내지 않고, 어느 옵션에서 계산했는지(basis)를 함께 낸다.
// - 금액은 상품에 적힌 그대로다. 부가세를 더하지도 빼지도 않는다. 포함과 별도가 섞인 묶음은 경고를 내고,
//   돈 잣대로 차례를 매길 때는 부가세가 같은 것끼리만 차례를 매긴다(합쳐 견주지 않는다).
// - 판매가는 종류마다 뜻이 다르다(광고는 기간 옵션 값, 케이터링은 수량 옵션 값, 굿즈는 낱개 값). 종류가 섞이면 종류끼리만 차례를 매긴다.
// - "좋은 쪽"은 같은 것끼리만 붙인다: 종류가 같고, 돈이면 부가세가 같고, 옵션에서 나눈 값이면 그 옵션의 기간(수량)이 같을 때.
// - 나누어떨어지지 않으면 원 단위로 반올림하고 rounded 로 알린다.
import { z } from 'zod';
import { PRODUCT_TYPES, SUBTYPES, type ProductType } from '../fields';

// ── 잣대 ────────────────────────────────────────────────────

/** 숫자로 견줄 수 있는 잣대. 모두 차례를 매길 수 있다. */
export const COMPARE_METRICS = [
  'per_day_krw',
  'per_1000_footfall_krw',
  'footfall_per_day',
  'area_m2',
  'open_minutes',
  'plays_per_day',
  'spot_seconds',
  'exposure_seconds',
  'booking_deadline_days',
  'material_deadline_days',
  'refund_full_days',
  'unit_krw_min_qty',
  'unit_krw_max_qty',
  'design_deadline_days',
  'price_krw',
  'min_order_qty',
  'lead_time_days',
] as const;
export type CompareMetric = (typeof COMPARE_METRICS)[number];

export type CompareUnit = 'krw' | 'people' | 'm2' | 'minutes' | 'count' | 'seconds' | 'days' | 'qty';

export interface CompareMetricDef {
  key: CompareMetric;
  /** 화면에 보이는 이름 */
  label: string;
  unit: CompareUnit;
  /** 이 잣대가 있는 종류. 다른 종류의 상품에서는 "해당 없음"이다. */
  types: readonly ProductType[];
  /**
   * 어느 쪽이 좋은가. lower: 작을수록 좋다, higher: 클수록 좋다, null: 어느 쪽이 좋다고 말할 수 없다(크기, 한 번 길이).
   * 나란히 놓을 때 "좋은 쪽" 표시는 null 이 아닌 잣대에만 붙는다.
   * 옵션에서 나눈 잣대(하루당 값, 유동인구 1,000명당 값, 한 개당 값)는 나눈 옵션의 기간(수량)이 모두 같을 때만 붙는다.
   */
  better: 'lower' | 'higher' | null;
  /**
   * better 가 이 종류에서만 뜻이 있다. 판매가는 굿즈에서만 그대로 견줄 수 있다(광고·케이터링의 판매가는 서로 다른 기간·수량의 값이다).
   * 이런 잣대는 종류마다 뜻이 다르므로, 종류가 섞인 묶음에서는 종류끼리 묶어 그 안에서만 차례를 매긴다.
   */
  betterOnlyFor?: readonly ProductType[];
  /** 돈 잣대인가. 부가세가 섞인 묶음에서는 합쳐 견주지 않는다. */
  money: boolean;
  /** 한 줄 풀이 */
  hint: string;
}

/** 잣대의 정의. 순서가 곧 표의 칸 순서다. */
export const COMPARE_METRIC_DEFS: readonly CompareMetricDef[] = [
  { key: 'per_day_krw', label: '하루당 값', unit: 'krw', types: ['ad'], better: 'lower', money: true, hint: '가장 짧은 기간 옵션의 값 ÷ 그 옵션의 일수' },
  { key: 'per_1000_footfall_krw', label: '유동인구 1,000명당 값', unit: 'krw', types: ['ad'], better: 'lower', money: true, hint: '가장 짧은 기간 옵션의 값 × 1,000 ÷ (일수 × 하루 유동인구). 둘 다 있을 때만' },
  { key: 'footfall_per_day', label: '하루 유동인구', unit: 'people', types: ['ad'], better: 'higher', money: false, hint: '상품에 적힌 값 그대로' },
  { key: 'area_m2', label: '화면 넓이', unit: 'm2', types: ['ad'], better: null, money: false, hint: '가로 × 세로' },
  { key: 'open_minutes', label: '하루 운영 시간', unit: 'minutes', types: ['ad', 'catering'], better: 'higher', money: false, hint: '시작부터 끝까지. 다음 날로 넘어가면 그만큼 더한다' },
  { key: 'plays_per_day', label: '하루 송출 횟수', unit: 'count', types: ['ad'], better: 'higher', money: false, hint: '상품에 적힌 값 그대로' },
  { key: 'spot_seconds', label: '한 번 길이', unit: 'seconds', types: ['ad'], better: null, money: false, hint: '상품에 적힌 값 그대로' },
  { key: 'exposure_seconds', label: '하루 노출 시간', unit: 'seconds', types: ['ad'], better: 'higher', money: false, hint: '하루 송출 횟수 × 한 번 길이. 둘 다 있을 때만' },
  { key: 'booking_deadline_days', label: '예약 마감', unit: 'days', types: ['ad'], better: 'lower', money: false, hint: '게재 며칠 전까지. 적을수록 늦게까지 받는다' },
  { key: 'material_deadline_days', label: '소재 마감', unit: 'days', types: ['ad'], better: 'lower', money: false, hint: '게재 며칠 전까지. 적을수록 늦게까지 받는다' },
  { key: 'refund_full_days', label: '전액 환불', unit: 'days', types: ['ad'], better: 'lower', money: false, hint: '게재 며칠 전까지. 적을수록 늦게까지 전액 환불이다' },
  { key: 'unit_krw_min_qty', label: '한 개당 값(가장 적은 수량)', unit: 'krw', types: ['catering'], better: 'lower', money: true, hint: '가장 적은 수량 옵션의 값 ÷ 그 수량' },
  { key: 'unit_krw_max_qty', label: '한 개당 값(가장 많은 수량)', unit: 'krw', types: ['catering'], better: 'lower', money: true, hint: '가장 많은 수량 옵션의 값 ÷ 그 수량' },
  { key: 'design_deadline_days', label: '시안 마감', unit: 'days', types: ['catering'], better: 'lower', money: false, hint: '행사 며칠 전까지. 적을수록 늦게까지 받는다' },
  { key: 'price_krw', label: '판매가', unit: 'krw', types: ['ad', 'catering', 'goods'], better: 'lower', betterOnlyFor: ['goods'], money: true, hint: '대표 판매가. 광고·케이터링은 가장 작은 옵션의 값이라 서로 기간·수량이 다를 수 있다' },
  { key: 'min_order_qty', label: '최소 주문 수량', unit: 'qty', types: ['goods'], better: 'lower', money: false, hint: '상품에 적힌 값 그대로' },
  { key: 'lead_time_days', label: '제작 기간', unit: 'days', types: ['goods'], better: 'lower', money: false, hint: '주문 뒤 만드는 데 걸리는 날' },
];

const DEF_BY_KEY = new Map<string, CompareMetricDef>(COMPARE_METRIC_DEFS.map((d) => [d.key, d]));

export function compareMetricDef(key: CompareMetric): CompareMetricDef {
  const def = DEF_BY_KEY.get(key);
  if (!def) throw new Error(`모르는 잣대: ${key}`);
  return def;
}

/** 그 종류에 있는 잣대(표의 칸 순서대로). */
export function metricsOfType(type: ProductType): CompareMetric[] {
  return COMPARE_METRIC_DEFS.filter((d) => d.types.includes(type)).map((d) => d.key);
}

// ── 값 하나 ─────────────────────────────────────────────────

/**
 * 값이 없는 까닭.
 * - no_value: 계산에 쓸 칸이 비어 있다(fields 에 그 칸 이름).
 * - no_period: 기간 옵션이 없고 판매가만 있다. 기간을 몰라 하루당 값을 내지 못한다.
 * - no_quantity: 수량 옵션이 없고 판매가만 있다. 수량을 몰라 한 개당 값을 내지 못한다.
 * - bad_value: 칸은 있지만 계산할 수 없는 값이다(0 이하, 하루를 넘는 운영 시간 등).
 * - not_applicable: 이 종류에는 없는 잣대다.
 */
export const COMPARE_MISSING_REASONS = ['no_value', 'no_period', 'no_quantity', 'bad_value', 'not_applicable'] as const;
export type CompareMissingReason = (typeof COMPARE_MISSING_REASONS)[number];

const posInt = z.number().int().positive();

/** 어디서 계산했는지. 화면이 값 옆에 작은 글씨로 적는다("7일 옵션 1,500,000원 ÷ 7"). */
export const CompareBasisSchema = z.discriminatedUnion('kind', [
  /** 기간 옵션 하나의 값 ÷ 그 옵션의 일수 */
  z.object({ kind: z.literal('period_option'), days: posInt, price_krw: posInt }),
  /** 기간 옵션 하나의 값 ÷ 일수 ÷ 하루 유동인구 × 1,000 */
  z.object({ kind: z.literal('per_footfall'), days: posInt, price_krw: posInt, footfall: posInt }),
  /** 수량 옵션 하나의 값 ÷ 그 수량 */
  z.object({ kind: z.literal('quantity_option'), qty: posInt, price_krw: posInt }),
  /** 가로 × 세로(m) */
  z.object({ kind: z.literal('size'), width: z.number().positive(), height: z.number().positive() }),
  /** 운영 시간의 시작과 끝 */
  z.object({ kind: z.literal('hours'), open: z.string(), close: z.string(), nextDay: z.boolean() }),
  /** 하루 송출 횟수 × 한 번 길이 */
  z.object({ kind: z.literal('exposure'), plays: posInt, seconds: posInt }),
  /** 칸의 값을 그대로 읽었다 */
  z.object({ kind: z.literal('field'), field: z.string() }),
]);
export type CompareBasis = z.infer<typeof CompareBasisSchema>;

/**
 * 잣대 하나의 값. value 가 있으면 missing 은 null 이고, value 가 null 이면 missing 에 까닭이 있다.
 * rounded: 나누어떨어지지 않아 반올림했다(원 단위).
 */
export const CompareValueSchema = z
  .object({
    value: z.number().nullable(),
    rounded: z.boolean(),
    basis: CompareBasisSchema.nullable(),
    missing: z.object({ reason: z.enum(COMPARE_MISSING_REASONS), fields: z.array(z.string()) }).nullable(),
  })
  .refine((v) => (v.value === null) !== (v.missing === null), '값과 없음의 까닭은 하나만 있다');
export type CompareValue = z.infer<typeof CompareValueSchema>;

/** 옵션 하나에서 낸 값. 광고는 기간 옵션마다 하루당 값, 케이터링은 수량 옵션마다 한 개당 값. */
export const CompareOptionSchema = z.object({
  kind: z.enum(['period', 'quantity']),
  /** 일수 또는 수량 */
  size: posInt,
  price_krw: posInt,
  /** 값 ÷ size (원 단위 반올림) */
  each: z.number().int().min(0),
  rounded: z.boolean(),
});
export type CompareOption = z.infer<typeof CompareOptionSchema>;

/** 돈 잣대로 차례를 매길 때 부가세가 섞였으면 같은 것끼리 묶는다. */
export const COMPARE_RANK_GROUPS = ['vat_excluded', 'vat_included', 'vat_unknown'] as const;
export type CompareRankGroup = (typeof COMPARE_RANK_GROUPS)[number];

/** 상품 하나의 견줄 값. */
export const CompareRowSchema = z.object({
  productId: z.number().int().positive(),
  name: z.string(),
  type: z.enum(PRODUCT_TYPES),
  subtype: z.string(),
  /** 광고는 위치, 케이터링은 출장 지역. 굿즈는 없다(null). */
  region: z.string().nullable(),
  /** 적힌 금액에 부가세가 들었는가. 상품에 적혀 있지 않으면 null(모름). */
  vatIncluded: z.boolean().nullable(),
  values: z.record(z.enum(COMPARE_METRICS), CompareValueSchema),
  /** 옵션마다 낸 값. 작은 것부터. 옵션이 없으면 빈 목록. */
  options: z.array(CompareOptionSchema),
  /** 적혀 있지만 쓸 수 없어 계산에서 뺀 옵션 수(일수·수량·값이 0 이하이거나 꼴이 틀린 것). 없으면 0. */
  optionsSkipped: z.number().int().min(0),
  /**
   * 차례. 차례를 매기지 않았거나 그 잣대의 값이 없으면 null. rankType·rankGroup 이 있으면 그 묶음 안에서의 차례다.
   * 같은 값은 같은 차례이고 다음 차례는 그만큼 건너뛴다(1, 1, 3). 놓는 순서는 번호순이다.
   */
  rank: z.number().int().positive().nullable(),
  /** 종류끼리 묶어 차례를 매겼을 때 그 종류. 아니면 null. */
  rankType: z.enum(PRODUCT_TYPES).nullable(),
  rankGroup: z.enum(COMPARE_RANK_GROUPS).nullable(),
});
export type CompareRow = z.infer<typeof CompareRowSchema>;

// ── 묶음의 경고 ─────────────────────────────────────────────

export const CompareWarningSchema = z.discriminatedUnion('code', [
  /** 부가세 포함·별도(·모름)가 섞였다. metrics 는 그래서 합쳐 견주지 않는 돈 잣대. */
  z.object({
    code: z.literal('vat_mixed'),
    included: z.number().int().min(0),
    excluded: z.number().int().min(0),
    unknown: z.number().int().min(0),
    metrics: z.array(z.enum(COMPARE_METRICS)),
  }),
  /** 종류가 섞였다. metrics 는 그래서 묶음 전체로는 견줄 수 없는 잣대(어떤 종류에는 없는 칸). */
  z.object({ code: z.literal('mixed_types'), types: z.array(z.enum(PRODUCT_TYPES)), metrics: z.array(z.enum(COMPARE_METRICS)) }),
]);
export type CompareWarning = z.infer<typeof CompareWarningSchema>;

// ── 나란히 놓기 ─────────────────────────────────────────────

/** 숫자 잣대가 아닌 사실 칸. */
export const COMPARE_FACTS = ['type', 'subtype', 'region', 'vat'] as const;
export type CompareFact = (typeof COMPARE_FACTS)[number];

/**
 * "좋은 쪽" 표시를 붙이지 않은 까닭.
 * - no_direction: 어느 쪽이 좋다고 말할 수 없는 잣대다.
 * - mixed_types: 값이 있는 상품의 종류가 섞였다.
 * - vat_mixed: 돈 잣대인데 부가세 포함 여부가 섞였거나 모른다.
 * - too_few: 값이 있는 상품이 둘이 안 된다.
 * - all_same: 값이 모두 같다.
 * - mixed_basis: 옵션에서 나눈 값인데 그 옵션의 기간(수량)이 서로 다르다. 긴 옵션일수록 하루당 값이 싸지기 쉬워 그대로 견주지 않는다.
 */
export const COMPARE_BEST_WITHHELD = ['no_direction', 'mixed_types', 'vat_mixed', 'too_few', 'all_same', 'mixed_basis'] as const;
export type CompareBestWithheld = (typeof COMPARE_BEST_WITHHELD)[number];

export const CompareSideSchema = z.object({
  /** 고른 차례 그대로 */
  productIds: z.array(z.number().int().positive()).min(2).max(4),
  rows: z.array(CompareRowSchema).min(2).max(4),
  facts: z.array(z.object({ fact: z.enum(COMPARE_FACTS), differs: z.boolean() })),
  /** 고른 상품의 종류 가운데 하나에라도 있는 잣대만. */
  metrics: z.array(
    z.object({
      metric: z.enum(COMPARE_METRICS),
      /** 칸의 값이 서로 다른가. 없음과 값이 섞여도 다르다. 모두 없음이면 같다. */
      differs: z.boolean(),
      /** 가장 좋은 쪽의 상품 번호(같은 값이면 여럿). 표시하지 않으면 빈 목록이고 bestWithheld 에 까닭이 있다. */
      best: z.array(z.number().int().positive()),
      bestWithheld: z.enum(COMPARE_BEST_WITHHELD).nullable(),
    }),
  ),
  warnings: z.array(CompareWarningSchema),
});
export type CompareSide = z.infer<typeof CompareSideSchema>;

// ── 경로의 꼴 ───────────────────────────────────────────────

export const COMPARE_LIMITS = {
  /** 지역 글자의 길이 */
  regionMaxChars: 60,
  /** 나란히 놓는 상품 수 */
  sideMin: 2,
  sideMax: 4,
} as const;

const ALL_SUBTYPES: readonly string[] = PRODUCT_TYPES.flatMap((t) => [...SUBTYPES[t]]);

/**
 * GET /api/compare 의 주소 값. 아래는 모두 400 이다:
 * 모르는 종류·갈래·잣대, 종류와 맞지 않는 갈래, sort 없는 order, ids 가 2~4개가 아니거나 같은 번호가 두 번.
 */
export const CompareQuerySchema = z
  .object({
    type: z.enum(PRODUCT_TYPES).optional(),
    subtype: z.string().refine((s) => ALL_SUBTYPES.includes(s), '모르는 갈래').optional(),
    region: z.string().trim().min(1).max(COMPARE_LIMITS.regionMaxChars).optional(),
    sort: z.enum(COMPARE_METRICS).optional(),
    order: z.enum(['asc', 'desc']).optional(),
    ids: z
      .string()
      .regex(/^[1-9][0-9]{0,14}(,[1-9][0-9]{0,14}){1,3}$/)
      .transform((s) => s.split(',').map(Number))
      .refine((ids) => new Set(ids).size === ids.length, '같은 번호가 두 번 왔다')
      .optional(),
  })
  .refine((q) => !(q.order && !q.sort), 'order 는 sort 와 함께 준다')
  .refine((q) => !(q.type && q.subtype) || (SUBTYPES[q.type] as readonly string[]).includes(q.subtype), '종류와 갈래가 맞지 않는다');
export type CompareQuery = z.infer<typeof CompareQuerySchema>;

/** GET /api/compare 의 응답. */
export const CompareResponseSchema = z.object({
  /** 이 공간에 등록된 상품 수(거르기 전) */
  total: z.number().int().min(0),
  /** 쓴 거르기. 안 준 것은 null. */
  filter: z.object({ type: z.enum(PRODUCT_TYPES).nullable(), subtype: z.string().nullable(), region: z.string().nullable() }),
  /**
   * 차례를 매긴 잣대. 안 매겼으면 null(번호순).
   * split: 돈 잣대인데 그 잣대의 값이 있는 줄의 부가세가 섞여, 부가세가 같은 것끼리만 차례를 매겼다(별도 → 포함 → 모름 순으로 놓는다).
   * byType: 종류마다 뜻이 다른 잣대(판매가)인데 값이 있는 줄의 종류가 섞여, 종류가 같은 것끼리만 차례를 매겼다(광고 → 케이터링 → 굿즈 순).
   */
  sort: z.object({ metric: z.enum(COMPARE_METRICS), order: z.enum(['asc', 'desc']), split: z.boolean(), byType: z.boolean() }).nullable(),
  /** 거른 상품. 값이 없는 것은 맨 뒤, 같은 값은 번호순(차례는 같다). */
  rows: z.array(CompareRowSchema),
  /** rows 묶음의 경고 */
  warnings: z.array(CompareWarningSchema),
  /** ids 를 줬을 때만. */
  side: CompareSideSchema.nullable(),
});
export type CompareResponse = z.infer<typeof CompareResponseSchema>;

// ── src/tools/compare 가 받는 상품의 꼴 ─────────────────────

export interface CompareProduct {
  id: number;
  type: ProductType;
  subtype: string;
  name: string;
  price_krw: number;
  vat_included: boolean | null;
  spec: Record<string, unknown>;
  options: readonly unknown[];
}
