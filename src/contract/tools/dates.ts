// 날짜와 마감의 약속. 견적과 달력이 같은 꼴과 같은 규칙을 쓴다.
// 날짜 세기 자체(더하기·빼기·마감 판정)는 src/tools/shared/deadline.ts 의 순수 함수 하나가 한다. 두 도구가 따로 세지 않는다.
import { z } from 'zod';
import type { FieldKey, ProductType } from '../fields';

/** 'YYYY-MM-DD'. 달력에 있는 날짜만 통과한다(2월 30일, 평년의 2월 29일은 안 된다). 시각과 시간대는 없다. */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((text) => isRealDate(text), '달력에 없는 날짜다');
export type IsoDate = string;

/** 'YYYY-MM-DD' 가 달력에 있는 날짜인가. */
export function isRealDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1900 || year > 2200) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

/**
 * 마감의 상태 셋.
 * - open: 아직 됨(마감까지 closingWithinDays 일보다 많이 남았다)
 * - closing: 곧 마감(마감 당일 포함, 남은 날이 0 ~ closingWithinDays)
 * - late: 이미 늦음(마감일이 오늘보다 앞이다)
 */
export const DEADLINE_STATUSES = ['open', 'closing', 'late'] as const;
export type DeadlineStatus = (typeof DEADLINE_STATUSES)[number];

export const DEADLINE_STATUS_LABELS: Record<DeadlineStatus, string> = {
  open: '아직 됨',
  closing: '곧 마감',
  late: '이미 늦음',
};

/**
 * 마감을 세는 규칙.
 * - 마감일 = 기준일(게재 시작일·행사일·기념일) − 일수. "7일 전까지"면 기준일의 7일 전 날짜가 마감일이고, 그날까지는 된다.
 * - 남은 날 = 마감일 − 오늘. 마감 당일은 0, 지났으면 음수.
 * - 하루의 경계는 한국 날짜다. 오늘은 인자로 받는다(서버는 kstDay(now) 를 넘긴다).
 */
export const DEADLINE_RULES = {
  /** 남은 날이 이 값 이하(0 포함)이면 "곧 마감" */
  closingWithinDays: 3,
} as const;

/**
 * 마감의 갈래와, 그 일수가 든 상품 칸.
 * - booking: 예약 마감(광고)      - material: 소재 마감(광고)
 * - design: 시안 마감(케이터링)   - order: 주문 마감(굿즈. 제작 기간만큼 앞서 주문해야 한다)
 */
export const DEADLINE_KINDS = ['booking', 'material', 'design', 'order'] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];

export const DEADLINE_KIND_LABELS: Record<DeadlineKind, string> = {
  booking: '예약 마감',
  material: '소재 마감',
  design: '시안 마감',
  order: '주문 마감',
};

/** 종류별로 어느 칸이 어느 마감인가. 칸 값(일수)은 상품의 spec 에서 그대로 읽는다. */
export const DEADLINE_FIELDS: Record<ProductType, readonly { kind: DeadlineKind; field: FieldKey }[]> = {
  ad: [
    { kind: 'booking', field: 'booking_deadline_days' },
    { kind: 'material', field: 'material_deadline_days' },
  ],
  catering: [{ kind: 'design', field: 'design_deadline_days' }],
  goods: [{ kind: 'order', field: 'lead_time_days' }],
};

/** 마감 하나를 센 결과. */
export const DeadlineSchema = z.object({
  kind: z.enum(DEADLINE_KINDS),
  /** 일수가 든 칸 이름 */
  field: z.string(),
  /** 기준일 며칠 전까지인가(상품에 적힌 값 그대로) */
  days: z.number().int(),
  /** 마감일 */
  date: IsoDateSchema,
  /** 마감일 − 오늘. 지났으면 음수. */
  daysLeft: z.number().int(),
  status: z.enum(DEADLINE_STATUSES),
});
export type Deadline = z.infer<typeof DeadlineSchema>;
