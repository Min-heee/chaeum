// 지면별 마감 거꾸로 세기의 경계: 마감 당일, 하루 전·후, 달과 해가 바뀌는 날, 윤년, 일수가 없는 상품, 오늘이 기념일보다 뒤.
import { describe, expect, it } from 'vitest';
import { CalendarItemSchema, type CalendarProduct } from '@/contract/tools/calendar';
import calendar, { CALENDAR_STATUS_LABELS, doableFirst, lastDayOfRun, nextOccurrence, planCalendar, planItem } from './index';

let serial = 0;
const product = (over: Partial<CalendarProduct>): CalendarProduct => {
  serial += 1;
  return { id: serial, type: 'ad', subtype: '전광판', name: `가상 전광판 ${serial}`, spec: {}, ...over };
};
/** 예약 마감 14일 전, 소재 마감 7일 전인 광고 지면 */
const AD = product({ id: 101, name: '합정역 가상 전광판', spec: { region: '합정역', booking_deadline_days: 14, material_deadline_days: 7 } });
const EVENT = '2027-03-09';

describe('상품 하나의 마감', () => {
  it('예약 마감일 = 기념일 − 예약 마감 일수, 소재 마감일 = 기념일 − 소재 마감 일수', () => {
    const item = planItem(AD, EVENT, '2026-10-12');
    expect(item).toEqual({
      productId: 101, name: '합정역 가상 전광판', type: 'ad', subtype: '전광판',
      deadlines: [
        { kind: 'booking', field: 'booking_deadline_days', days: 14, date: '2027-02-23', daysLeft: 134, status: 'open' },
        { kind: 'material', field: 'material_deadline_days', days: 7, date: '2027-03-02', daysLeft: 141, status: 'open' },
      ],
      missing: [], status: 'open', daysLeft: 134,
    });
    expect(CalendarItemSchema.safeParse(item).success).toBe(true);
  });

  it('마감 당일은 아직 된다(곧 마감, 남은 날 0)', () => {
    expect(planItem(AD, EVENT, '2027-02-23')).toMatchObject({ status: 'closing', daysLeft: 0 });
  });

  it('마감 하루 전은 곧 마감(남은 날 1), 하루 뒤는 이미 늦음(남은 날 −1)', () => {
    expect(planItem(AD, EVENT, '2027-02-22')).toMatchObject({ status: 'closing', daysLeft: 1 });
    const late = planItem(AD, EVENT, '2027-02-24');
    expect(late).toMatchObject({ status: 'late', daysLeft: -1 });
    // 예약은 놓쳤지만 소재 마감은 아직 남았다. 마감마다 상태가 따로 있다.
    expect(late.deadlines.map((d) => [d.kind, d.daysLeft, d.status])).toEqual([
      ['booking', -1, 'late'],
      ['material', 6, 'open'],
    ]);
  });

  it('남은 날 3일까지는 곧 마감, 4일부터는 아직 됨', () => {
    expect(planItem(AD, EVENT, '2027-02-20')).toMatchObject({ status: 'closing', daysLeft: 3 });
    expect(planItem(AD, EVENT, '2027-02-19')).toMatchObject({ status: 'open', daysLeft: 4 });
  });

  it('달이 바뀌는 날: 3월 1일의 하루 전은 평년에 2월 28일, 윤년에 2월 29일', () => {
    const oneDay = product({ spec: { booking_deadline_days: 1 } });
    expect(planItem(oneDay, '2027-03-01', '2027-02-01').deadlines[0]).toMatchObject({ date: '2027-02-28', daysLeft: 27 });
    expect(planItem(oneDay, '2028-03-01', '2028-02-01').deadlines[0]).toMatchObject({ date: '2028-02-29', daysLeft: 28 });
    // 30일 달과 31일 달
    expect(planItem(product({ spec: { booking_deadline_days: 7 } }), '2027-05-03', '2027-04-01').deadlines[0]).toMatchObject({ date: '2027-04-26' });
    expect(planItem(product({ spec: { booking_deadline_days: 7 } }), '2027-06-03', '2027-04-01').deadlines[0]).toMatchObject({ date: '2027-05-27' });
  });

  it('해가 바뀌는 날: 1월 5일 기념일의 14일 전은 지난해 12월 22일이다', () => {
    const item = planItem(AD, '2027-01-05', '2026-12-20');
    expect(item.deadlines.map((d) => [d.kind, d.date, d.daysLeft])).toEqual([
      ['booking', '2026-12-22', 2],
      ['material', '2026-12-29', 9],
    ]);
    // 오늘이 해를 넘긴 뒤면 지난해의 마감은 지났다.
    expect(planItem(AD, '2027-01-05', '2027-01-01')).toMatchObject({ status: 'late', daysLeft: -10 });
  });

  it('윤년의 2월 29일을 건너 센다', () => {
    // 2028-03-09 의 14일 전: 2월이 29일까지라 2월 24일. 평년이면 2월 23일.
    expect(planItem(AD, '2028-03-09', '2028-02-01').deadlines[0]).toMatchObject({ date: '2028-02-24', daysLeft: 23 });
    expect(planItem(AD, '2027-03-09', '2027-02-01').deadlines[0]).toMatchObject({ date: '2027-02-23', daysLeft: 22 });
  });

  it('2월 29일 기념일: 평년에는 2월 28일을 기준일로 센다', () => {
    const eventDate = nextOccurrence(2, 29, '2026-10-12');
    expect(eventDate).toBe('2027-02-28');
    expect(planItem(AD, eventDate, '2026-10-12').deadlines.map((d) => d.date)).toEqual(['2027-02-14', '2027-02-21']);
    // 윤년에는 2월 29일이 기준일이다.
    expect(planItem(AD, nextOccurrence(2, 29, '2027-10-12'), '2027-10-12').deadlines.map((d) => d.date)).toEqual(['2028-02-15', '2028-02-22']);
  });

  it('오늘이 기념일보다 뒤면 모든 마감이 이미 늦음이다', () => {
    const item = planItem(AD, EVENT, '2027-03-10');
    expect(item).toMatchObject({ status: 'late', daysLeft: -15 });
    expect(item.deadlines.every((d) => d.status === 'late')).toBe(true);
  });

  it('기념일이 오늘이면 일수 0 인 마감만 아직 된다', () => {
    const sameDay = product({ type: 'catering', subtype: '커피차', spec: { design_deadline_days: 0 } });
    expect(planItem(sameDay, EVENT, EVENT)).toMatchObject({ status: 'closing', daysLeft: 0 });
    expect(planItem(AD, EVENT, EVENT)).toMatchObject({ status: 'late', daysLeft: -14 });
  });

  it('마감 일수가 없는 상품은 세지 않고 "마감 일수 없음"으로 낸다', () => {
    const bare = product({ spec: { region: '강남역' } });
    expect(planItem(bare, EVENT, '2026-10-12')).toMatchObject({ deadlines: [], missing: ['booking', 'material'], status: 'unknown', daysLeft: null });
    expect(CALENDAR_STATUS_LABELS.unknown).toBe('마감 일수 없음');
  });

  it('마감 둘 가운데 하나만 적혀 있으면 적힌 것만 세고 빠진 것을 알린다', () => {
    const half = product({ spec: { material_deadline_days: 5 } });
    const item = planItem(half, EVENT, '2027-03-03');
    expect(item).toMatchObject({ missing: ['booking'], status: 'closing', daysLeft: 1 });
    expect(item.deadlines).toHaveLength(1);
  });

  it('일수가 글자·소수·음수면 세지 않는다(지어내지 않는다)', () => {
    const odd = product({ spec: { booking_deadline_days: '14', material_deadline_days: 2.5 } });
    expect(planItem(odd, EVENT, '2026-10-12')).toMatchObject({ deadlines: [], missing: ['booking', 'material'], status: 'unknown' });
    expect(planItem(product({ spec: { booking_deadline_days: -3 } }), EVENT, '2026-10-12')).toMatchObject({ status: 'unknown' });
  });

  it('일수가 터무니없이 커서 마감일이 다룰 수 있는 날짜 앞으로 나가면 세지 못한 것으로 둔다(오류로 죽지 않는다)', () => {
    const absurd = product({ spec: { booking_deadline_days: 100_000, material_deadline_days: 7 } });
    const item = planItem(absurd, EVENT, '2026-10-12');
    expect(item.missing).toEqual(['booking']);
    expect(item.deadlines.map((d) => d.kind)).toEqual(['material']);
    // 1900-01-01 에 딱 닿는 일수까지는 센다.
    const edge = planItem(product({ spec: { booking_deadline_days: 366 } }), '1901-01-02', '1900-06-01');
    expect(edge.deadlines[0]).toMatchObject({ date: '1900-01-01', status: 'late' });
    expect(planItem(product({ spec: { booking_deadline_days: 367 } }), '1901-01-02', '1900-06-01').missing).toEqual(['booking', 'material']);
  });

  it('케이터링은 시안 마감, 굿즈는 제작 기간만큼 앞선 주문 마감을 센다', () => {
    const coffee = product({ type: 'catering', subtype: '커피차', name: '가상 커피차', spec: { design_deadline_days: 5 } });
    expect(planItem(coffee, EVENT, '2026-10-12').deadlines).toEqual([
      { kind: 'design', field: 'design_deadline_days', days: 5, date: '2027-03-04', daysLeft: 143, status: 'open' },
    ]);
    const slogan = product({ type: 'goods', subtype: '인쇄물', name: '가상 슬로건', spec: { lead_time_days: 10 } });
    expect(planItem(slogan, EVENT, '2027-02-27').deadlines).toEqual([
      { kind: 'order', field: 'lead_time_days', days: 10, date: '2027-02-27', daysLeft: 0, status: 'closing' },
    ]);
    expect(planItem(product({ type: 'goods', subtype: '잡화', spec: {} }), EVENT, '2026-10-12')).toMatchObject({ missing: ['order'], status: 'unknown' });
  });

  it('마감 일수가 아닌 칸(기간 옵션의 길이 등)은 마감에 끼어들지 않는다: 게재 시작일을 기념일로 본다', () => {
    const withExtras = product({ spec: { ...AD.spec, refund_full_days: 30, spot_seconds: 15 } });
    expect(planItem(withExtras, EVENT, '2026-10-12').deadlines).toEqual(planItem(AD, EVENT, '2026-10-12').deadlines);
  });
});

describe('게재 기간', () => {
  it('기념일에 시작하는 7일 옵션은 기념일부터 6일 뒤까지 걸린다', () => {
    expect(lastDayOfRun('2027-03-09', 7)).toBe('2027-03-15');
    expect(lastDayOfRun('2027-03-09', 1)).toBe('2027-03-09');
    expect(lastDayOfRun('2026-12-28', 7)).toBe('2027-01-03');
    expect(lastDayOfRun('2028-02-25', 7)).toBe('2028-03-02');
    expect(() => lastDayOfRun('2027-03-09', 0)).toThrow();
  });
});

describe('공간의 상품 전체', () => {
  const today = '2027-02-21';
  const products: CalendarProduct[] = [
    product({ id: 1, name: '아직 됨(멀다)', spec: { booking_deadline_days: 5, material_deadline_days: 3 } }), // 3월 4일, 11일 남음
    product({ id: 2, name: '곧 마감', spec: { booking_deadline_days: 14, material_deadline_days: 7 } }), // 2월 23일, 2일 남음
    product({ id: 3, name: '이미 늦음(오래)', spec: { booking_deadline_days: 30 } }), // 2월 7일, 14일 지남
    product({ id: 4, name: '일수 없음', spec: {} }),
    product({ id: 5, name: '이미 늦음(방금)', spec: { booking_deadline_days: 17 } }), // 2월 20일, 1일 지남
    product({ id: 6, name: '아직 됨(가깝다)', type: 'goods', subtype: '인쇄물', spec: { lead_time_days: 10 } }), // 2월 27일, 6일 남음
    product({ id: 7, name: '오늘까지', type: 'catering', subtype: '도시락', spec: { design_deadline_days: 16 } }), // 2월 21일, 0일
  ];

  it('급한 것부터 놓는다(이미 늦음, 곧 마감, 아직 됨, 일수 없음). 같으면 남은 날이 적은 것부터', () => {
    const { items, counts } = planCalendar(products, EVENT, today);
    expect(items.map((i) => [i.productId, i.status, i.daysLeft])).toEqual([
      [3, 'late', -14],
      [5, 'late', -1],
      [7, 'closing', 0],
      [2, 'closing', 2],
      [6, 'open', 6],
      [1, 'open', 11],
      [4, 'unknown', null],
    ]);
    expect(counts).toEqual({ late: 2, closing: 2, open: 2, unknown: 1 });
  });

  it('화면의 순서는 되는 것 먼저다: 마감이 가까운 것부터, 다음이 방금 놓친 것, 끝이 일수 없음', () => {
    const { items } = planCalendar(products, EVENT, today);
    expect(doableFirst(items).map((i) => i.productId)).toEqual([7, 2, 6, 1, 5, 3, 4]);
    // 넘긴 목록은 건드리지 않는다.
    expect(items[0]?.productId).toBe(3);
  });

  it('남은 날까지 같으면 상품 번호 순이다(넣은 순서와 상관없이 같은 결과)', () => {
    const twins = [product({ id: 9, spec: { booking_deadline_days: 14 } }), product({ id: 8, spec: { booking_deadline_days: 14 } })];
    expect(planCalendar(twins, EVENT, today).items.map((i) => i.productId)).toEqual([8, 9]);
    expect(planCalendar([...twins].reverse(), EVENT, today).items.map((i) => i.productId)).toEqual([8, 9]);
    expect(doableFirst(planCalendar(twins, EVENT, today).items).map((i) => i.productId)).toEqual([8, 9]);
  });

  it('상품이 없으면 빈 목록과 0 넷이다', () => {
    expect(planCalendar([], EVENT, today)).toEqual({ items: [], counts: { open: 0, closing: 0, late: 0, unknown: 0 } });
  });

  it('문으로 내보낸 것이 약속의 함수 셋이다', () => {
    expect(Object.keys(calendar).sort()).toEqual(['nextOccurrence', 'planCalendar', 'planItem']);
  });
});
