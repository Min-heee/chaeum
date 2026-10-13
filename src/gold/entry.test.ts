// 사람이 적은 글을 표준 값으로 읽는 일. 값을 새로 정하지 않는지(단위 바꾸는 셈은 사람 몫), 되읽으면 같은 값인지 본다.
import { describe, expect, it } from 'vitest';
import { GOLD_TRAPS } from '@/contract/eval-types';
import { FIELD_DEFS, type FieldKey, type FieldValue } from '@/contract/fields';
import { ENTRY_GUIDES, HAND_TRAP_TIPS, guideFor, parseAmount, parseEntry, showEntry, toEntryText, trapsFromTips } from './entry';

const value = (key: FieldKey, text: string) => {
  const r = parseEntry(key, text);
  if (!r.ok) throw new Error(`${key} "${text}": ${r.why}`);
  return r.value;
};
const fails = (key: FieldKey, text: string) => !parseEntry(key, text).ok;

describe('값 적기', () => {
  it('비우거나 "없음"이면 없음이다', () => {
    for (const t of ['', '  ', '없음', 'null', '-']) expect(value('price_krw', t)).toBeNull();
    expect(value('file_format', ' , ')).toBeNull();
  });

  it('금액: 쉼표, 원, 만·억·천', () => {
    expect(parseAmount('1,500,000원')).toBe(1_500_000);
    expect(parseAmount('150만')).toBe(1_500_000);
    expect(parseAmount('1.5억')).toBe(150_000_000);
    expect(parseAmount('3천원')).toBe(3000);
    expect(parseAmount('1.5')).toBeNull();
    expect(parseAmount('1,50')).toBeNull();
    expect(parseAmount('백만원')).toBeNull();
    expect(value('price_krw', '1500000')).toBe(1_500_000);
    expect(fails('price_krw', '150만원쯤')).toBe(true);
  });

  it('참·거짓, 수, 일수', () => {
    expect(value('vat_included', '포함')).toBe(true);
    expect(value('vat_included', '별도')).toBe(false);
    expect(fails('vat_included', '모름')).toBe(true);
    expect(value('spot_seconds', '15초')).toBe(15);
    expect(value('footfall_per_day', '100,000')).toBe(100_000);
    expect(value('lead_time_days', '7일')).toBe(7);
    expect(fails('plays_per_day', '백 번')).toBe(true);
    expect(fails('lead_time_days', '1주')).toBe(true);
  });

  it('크기: 그 칸의 단위만 읽는다. 다른 단위는 바꿔 주지 않고 되묻는다', () => {
    expect(value('size_m', '8 x 4.5')).toEqual({ width: 8, height: 4.5 });
    expect(value('size_m', '가로 8m × 세로 4.5m')).toEqual({ width: 8, height: 4.5 });
    expect(fails('size_m', '8000mm x 4500mm')).toBe(true);
    expect(fails('size_m', '800cm x 450cm')).toBe(true);
    expect(value('size_mm', '55mm*85mm')).toEqual({ width: 55, height: 85 });
    expect(fails('size_mm', '5.5 x 8.5')).toBe(true);
    expect(value('resolution_px', '1920px x 1080px')).toEqual({ width: 1920, height: 1080 });
    expect(fails('size_m', '8')).toBe(true);
  });

  it('운영 시간: 다음 날, 25시, 24시간', () => {
    expect(value('hours', '05:00~다음 날 01:00')).toEqual({ open: '05:00', close: '01:00', nextDay: true });
    expect(value('hours', '05:00~25:00')).toEqual({ open: '05:00', close: '01:00', nextDay: true });
    expect(value('hours', '05:00 ~ 01:00')).toEqual({ open: '05:00', close: '01:00', nextDay: true });
    expect(value('hours', '09:00~18:00')).toEqual({ open: '09:00', close: '18:00', nextDay: false });
    expect(value('service_hours', '24시간')).toEqual({ open: '00:00', close: '00:00', nextDay: true });
    expect(fails('hours', '5시~1시')).toBe(true);
    expect(fails('hours', '05:00~01:70')).toBe(true);
  });

  it('옵션 목록: 키가 작은 것부터, 같은 키 두 번은 받지 않는다', () => {
    expect(value('period_options', '14 2,800,000 / 7 150만')).toEqual([
      { days: 7, price_krw: 1_500_000 },
      { days: 14, price_krw: 2_800_000 },
    ]);
    expect(value('quantity_options', '100잔=80만원\n200잔: 150만원')).toEqual([
      { qty: 100, price_krw: 800_000 },
      { qty: 200, price_krw: 1_500_000 },
    ]);
    expect(fails('period_options', '7 150만 / 7 140만')).toBe(true);
    expect(fails('period_options', '1주 150만')).toBe(true);
  });

  it('파일 형식: 소문자, jpeg → jpg, 차례 맞춤', () => {
    expect(value('file_format', 'MP4, .JPEG, jpg')).toEqual(['jpg', 'mp4']);
  });

  it('옛 꼴(JSON)도 읽고, 약속의 꼴이 아니면 받지 않는다', () => {
    expect(value('size_m', '{"width":8,"height":4.5}')).toEqual({ width: 8, height: 4.5 });
    expect(fails('size_m', '{"width":"8"}')).toBe(true);
    expect(fails('hours', '{oops')).toBe(true);
  });

  it('입력 칸에 다시 놓은 글을 되읽으면 같은 값이다(칸 전부)', () => {
    const samples: Partial<Record<FieldKey, FieldValue>> = {
      name: '가나다 전광판',
      price_krw: 1_500_000,
      list_price_krw: 2_000_000,
      vat_included: false,
      region: '강남역',
      size_m: { width: 8, height: 4.5 },
      resolution_px: { width: 1920, height: 1080 },
      hours: { open: '05:00', close: '01:00', nextDay: true },
      spot_seconds: 15,
      plays_per_day: 100,
      footfall_per_day: 100_000,
      period_options: [{ days: 7, price_krw: 1_500_000 }, { days: 30, price_krw: 5_000_000 }],
      material_deadline_days: 7,
      file_format: ['jpg', 'mp4'],
      refund_full_days: 14,
      booking_deadline_days: 10,
      service_region: '서울 전 지역',
      quantity_options: [{ qty: 100, price_krw: 800_000 }],
      service_hours: { open: '00:00', close: '00:00', nextDay: true },
      design_deadline_days: 5,
      size_mm: { width: 55, height: 85 },
      material: '아크릴 3T',
      lead_time_days: 10,
      min_order_qty: 50,
    };
    for (const def of FIELD_DEFS) {
      const v = samples[def.key];
      expect(v, def.key).toBeDefined();
      expect(value(def.key, toEntryText(def.key, v)), def.key).toEqual(v);
      expect(showEntry(def.key, v)).not.toBe('없음');
      expect(ENTRY_GUIDES[def.kind].example).not.toBe('');
      // 안내의 보기는 그 칸이 읽는 꼴이어야 한다.
      expect(parseEntry(def.key, ENTRY_GUIDES[def.kind].example).ok, `${def.key} 보기`).toBe(true);
      const shown = parseEntry(def.key, guideFor(def.key).example);
      expect(shown.ok && shown.value !== null, `${def.key} 칸의 보기`).toBe(true);
    }
    expect(guideFor('material').example).not.toBe(guideFor('name').example);
    expect(toEntryText('price_krw', null)).toBe('');
    expect(showEntry('price_krw', null)).toBe('없음');
    expect(value('hours', toEntryText('hours', { open: '09:00', close: '18:00', nextDay: false }))).toEqual({ open: '09:00', close: '18:00', nextDay: false });
  });

  it('함정 귀띔: 고른 것만 꼬리표가 되고 겹치지 않는다', () => {
    expect(trapsFromTips(['monthly_footfall', 'late_hours', 'missing', '모르는 것'], GOLD_TRAPS)).toEqual(['missing_field', 'unit']);
    expect(trapsFromTips([], GOLD_TRAPS)).toEqual([]);
    for (const tip of HAND_TRAP_TIPS) expect(GOLD_TRAPS).toContain(tip.trap);
    expect(new Set(HAND_TRAP_TIPS.map((t) => t.id)).size).toBe(HAND_TRAP_TIPS.length);
  });
});
