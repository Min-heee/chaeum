// 표기 틀: 꼴마다 검산이 되읽는가, 한 꼴이 몰리지 않는가, 표기를 바꿔도 정답이 그대로인가. DB 없이 돈다.
import { describe, expect, it } from 'vitest';
import { GoldDocSchema } from '@/contract/eval-types';
import type { FieldKey, FieldValue } from '@/contract/fields';
import { FORM_SHARE_CAP, balance, formTable, shareCap } from './assign';
import { splitBatches, writerGuide, batchOutputPath } from './batches';
import { AD_KINDS, CONFUSION_GOODS, FILE_FORMAT_SETS, GOODS_ITEMS, PERIOD_SETS, QUANTITY_SETS, RESOLUTIONS, STATIC_FORMAT_SETS } from './catalog';
import { canon, sha256 } from './files';
import { GROUPS, MONEY_FORMS, MONEY_MIN, TEXT_FIELDS, type Ctx, type DocInfo, type Form, type MoneyForm } from './forms';
import { generateSpecs } from './generate';
import { readDays, readFootfall, readFormats, readHours, readMoney, readOptions, readPair, readVat, recalc } from './recalc';
import { summarizeForms } from './report';
import { makeRng } from './rng';
import { DEFAULT_SEED, type GoldSpec } from './spec';

const specs = generateSpecs();
const DOC: DocInfo = { id: 'dev-001', split: 'dev', style: 'mixed_lang', type: 'ad', unitDoc: true };
const hm = (h: number) => `${String(h).padStart(2, '0')}:00`;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** 꼴 하나로 값을 적고, 검산으로 되읽어 값과 같은지 본다. */
function roundTrip(field: FieldKey, form: Form, value: unknown, more: Partial<Ctx> = {}, seed = 1): string | null {
  const ctx: Ctx = { doc: DOC, field, value, sem: {}, langOk: true, r: makeRng(seed), ...more };
  if (form.ok && !form.ok(ctx)) return null;
  const out = form.make(ctx);
  const tokens = out.tokens ?? [out.show];
  for (const t of tokens) expect(out.show, `${field} ${form.id}: 조각이 본보기 안에 있어야 한다`).toContain(t);
  const back = recalc({ field, label: '', show: out.show, tokens, form: form.id, ...(out.unit ? { unit: out.unit } : {}) });
  expect(canon(back), `${field} ${form.id} "${out.show}"`).toEqual(canon(value));
  return out.show;
}

/** 칸마다 꼴 전부를 여러 값으로 돌려 본다. 한 번도 못 돌린 꼴이 있으면 실패다. */
function cover(field: FieldKey, samples: (cls: string) => { value: unknown; more?: Partial<Ctx> }[]) {
  const forms = (GROUPS[field] as { forms: readonly Form[] }).forms;
  for (const form of forms) {
    let ran = 0;
    samples(form.cls).forEach((s, i) => {
      for (const seed of [1, 2, 3]) if (roundTrip(field, form, s.value, s.more, seed * 100 + i) !== null) ran += 1;
    });
    expect(ran, `${field} ${form.id}: 돌려 본 값이 없다`).toBeGreaterThan(0);
  }
}

describe('꼴마다 검산이 정답으로 되읽는다', () => {
  it('금액 꼴 전부', () => {
    const sets: [number[], 'ad' | 'catering' | 'goods'][] = [
      [[1_500_000, 2_850_000, 12_000_000], 'ad'],
      [[173_500_000, 10_400_000], 'ad'],
      [[450_000, 850_000], 'catering'],
      [[8_000, 12_000], 'goods'],
      [[12_000, 25_000], 'goods'],
      [[20_000], 'goods'],
      [[6_500], 'goods'],
      [[1_500, 3_000], 'goods'],
    ];
    for (const f of MONEY_FORMS) {
      let ran = 0;
      for (const [vals, type] of sets) {
        if (f.ok && !f.ok(vals, type)) continue;
        for (const v of vals) {
          expect(readMoney(f.fmt(v), f.unit), `${f.id} "${f.fmt(v)}"`).toBe(v);
          ran += 1;
        }
      }
      expect(ran, `${f.id}: 돌려 본 값이 없다`).toBeGreaterThan(0);
    }
  });

  it('크기(m)·크기(mm)·해상도', () => {
    const adSizes = Object.values(AD_KINDS).flatMap((kinds) => kinds.flatMap((k) => k.sizes));
    cover('size_m', () => adSizes.map(([width, height]) => ({ value: { width, height } })));
    const goodsSizes = [...Object.values(GOODS_ITEMS).flat(), ...Object.values(CONFUSION_GOODS)].flatMap((g) => g.sizes);
    cover('size_mm', () => goodsSizes.map(([width, height]) => ({ value: { width, height } })));
    cover('resolution_px', () => RESOLUTIONS.flatMap(([w, h]) => [{ value: { width: w, height: h } }, { value: { width: h, height: w } }]));
  });

  it('운영 시간: 같은 날, 오전·오후, 다음 날로 넘어감, 24시간', () => {
    const sameDay = range(5, 13).flatMap((o) => range(o + 2, Math.min(23, o + 17)).map((c) => ({ value: { open: hm(o), close: hm(c), nextDay: false } })));
    const over = [5, 6, 7, 8, 21, 22, 23].flatMap((o) => range(0, 3).map((c) => ({ value: { open: hm(o), close: hm(c), nextDay: true } })));
    const samples = (cls: string) => (cls === 'allday' ? [{ value: { open: '00:00', close: '00:00', nextDay: true } }] : cls === 'over' ? over : sameDay);
    cover('hours', samples);
    cover('service_hours', samples);
  });

  it('초수·횟수·최소 수량', () => {
    cover('spot_seconds', () => [10, 15, 20, 30].map((value) => ({ value })));
    cover('plays_per_day', () => [60, 100, 120, 240, 300].map((value) => ({ value })));
    cover('min_order_qty', () => [10, 20, 50, 100].flatMap((value) => ['개', '장', '세트'].map((unitWord) => ({ value, more: { sem: { unitWord } } }))));
  });

  it('하루 유동인구: 하루·월·주·연', () => {
    const div: Record<string, number> = { day: 1, month: 30, week: 7, year: 365 };
    const srcs: Record<string, number[]> = {
      day: [30_000, 125_000, 131_000, 400_000],
      month: [2_500_000, 12_000_000, 3_930_000, 1_000_000],
      week: [700_000, 217_000, 875_000],
      year: [30_000_000, 150_000_000, 45_625_000],
    };
    cover('footfall_per_day', (cls) => (srcs[cls] as number[]).map((src) => ({ value: Math.round(src / (div[cls] as number)), more: { sem: { src } } })));
  });

  it('일수: 마감 넷과 제작 기간(일·주·달·시간·영업일)', () => {
    const days = (cls: string) => (cls === 'week' ? [7, 14, 21, 30] : cls === 'hour' ? [1, 2, 3] : [3, 5, 7, 10, 14, 20]).map((value) => ({ value }));
    for (const field of ['material_deadline_days', 'refund_full_days', 'booking_deadline_days', 'design_deadline_days'] as const) {
      // 어느 칸에서도 못 쓰는 꼴은 없어야 하지만, 칸마다 안 쓰는 꼴은 있다(환불에는 "여유", 환불 아닌 칸에는 "취소").
      for (const form of (GROUPS[field] as { forms: readonly Form[] }).forms) days(form.cls).forEach((s, i) => roundTrip(field, form, s.value, {}, i + 1));
    }
        cover('lead_time_days', days);
  });

  it('마감 꼴은 네 칸 가운데 적어도 한 칸에서 쓰인다', () => {
    const fields = ['material_deadline_days', 'refund_full_days', 'booking_deadline_days', 'design_deadline_days'] as const;
    for (const form of (GROUPS.refund_full_days as { forms: readonly Form[] }).forms) {
      const value = form.cls === 'hour' ? 3 : 7;
      const shown = fields.map((f) => roundTrip(f, form, value)).filter(Boolean);
      expect(shown.length, form.id).toBeGreaterThan(0);
    }
  });

  it('부가세와 파일 형식', () => {
    cover('vat_included', () => [{ value: true }, { value: false }]);
    cover('file_format', () => [...FILE_FORMAT_SETS, ...STATIC_FORMAT_SETS].map((set) => ({ value: [...set].sort() })));
  });

  it('값표: 늘어놓는 꼴 × 금액 꼴 × 기간·수량 낱말', () => {
    const periodSets = [...PERIOD_SETS.plain, ...PERIOD_SETS.table];
    const prices = [1_500_000, 2_800_000, 5_200_000, 10_400_000];
    const moneyOk = (f: MoneyForm, vals: number[], type: 'ad' | 'catering') => !f.ok || f.ok(vals, type);
    for (const form of (GROUPS.period_options as { forms: readonly Form[] }).forms) {
      let ran = 0;
      periodSets.forEach((set, i) => {
        const value = set.map((days, k) => ({ days, price_krw: prices[k] as number }));
        for (const money of MONEY_FORMS.filter((f) => moneyOk(f, value.map((o) => o.price_krw), 'ad'))) {
          for (const seed of range(1, 6)) {
            for (const sem of [{}, { words: set.map((d) => (d === 30 ? '한 달' : d === 7 ? '1주일' : `${d}일`)) }]) {
              if (roundTrip('period_options', form, value, { money, sem }, seed * 10 + i) !== null) ran += 1;
            }
          }
        }
      });
      expect(ran, form.id).toBeGreaterThan(0);
    }
    const qtyPrices = [450_000, 850_000, 1_200_000, 1_500_000];
    for (const form of (GROUPS.quantity_options as { forms: readonly Form[] }).forms) {
      let ran = 0;
      for (const [unitWord, sets] of [['잔', QUANTITY_SETS.커피차], ['개', QUANTITY_SETS.도시락], ['인분', QUANTITY_SETS.도시락]] as const) {
        [...sets.plain, ...sets.table].forEach((set, i) => {
          const value = set.map((qty, k) => ({ qty, price_krw: qtyPrices[k] as number }));
          for (const money of MONEY_FORMS.filter((f) => moneyOk(f, value.map((o) => o.price_krw), 'catering'))) {
            for (const seed of range(1, 6)) if (roundTrip('quantity_options', form, value, { money, sem: { unitWord }, doc: { ...DOC, type: 'catering' } }, seed * 10 + i) !== null) ran += 1;
          }
        });
      }
      expect(ran, form.id).toBeGreaterThan(0);
    }
  });

  it('정답 100건에 실제로 고른 표기도 모두 정답 값으로 되읽힌다(씨앗 셋)', () => {
    for (const seed of [DEFAULT_SEED, 7, 8]) {
      for (const s of seed === DEFAULT_SEED ? specs : generateSpecs(seed)) {
        for (const h of s.surface_hints) expect(canon(recalc(h)), `${seed} ${s.id} ${h.field} ${h.form} "${h.show}"`).toEqual(canon(s.truth[h.field]));
      }
    }
  });
});

describe('검산이 읽는 표기의 본보기', () => {
  it('크기: 단위와 구분 기호, 가로·세로의 차례', () => {
    expect(readPair('4206mm*1262mm')).toEqual({ a: 4206, b: 1262, unit: 'mm' });
    expect(readPair('540x100', 'cm')).toEqual({ a: 540, b: 100, unit: 'cm' });
    expect(readPair('8X0.9', 'm')).toEqual({ a: 8, b: 0.9, unit: 'm' });
    expect(readPair('8,000 x 4,500 mm')).toEqual({ a: 8000, b: 4500, unit: 'mm' });
    expect(readPair('세로 4.5m × 가로 8m')).toEqual({ a: 8, b: 4.5, unit: 'm' });
    expect(readPair('8m(W) × 4.5m(H)')).toEqual({ a: 8, b: 4.5, unit: 'm' });
    expect(readPair('W8000 × H4500 (mm)')).toEqual({ a: 8000, b: 4500, unit: 'mm' });
    expect(readPair('宽8米、高4.5米')).toEqual({ a: 8, b: 4.5, unit: 'm' });
  });

  it('시간: 익일, 다음날 새벽, 자정, 오전·오후, 영어·중국어', () => {
    const next = { open: '05:00', close: '01:00', nextDay: true };
    for (const show of ['05시~25시', '05:00~25:00', '05:00-01:00(익일)', '05:00 ~ 익일 01:00', '오전 5시부터 다음날 새벽 1시까지', '05:00~01:00', '5:00 to 1:00 (next day)', '5点至次日1点']) {
      expect(readHours(show), show).toEqual(next);
    }
    const day = { open: '06:00', close: '22:00', nextDay: false };
    for (const show of ['06:00~22:00', '06시~22시', '6시부터 22시까지', '06시 00분~22시 00분', '06~22시', '06:00–22:00', '오전 6시~밤 10시', 'AM 6:00 ~ PM 10:00', '6am-10pm', '6:00 AM - 10:00 PM', '上午6点到晚上10点']) {
      expect(readHours(show), show).toEqual(day);
    }
    expect(readHours('06시~자정')).toEqual({ open: '06:00', close: '00:00', nextDay: true });
    expect(readHours('6:00 to midnight')).toEqual({ open: '06:00', close: '00:00', nextDay: true });
    expect(readHours('낮 12시~오후 3시')).toEqual({ open: '12:00', close: '15:00', nextDay: false });
    for (const show of ['24시간', '24H', '00:00~24:00', '하루 24시간', '24hrs', '全天24小时']) expect(readHours(show), show).toEqual({ open: '00:00', close: '00:00', nextDay: true });
  });

  it('일수: 주·달·D-·시간·영업일·보름(일치 기준 문서의 환산 규칙)', () => {
    expect(readDays('2주 전까지')).toBe(14);
    expect(readDays('게재 14일 전 마감')).toBe(14);
    expect(readDays('D-14')).toBe(14);
    expect(readDays('최소 2주 여유')).toBe(14);
    expect(readDays('2주일 이전')).toBe(14);
    expect(readDays('소재는 보름 전')).toBe(15);
    expect(readDays('72시간 전까지')).toBe(3);
    expect(() => readDays('36시간 전까지')).toThrow();
    expect(readDays('영업일 기준 10일 전')).toBe(10);
    expect(readDays('1 week before')).toBe(7);
    expect(readDays('1 month before')).toBe(30);
    expect(readDays('提前7天')).toBe(7);
    expect(readDays('提前1个月')).toBe(30);
  });

  it('금액: 기호·영문·중국어·줄인 단위', () => {
    for (const show of ['1,500,000원', '1500000원', '1,500,000 원', '150만원', '150만 원', '₩1,500,000', '￦1,500,000', 'KRW 1,500,000', '1,500,000 KRW', '150万韩元', '1,500,000 won', '1,500천원', '150만', '1.5백만원', 'KRW 1.5 million']) {
      expect(readMoney(show), show).toBe(1_500_000);
    }
    expect(readMoney('150', '만원')).toBe(1_500_000);
    expect(readMoney('1,500', '천원')).toBe(1_500_000);
    expect(readMoney('1만 2천원')).toBe(12_000);
    expect(readMoney('1억 7,350만원')).toBe(173_500_000);
  });

  it('유동인구: 하루·월·주·연과 영어·중국어', () => {
    expect(readFootfall('1일 120,000명')).toBe(120_000);
    expect(readFootfall('일평균 12.5만명')).toBe(125_000);
    expect(readFootfall('12만 명/일')).toBe(120_000);
    expect(readFootfall('월평균 250만명')).toBe(83_333);
    expect(readFootfall('2.5 million per month')).toBe(83_333);
    expect(readFootfall('月均250万人次')).toBe(83_333);
    expect(readFootfall('주당 700,000명')).toBe(100_000);
    expect(readFootfall('3,000만 명/년')).toBe(82_192);
    expect(readFootfall('日均12万人次')).toBe(120_000);
  });

  it('값표: 금액이 앞에 와도, 기간 줄과 금액 줄이 따로여도, 탭으로 나뉘어도 같은 짝을 읽는다', () => {
    const want = [{ days: 7, price_krw: 1_500_000 }, { days: 14, price_krw: 2_800_000 }];
    for (const show of [
      '1주 150만원 / 2주 280만원',
      '150만원(1주) / 280만원(2주)',
      '150만원/1주, 280만원/2주',
      '기간 | 7일 | 14일\n금액 | ₩1,500,000 | ₩2,800,000',
      '1주일\t150만 원\n2주일\t280만 원',
      '1 week: KRW 1,500,000; 2 weeks: KRW 2,800,000',
      '1周 → 150万韩元, 2周 → 280万韩元',
      '[1주] 1.5백만원 [2주] 2.8백만원',
    ]) {
      expect(readOptions(show, undefined, 'days'), show).toEqual(want);
    }
    expect(readOptions('- 7일 150\n- 14일 280', '만원', 'days')).toEqual(want);
    expect(readOptions('100 cups=450,000 KRW, 200 cups=850,000 KRW', undefined, 'qty')).toEqual([{ qty: 100, price_krw: 450_000 }, { qty: 200, price_krw: 850_000 }]);
    expect(() => readOptions('1주 150만원 / 2주', undefined, 'days')).toThrow();
  });

  it('부가세와 파일 형식', () => {
    for (const show of ['부가세 별도', 'VAT별도', '부가세 미포함', '부가세 10% 별도', 'excl. VAT', 'VAT excluded', '不含税', '부가세 별도가']) expect(readVat(show), show).toBe(false);
    for (const show of ['부가세 포함', 'V.A.T 포함', '부가가치세 포함', 'incl. VAT', 'VAT included', '含税', '부가세 포함가']) expect(readVat(show), show).toBe(true);
    for (const show of ['JPG, MP4', 'jpg/mp4', 'JPG·MP4', '.jpg, .mp4', '*.jpg, *.mp4', 'JPG 또는 MP4', 'jpg 및 mp4', 'JPEG, MP4', 'MP4 / JPG', 'JPG, MP4 파일', 'jpg, mp4 형식', 'JPG or MP4', 'JPG、MP4']) {
      expect(readFormats(show), show).toEqual(['jpg', 'mp4']);
    }
  });
});

describe('꼴의 수와 퍼짐', () => {
  const sums = summarizeForms(specs);
  const big: FieldKey[] = ['price_krw', 'size_m', 'size_mm', 'hours', 'service_hours', 'footfall_per_day', 'period_options', 'quantity_options'];

  it('칸마다 꼴을 8가지 넘게, 금액·크기·운영 시간·유동인구·값표는 12가지 넘게 마련했다', () => {
    expect(MONEY_FORMS.length).toBeGreaterThanOrEqual(MONEY_MIN);
    for (const [field, group] of Object.entries(GROUPS)) {
      expect(group.min, field).toBe(big.includes(field as FieldKey) ? 12 : 8);
      expect(new Set(group.forms.map((f) => f.id)).size, field).toBe(group.forms.length);
      // 한국어 글에서 쓸 수 있는 꼴(영어·중국어 꼴을 뺀 것)만 세어도 넘는다.
      expect(group.forms.filter((f) => !f.lang).length, field).toBeGreaterThanOrEqual(group.min);
    }
    expect(MONEY_FORMS.filter((f) => !f.lang).length).toBeGreaterThanOrEqual(MONEY_MIN);
    for (const s of sums) expect(s.defined, s.field).toBeGreaterThanOrEqual(s.required);
  });

  it('문서가 20건 넘는 칸은 실제로 쓴 꼴도 그 수를 넘는다. 적은 칸은 문서 수의 절반 넘게 서로 다른 꼴을 쓴다', () => {
    for (const s of sums) {
      const docs = s.dev + s.test;
      if (docs >= 20) expect(s.used, s.field).toBeGreaterThanOrEqual(s.required);
      else expect(s.used * 2, s.field).toBeGreaterThanOrEqual(docs);
    }
  });

  it(`한 꼴이 그 칸 문서의 ${FORM_SHARE_CAP * 100}% 를 넘지 않는다(씨앗 셋)`, () => {
    for (const seed of [DEFAULT_SEED, 7, 8]) {
      for (const s of summarizeForms(seed === DEFAULT_SEED ? specs : generateSpecs(seed))) {
        const docs = s.dev + s.test;
        expect(s.top, `${seed} ${s.field}`).toBeLessThanOrEqual(Math.max(1, Math.floor(docs * FORM_SHARE_CAP)));
        expect(s.top / docs, `${seed} ${s.field}`).toBeLessThanOrEqual(docs >= 4 ? FORM_SHARE_CAP : 1);
      }
    }
  });

  it('연습과 안 여는 세트를 따로 봐도, 문서가 10건 넘는 쪽에서는 30% 를 넘지 않는다', () => {
    for (const s of sums) {
      for (const split of ['dev', 'test'] as const) {
        if (s[split] < 10) continue;
        for (const r of s.rows) expect(r[split], `${s.field} ${r.form} ${split}`).toBeLessThanOrEqual(shareCap(s[split]));
      }
    }
  });

  it('안 여는 세트에만 나오는 꼴은 칸마다 쓴 꼴의 절반을 넘지 않는다', () => {
    for (const s of sums) expect(s.testOnly * 2, s.field).toBeLessThanOrEqual(s.used);
  });

  it('문서가 20건 넘는 칸에서는 연습에서 쓴 꼴이 8가지를 넘는다(연습만 봐도 표기가 판에 박히지 않는다)', () => {
    for (const s of sums) if (s.dev >= 16) expect(s.rows.filter((r) => r.dev > 0).length, s.field).toBeGreaterThanOrEqual(8);
  });

  it('가장 덜 쓴 꼴부터 고른다: 고를 수 있는 꼴이 넷이고 문서가 스물이면 다섯씩이다', () => {
    const cands = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
    const slots = range(1, 20).map((i) => ({ doc: { ...DOC, id: `dev-${i}`, split: (i <= 8 ? 'dev' : 'test') as 'dev' | 'test' }, cands }));
    const picked = balance(slots, makeRng(1));
    const count = (id: string) => [...picked.values()].filter((c) => c.id === id).length;
    expect(cands.map((c) => count(c.id))).toEqual([5, 5, 5, 5]);
  });
});

describe('표기를 바꿔도 정답은 그대로다', () => {
  const frozen = (list: GoldSpec[]) => list.map((s) => canon({ id: s.id, split: s.split, type: s.type, subtype: s.subtype, style: s.style, traps: s.traps, truth: s.truth }));

  it('정답(번호·묶음·종류·갈래·꼴·함정·값)의 해시가 표기 틀을 넓히기 전과 같다', () => {
    // 표기 틀을 넓히기 전(2026-10-12)에 떠 둔 100건으로 낸 값이다. 표기를 손봤는데 이 값이 바뀌면 표기 고르기가 값의 난수 흐름을 건드린 것이다.
    expect(sha256(JSON.stringify(frozen(specs)))).toBe('d0b09d0c39836c53d4a7f5ce1e88b5c7a36953bf6273389f1ba8688cad46eced');
  });

  it('씨앗이 같으면 표기까지 글자 하나 다르지 않다', () => {
    expect(JSON.stringify(generateSpecs(DEFAULT_SEED))).toBe(JSON.stringify(specs));
  });

  it('정답은 약속의 스키마를 통과한다', () => {
    for (const s of specs) {
      const doc = { id: s.id, split: s.split, goldVersion: 1, content: '글', truth: { type: s.type, subtype: s.subtype, fields: s.truth }, author: 'ai', traps: s.traps, style: s.style };
      expect(GoldDocSchema.safeParse(doc).success, s.id).toBe(true);
    }
  });

  it('단위를 바꿔 적는 꼴은 단위 함정이 붙은 문서에만 쓴다', () => {
    const converting = /^(size_m:(mm|cm)_|size_mm:(cm_|m_x)|hours:(ko_|AMPM|ampm|en_from|zh_dao|si_over|colon_over|ikil|si_ikil|wrap|jajeong|en_next|zh_ciri|h24|zh_24)|footfall:(month|week|year)\.|(deadline|lead):(week|hour)\.|money:(bare|cheon|man_nowon|baekman|man_dec|man_cheon|en_million))/;
    let seen = 0;
    for (const s of specs) {
      for (const h of s.surface_hints) {
        if (!converting.test(h.form)) continue;
        seen += 1;
        expect(s.traps, `${s.id} ${h.field} ${h.form}`).toContain('unit');
      }
    }
    expect(seen).toBeGreaterThan(60);
  });

  it('영어·중국어 꼴은 섞인 글에만, 표 전용 꼴은 표 꼴 글에만 쓴다', () => {
    for (const s of specs) {
      for (const h of s.surface_hints) {
        const foreign = /[:.](en|zh)_/.test(h.form) || ['en', 'zh'].includes(h.parts?.words ?? '');
        if (foreign) expect(s.style, `${s.id} ${h.form}`).toBe('mixed_lang');
        if (/^(period|qty):(pipe|tab|rows)$/.test(h.form)) expect(s.style, `${s.id} ${h.form}`).toBe('table');
      }
    }
  });

  it('한 문서 안에서 금액 꼴은 하나다(판매가·정가·값표)', () => {
    for (const s of specs) {
      const price = s.surface_hints.find((h) => h.field === 'price_krw');
      if (!price) continue;
      const id = price.form.slice('money:'.length);
      const list = s.surface_hints.find((h) => h.field === 'list_price_krw');
      if (list) expect(list.form, s.id).toBe(price.form);
      const table = s.surface_hints.find((h) => h.field === 'period_options' || h.field === 'quantity_options');
      if (table) {
        expect(table.parts?.money, s.id).toBe(id);
        // 판매가 표기가 값표의 조각 안에 그대로 있다.
        expect(table.tokens.some((t) => t.includes(price.show)), s.id).toBe(true);
      }
    }
  });

  it('수 옆에 단위가 없는 꼴에는 단위와 "밝힐지"가 적혀 있다', () => {
    const bare = specs.flatMap((s) => s.surface_hints).filter((h) => h.unit);
    expect(bare.length).toBeGreaterThan(5);
    for (const h of bare) {
      expect(typeof h.declare_unit, h.form).toBe('boolean');
      expect(h.declare_unit, h.form).toBe(!(h.form.includes('silent') || h.parts?.money?.includes('silent')));
      expect(h.note, h.form).toMatch(/단위/);
    }
  });

  it('조각은 빈 글이 아니고 본보기 안에 있다. 글 칸은 정답 글자 그대로다', () => {
    for (const s of specs) {
      for (const h of s.surface_hints) {
        expect(h.tokens.length, `${s.id} ${h.field}`).toBeGreaterThan(0);
        for (const t of h.tokens) {
          expect(t.trim().length, `${s.id} ${h.field}`).toBeGreaterThan(0);
          expect(h.show, `${s.id} ${h.field}`).toContain(t);
        }
        if (TEXT_FIELDS.includes(h.field)) {
          expect(h.form).toBe('text');
          expect(h.show).toBe(s.truth[h.field] as FieldValue);
        }
      }
    }
  });

  it('위치 칸에는 "정답 글자 그대로 한 번, 자세한 설명은 떨어뜨려서"라는 말이 붙는다', () => {
    const regions = specs.flatMap((s) => s.surface_hints).filter((h) => h.field === 'region');
    expect(regions.length).toBeGreaterThan(50);
    for (const h of regions) {
      expect(h.note).toContain('글자 그대로 한 번');
      expect(h.note).toContain('떨어뜨려');
    }
  });
});

describe('묶음과 안내(둘째 차례)', () => {
  const dir = '/tmp/gold-work/v2';
  const batches = splitBatches(specs, dir);
  const guide = writerGuide(dir);

  it('묶음 파일의 결과 자리, 안내 글의 결과 자리, 조립기가 읽는 자리가 같다', () => {
    batches.forEach((b, i) => {
      expect(b.output_path).toBe(batchOutputPath(dir, i + 1));
      expect(b.output_path).toBe(`${dir}/out/batch-${i + 1}.json`);
      expect(guide).toContain(b.output_path);
    });
  });

  it('안내 글에 이번 차례에 꼭 지킬 것이 들어 있다', () => {
    for (const word of ['뼈대', '문장 틀', '적힌 대로 쓴다', 'absent', '정답 글자와 떨어뜨려', '이 안내와 맡은 묶음 파일, 둘뿐', 'output_path', 'declare_unit', '100자에서 900자', '응원장터', '"id"', '"content"']) {
      expect(guide, word).toContain(word);
    }
  });

  it('묶음마다 여러 꼴이 섞여 있다(한 사람이 한 가지 표기만 받지 않는다)', () => {
    for (const b of batches) {
      for (const field of ['size_m', 'hours', 'period_options', 'footfall_per_day'] as const) {
        const forms = new Set(b.docs.flatMap((d) => d.surface_hints.filter((h) => h.field === field).map((h) => h.form)));
        expect(forms.size, `${b.batch} ${field}`).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('분포표의 건수를 다 더하면 표기가 붙은 칸의 수와 같다', () => {
    const rows = formTable(specs);
    const total = rows.reduce((a, r) => a + r.dev + r.test, 0);
    expect(total).toBe(specs.flatMap((s) => s.surface_hints).filter((h) => h.form !== 'text').length);
  });
});
