// 달력의 약속. 기념일에 맞추려면 지면마다 언제까지 무엇을 해야 하는지 거꾸로 센다.
// 본체가 채운 마감 일수 칸(예약 마감, 소재 마감 등)을 그대로 읽는다. LLM 을 쓰지 않고 저장하지 않는다.
//
//   GET /api/calendar?date=2027-03-09            그 날짜를 기념일로 보고 센다
//   GET /api/calendar?anniversary=<번호>          목록의 기념일을 고른다(오늘 이후 처음 오는 그 날)
//   GET /api/calendar                            기념일 목록과 다음 날짜만(items 는 빈 목록)
//   &today=2026-10-12                            (선택) 오늘. 비우면 서버의 한국 날짜
//
// 날짜 세기는 src/tools/shared/deadline.ts 의 순수 함수가 한다(견적과 같은 함수). 마감의 뜻과 상태는 dates.ts 에 있다.
import { z } from 'zod';
import { PRODUCT_TYPES } from '../fields';
import { DEADLINE_STATUSES, DeadlineSchema, IsoDateSchema } from './dates';

// ── 기념일 목록(data/seed/anniversaries.json) ───────────────

export const ANNIVERSARY_KINDS = ['birthday', 'debut'] as const;
export type AnniversaryKind = (typeof ANNIVERSARY_KINDS)[number];

export const ANNIVERSARY_KIND_LABELS: Record<AnniversaryKind, string> = { birthday: '생일', debut: '데뷔일' };

/**
 * 기념일 한 줄. 해마다 돌아오는 날이라 달과 일만 적는다. 가수와 그룹 이름은 전부 지어낸 것이다.
 * 2월 29일은 윤년이 아닌 해에는 2월 28일로 센다.
 */
export const AnniversarySchema = z.object({
  /** 'ann-01' 처럼 */
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  /** 지어낸 가수(또는 그룹)의 이름 */
  artist: z.string().min(1).max(60),
  kind: z.enum(ANNIVERSARY_KINDS),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
});
export type Anniversary = z.infer<typeof AnniversarySchema>;

export const AnniversaryFileSchema = z.array(AnniversarySchema).min(1).max(100);

// ── 경로의 꼴 ───────────────────────────────────────────────

/** GET /api/calendar 의 주소 값. date 와 anniversary 를 함께 주면 400. 모르는 anniversary 면 404. */
export const CalendarQuerySchema = z
  .object({
    date: IsoDateSchema.optional(),
    anniversary: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
    today: IsoDateSchema.optional(),
  })
  .refine((q) => !(q.date && q.anniversary), 'date 와 anniversary 는 하나만 준다');
export type CalendarQuery = z.infer<typeof CalendarQuerySchema>;

/**
 * 지면(상품) 하나의 결과.
 * - deadlines: 그 종류의 마감(dates.ts 의 DEADLINE_FIELDS) 가운데 일수가 적힌 것만 센 결과. 날짜가 이른 것부터.
 * - missing: 일수가 비어 세지 못한 마감의 갈래.
 * - status: 센 마감 가운데 가장 급한 것(late > closing > open). 센 마감이 하나도 없으면 unknown("마감 일수 없음").
 * - daysLeft: 가장 이른 마감까지 남은 날. 세지 못했으면 null.
 */
export const CALENDAR_ITEM_STATUSES = [...DEADLINE_STATUSES, 'unknown'] as const;
export type CalendarItemStatus = (typeof CALENDAR_ITEM_STATUSES)[number];

export const CalendarItemSchema = z.object({
  productId: z.number().int().positive(),
  name: z.string(),
  type: z.enum(PRODUCT_TYPES),
  subtype: z.string(),
  deadlines: z.array(DeadlineSchema),
  missing: z.array(z.string()),
  status: z.enum(CALENDAR_ITEM_STATUSES),
  daysLeft: z.number().int().nullable(),
});
export type CalendarItem = z.infer<typeof CalendarItemSchema>;

/** GET /api/calendar 의 응답. */
export const CalendarResponseSchema = z.object({
  /** 계산에 쓴 오늘 */
  today: IsoDateSchema,
  /** 기준이 된 기념일 날짜. 날짜도 기념일도 고르지 않았으면 null. */
  eventDate: IsoDateSchema.nullable(),
  /** 고른 기념일. date 로 불렀으면 null. */
  anniversary: AnniversarySchema.nullable(),
  /** 기념일 목록과, 오늘 이후(오늘 포함) 처음 오는 그 날. 다음 날짜가 이른 것부터. */
  anniversaries: z.array(AnniversarySchema.extend({ next: IsoDateSchema, daysUntil: z.number().int().min(0) })),
  /** 이 공간에 등록된 상품 전부. 급한 것부터(late, closing, open, unknown), 같으면 남은 날이 적은 것부터. */
  items: z.array(CalendarItemSchema),
  counts: z.record(z.enum(CALENDAR_ITEM_STATUSES), z.number().int().min(0)),
});
export type CalendarResponse = z.infer<typeof CalendarResponseSchema>;

// ── src/tools/calendar 가 내보낼 순수 함수의 꼴 ─────────────

export interface CalendarProduct {
  id: number;
  type: (typeof PRODUCT_TYPES)[number];
  subtype: string;
  name: string;
  spec: Record<string, unknown>;
}

export interface CalendarApi {
  /** 오늘 이후(오늘 포함) 처음 오는 그 달·일. 2월 29일은 평년에 2월 28일. */
  nextOccurrence(month: number, day: number, today: string): string;
  /** 기념일 날짜와 오늘로 상품 하나의 마감을 센다. */
  planItem(product: CalendarProduct, eventDate: string, today: string): CalendarItem;
  /** 상품 목록 전체를 세고 급한 순서로 놓는다. */
  planCalendar(products: readonly CalendarProduct[], eventDate: string, today: string): Pick<CalendarResponse, 'items' | 'counts'>;
}
