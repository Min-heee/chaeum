// 확인 화면을 돕는 순수 함수들: 조각 위치 찾기, 환산 한 줄, 확인할 문서 고르기, 남은 시간, 표기 지시 읽기. DB 없이 돈다.
// 진짜 정답 세트의 씨앗은 쓰지 않는다. 다른 씨앗으로 만든 가짜 설계도로 본다.
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fieldDef, type FieldKey, type FieldValue } from '@/contract/fields';
import { cleanIndexes } from './check';
import { FIELD_RULES, comma, explainField } from './explain';
import { generateSpecs } from './generate';
import { hintsFor, hintsPath, parseHintFile, readHintFile } from './hints';
import { LABEL_BATCH, targetCount } from './label';
import { cutPieces, findSpans, findToken } from './marks';
import { MIN_LOOK_SECONDS, MIN_LOOK_SECONDS_NOT_PRODUCT, dropOne, etaMinutes, median, putBack, tooFast } from './pace';
import type { GoldSpec, SurfaceHint } from './spec';
import { pickTarget, type TargetItem } from './target';

const specs: GoldSpec[] = [5, 9, 31].flatMap((seed) => generateSpecs(seed));
const allHints = specs.flatMap((s) => s.surface_hints.map((h) => ({ spec: s, h })));
const line = (s: GoldSpec, h: SurfaceHint) =>
  explainField(h.field, s.truth[h.field] as FieldValue, { tokens: h.tokens, ...(h.unit ? { unit: h.unit } : {}), ...(h.declare_unit !== undefined ? { declareUnit: h.declare_unit } : {}) });
const ofForm = (prefix: string) => allHints.filter(({ h }) => h.form.startsWith(prefix));
/** 시험용 환경 변수 */
const env = (vars: Record<string, string> = {}) => vars as unknown as NodeJS.ProcessEnv;

describe('조각 위치 찾기', () => {
  it('조각이 여러 번 나오면 전부 찾는다', () => {
    expect(findToken('1주 150만원, 다시 1주 150만원', '1주 150만원')).toEqual([0, 13]);
  });

  it('더 큰 수의 한 토막인 자리는 세지 않는다', () => {
    expect(findToken('게재 17일 이전까지, 늦어도 7일 이전', '7일 이전')).toEqual([17]);
    expect(findToken('1,500,000원', '500,000원')).toEqual([]);
    expect(findToken('2.5m 와 12.5m', '2.5m')).toEqual([0]);
    expect(findToken('아무 글', '')).toEqual([]);
  });

  it('검산이 쓰는 셈(cleanIndexes)과 같은 자리를 낸다', () => {
    for (const spec of specs.slice(0, 60)) {
      const tokens = spec.surface_hints.flatMap((h) => h.tokens);
      const text = `${tokens.join(' / ')} 1${tokens.join('0, ')}.5 ${tokens.join('')}`;
      for (const t of tokens) expect(findToken(text, t)).toEqual(cleanIndexes(text, t));
    }
  });

  it('칸마다 자리를 모으고, 못 찾은 조각은 따로 알린다', () => {
    const text = '위치: 강남역\n값: 1주 150만원 / 2주 280만원\n문의는 강남역 사무실';
    const found = findSpans(text, [
      { field: 'region', tokens: ['강남역'] },
      { field: 'period_options', tokens: ['1주 150만원', '2주 280만원'] },
      { field: 'hours', tokens: ['05시~25시'] },
    ]);
    expect(found.spans.filter((s) => s.field === 'region').map((s) => text.slice(s.start, s.end))).toEqual(['강남역', '강남역']);
    expect(found.spans.filter((s) => s.field === 'period_options')).toHaveLength(2);
    expect(found.missing).toEqual({ hours: ['05시~25시'] });
  });

  it('토막을 이어 붙이면 원문과 같고, 겹친 자리는 두 칸을 함께 싣는다', () => {
    const text = '기간별: 1주(150만원), 2주(280만원) 입니다';
    const { spans } = findSpans(text, [
      { field: 'price_krw', tokens: ['150만원'] },
      { field: 'period_options', tokens: ['1주(150만원)', '2주(280만원)'] },
    ]);
    const pieces = cutPieces(text, spans);
    expect(pieces.map((p) => p.text).join('')).toBe(text);
    expect(pieces.find((p) => p.text === '150만원')).toMatchObject({ fields: expect.arrayContaining(['price_krw', 'period_options']), ends: ['price_krw'] });
    expect(pieces.find((p) => p.text === '1주(')).toMatchObject({ fields: ['period_options'], ends: [] });
    expect(pieces.find((p) => p.text === ')')).toMatchObject({ fields: ['period_options'], ends: ['period_options'] });
    expect(pieces.filter((p) => p.fields.length === 0).map((p) => p.text)).toEqual(['기간별: ', ', ', ' 입니다']);
  });

  it('조각이 없으면 원문 한 토막이다', () => {
    expect(cutPieces('그냥 글', [])).toEqual([{ start: 0, text: '그냥 글', fields: [], ends: [] }]);
    expect(cutPieces('', [])).toEqual([]);
  });

  it('가짜 설계도의 조각은 조각을 넣은 글에서 모두 찾는다', () => {
    for (const spec of specs) {
      const text = `${spec.surface_hints.flatMap((h) => h.tokens).join('\n')}\n`;
      const found = findSpans(text, spec.surface_hints);
      expect(found.missing).toEqual({});
      expect(cutPieces(text, found.spans).map((p) => p.text).join('')).toBe(text);
    }
  });
});

describe('환산 한 줄', () => {
  it('월 유동인구: 정답 × 30 이 표기에 있으면 나눗셈을 적는다', () => {
    expect(explainField('footfall_per_day', 100_000, { tokens: ['월 300만'] })).toBe('300만 = 3,000,000명, 월 3,000,000 ÷ 30 = 100,000명');
    expect(explainField('footfall_per_day', 100_000, { tokens: ['월 3,000,000명'] })).toBe('월 3,000,000 ÷ 30 = 100,000명');
    expect(explainField('footfall_per_day', 83_333, { tokens: ['월 250만 명'] })).toBe('250만 = 2,500,000명, 월 2,500,000 ÷ 30 = 83,333.3… → 반올림 83,333명');
    expect(explainField('footfall_per_day', 314_286, { tokens: ['주 평균 220만 명'] })).toContain('÷ 7 = 314,285.7… → 반올림 314,286명');
    expect(explainField('footfall_per_day', 282_192, { tokens: ['연간 103,000,000명'] })).toContain('÷ 365');
  });

  it('하루 숫자를 그대로 적은 표기에는 적지 않는다. 만 단위만 풀어 준다', () => {
    expect(explainField('footfall_per_day', 66_000, { tokens: ['1일 66,000명'] })).toBeNull();
    expect(explainField('footfall_per_day', 131_000, { tokens: ['일일 13.1만 명'] })).toBe('13.1만 = 13.1 × 10,000 = 131,000명');
  });

  it('운영 시간: 24시 넘는 수, 익일, 자정, 오후', () => {
    expect(explainField('hours', { open: '05:00', close: '01:00', nextDay: true }, { tokens: ['05시~25시'] })).toBe('25시 = 다음 날 01:00');
    expect(explainField('hours', { open: '05:00', close: '01:00', nextDay: true }, { tokens: ['05:00~25:00'] })).toBe('25:00 = 다음 날 01:00');
    expect(explainField('hours', { open: '07:00', close: '00:00', nextDay: true }, { tokens: ['07시~24시'] })).toBe('24시 = 다음 날 00:00');
    expect(explainField('hours', { open: '06:00', close: '01:00', nextDay: true }, { tokens: ['06:00-01:00(익일)'] })).toBe('"익일" = 끝 시각 01:00 이 다음 날');
    expect(explainField('hours', { open: '06:00', close: '00:00', nextDay: true }, { tokens: ['06시~자정'] })).toBe('자정 = 다음 날 00:00');
    expect(explainField('hours', { open: '05:00', close: '00:00', nextDay: true }, { tokens: ['05:00~00:00'] })).toContain('끝을 다음 날로 봄');
    expect(explainField('hours', { open: '00:00', close: '00:00', nextDay: true }, { tokens: ['하루 24시간'] })).toContain('00:00 ~ 다음 날 00:00');
    expect(explainField('hours', { open: '10:00', close: '14:00', nextDay: false }, { tokens: ['오전 10시~오후 2시'] })).toBe('오후 2시 = 14:00');
    expect(explainField('hours', { open: '06:00', close: '23:00', nextDay: false }, { tokens: ['AM 6:00 ~ PM 11:00'] })).toBe('PM 11시 = 23:00');
    expect(explainField('hours', { open: '10:00', close: '14:00', nextDay: false }, { tokens: ['10am-2pm'] })).toBe('2 PM = 14:00');
    expect(explainField('hours', { open: '07:00', close: '22:00', nextDay: false }, { tokens: ['07:00~22:00'] })).toBeNull();
  });

  it('금액: 만·천·백만 단위와 단위 없는 수', () => {
    expect(explainField('price_krw', 600_000, { tokens: ['60만원'] })).toBe('60만 = 60 × 10,000 = 600,000원');
    expect(explainField('price_krw', 10_300_000, { tokens: ['10.3백만원'] })).toBe('10.3백만 = 10.3 × 1,000,000 = 10,300,000원');
    expect(explainField('price_krw', 3_000, { tokens: ['3천원'] })).toBe('3천 = 3 × 1,000 = 3,000원');
    expect(explainField('price_krw', 12_000, { tokens: ['1만 2천원'] })).toBe('1만 2천 = 10,000 + 2,000 = 12,000원');
    expect(explainField('price_krw', 2_500_000, { tokens: ['250'], unit: '만원', declareUnit: true })).toBe('수 옆에 단위가 없음 — 글 다른 곳에 밝힌 단위(만원)로 읽음: 250 × 10,000 = 2,500,000원');
    expect(explainField('price_krw', 500_000, { tokens: ['50'], unit: '만원', declareUnit: false })).toBe('단위를 글에 밝히지 않은 수 — 정답은 만원 단위로 읽음: 50 × 10,000 = 500,000원');
    expect(explainField('price_krw', 1_500_000, { tokens: ['￦1,500,000'] })).toBeNull();
    expect(explainField('list_price_krw', 250_000, { tokens: ['250000원'] })).toBeNull();
  });

  it('값표: 기간 낱말과 금액을 함께 푼다', () => {
    const out = explainField('period_options', [{ days: 7, price_krw: 1_500_000 }], { tokens: ['1주 150'], unit: '만원', declareUnit: true });
    expect(out).toBe('1주 = 7일 · 150 × 10,000 = 1,500,000원 · 수 옆에 단위가 없음 — 글 다른 곳에 밝힌 단위(만원)로 읽음');
    expect(
      explainField(
        'period_options',
        [
          { days: 7, price_krw: 600_000 },
          { days: 30, price_krw: 2_400_000 },
        ],
        { tokens: ['60만원/1주일', '240만원/30일'] },
      ),
    ).toBe('1주일 = 7일 · 60만 = 60 × 10,000 = 600,000원 · 240만 = 240 × 10,000 = 2,400,000원');
    expect(explainField('period_options', [{ days: 14, price_krw: 800_000 }], { tokens: ['14일 KRW 800,000'] })).toBeNull();
    expect(explainField('quantity_options', [{ qty: 100, price_krw: 550_000 }], { tokens: ['100 잔 550'], unit: '천원', declareUnit: true })).toContain('550 × 1,000 = 550,000원');
  });

  it('일수: 주·달·시간·영업일·D-', () => {
    expect(explainField('refund_full_days', 7, { tokens: ['1주 전 취소'] })).toBe('1주 = 7일');
    expect(explainField('design_deadline_days', 21, { tokens: ['행사일 3주일 전'] })).toBe('3주일 = 3 × 7일 = 21일');
    expect(explainField('lead_time_days', 30, { tokens: ['제작 기간 한 달'] })).toBe('한 달 = 30일');
    expect(explainField('design_deadline_days', 30, { tokens: ['1개월 전 마감'] })).toBe('1개월 = 30일');
    expect(explainField('material_deadline_days', 3, { tokens: ['72시간 전까지'] })).toBe('72시간 ÷ 24 = 3일');
    expect(explainField('booking_deadline_days', 10, { tokens: ['영업일 기준 10일 전'] })).toContain('적힌 수 그대로 10일');
    expect(explainField('booking_deadline_days', 7, { tokens: ['D-7'] })).toBe('D-7 = 7일 전');
    expect(explainField('refund_full_days', 7, { tokens: ['7일 이전'] })).toBeNull();
  });

  it('크기: mm·cm 로 적은 표기, 세로가 먼저인 표기, 단위 없는 수', () => {
    expect(explainField('size_m', { width: 8, height: 4.5 }, { tokens: ['8000mm*4500mm'] })).toBe('8000mm = 8m, 4500mm = 4.5m');
    expect(explainField('size_m', { width: 7.5, height: 12 }, { tokens: ['7,500 x 12,000 mm'] })).toBe('7,500mm = 7.5m, 12,000mm = 12m');
    expect(explainField('size_m', { width: 4, height: 2.25 }, { tokens: ['가로 400cm × 세로 225cm'] })).toBe('400cm = 4m, 225cm = 2.25m');
    expect(explainField('size_m', { width: 7.5, height: 12 }, { tokens: ['세로 12m × 가로 7.5m'] })).toBe('표기는 세로가 먼저 — 정답은 가로 7.5, 세로 12');
    expect(explainField('size_m', { width: 12, height: 4 }, { tokens: ['1200x400'], unit: 'cm', declareUnit: true })).toBe('1200cm = 12m, 400cm = 4m · 수 옆에 단위가 없음 — 글 다른 곳에 밝힌 단위(cm)로 읽음');
    expect(explainField('size_mm', { width: 360, height: 400 }, { tokens: ['가로 36cm 세로 40cm'] })).toBe('36cm = 360mm, 40cm = 400mm');
    expect(explainField('size_m', { width: 5, height: 2.8 }, { tokens: ['5m*2.8m'] })).toBeNull();
    expect(explainField('size_mm', { width: 55, height: 85 }, { tokens: ['가로 55mm', '세로 85mm'] })).toBeNull();
  });

  it('파일 형식과 부가세: 같은 것으로 치는 다른 이름', () => {
    expect(explainField('file_format', ['jpg'], { tokens: ['JPEG'] })).toBe('JPEG 은 jpg 와 같은 형식 — 정답에는 jpg 로 적음');
    expect(explainField('file_format', ['mov', 'mp4'], { tokens: ['MOV 또는 MP4'] })).toBeNull();
    expect(explainField('vat_included', false, { tokens: ['부가세 미포함'] })).toBe('"미포함" = 별도');
    expect(explainField('vat_included', true, { tokens: ['incl. VAT'] })).toBe('"incl." = 포함');
    expect(explainField('vat_included', true, { tokens: ['부가세 포함'] })).toBeNull();
  });

  it('정답이 표기와 맞아떨어지지 않으면 아무것도 적지 않는다(사람을 속이지 않는다)', () => {
    expect(explainField('footfall_per_day', 90_000, { tokens: ['월 300만'] })).toBeNull();
    expect(explainField('footfall_per_day', 100_000, { tokens: ['주 300만'] })).toBeNull();
    expect(explainField('hours', { open: '05:00', close: '02:00', nextDay: true }, { tokens: ['05시~25시'] })).toBeNull();
    expect(explainField('hours', { open: '10:00', close: '15:00', nextDay: false }, { tokens: ['오전 10시~오후 2시'] })).toBeNull();
    expect(explainField('price_krw', 1_500_000, { tokens: ['160만원'] })).toBeNull();
    expect(explainField('price_krw', 1_500_000, { tokens: ['150'], unit: '천원' })).toBeNull();
    expect(explainField('refund_full_days', 14, { tokens: ['1주 전 취소'] })).toBeNull();
    expect(explainField('size_m', { width: 8, height: 4.5 }, { tokens: ['8000mm*4000mm'] })).toBeNull();
    expect(explainField('size_m', { width: 8, height: 4.5 }, { tokens: ['세로 8m × 가로 4.5m'] })).toBeNull();
    expect(explainField('period_options', [{ days: 14, price_krw: 1_500_000 }], { tokens: ['1주 160만원'] })).toBeNull();
  });

  it('정답이 없음이거나 표기가 없으면 적지 않는다', () => {
    expect(explainField('price_krw', null, { tokens: ['60만원'] })).toBeNull();
    expect(explainField('price_krw', 600_000, undefined)).toBeNull();
    expect(explainField('name', '가나다 전광판', { tokens: ['가나다 전광판'] })).toBeNull();
  });

  it('가짜 설계도의 모든 표기에서 멈추지 않는다', () => {
    expect(allHints.length).toBeGreaterThan(2000);
    for (const { spec, h } of allHints) {
      const out = line(spec, h);
      expect(out === null || (typeof out === 'string' && out.length > 0)).toBe(true);
    }
  });

  it('하루 값이 아닌 유동인구 표기는 꼴마다 나눗셈이 붙는다', () => {
    for (const [cls, days] of [['month', 30], ['week', 7], ['year', 365]] as const) {
      const list = ofForm(`footfall:${cls}.`);
      expect(list.length).toBeGreaterThan(0);
      for (const { spec, h } of list) expect(line(spec, h), `${h.form} ${h.show}`).toContain(`÷ ${days} = `);
    }
    for (const { spec, h } of ofForm('footfall:day.')) expect(line(spec, h) ?? '', `${h.form} ${h.show}`).not.toContain('÷');
  });

  it('다음 날로 넘어가는 운영 시간 표기는 꼴마다 설명이 붙는다', () => {
    const list = ofForm('hours:').filter(({ spec, h }) => (spec.truth[h.field] as { nextDay: boolean }).nextDay);
    expect(new Set(list.map(({ h }) => h.form)).size).toBeGreaterThan(8);
    for (const { spec, h } of list) expect(line(spec, h), `${h.form} ${h.show}`).toMatch(/다음 날/);
  });

  it('줄여 적은 금액 표기는 꼴마다 원 단위로 풀린다. 다 적은 표기에는 붙지 않는다', () => {
    const short = ['man', 'man_space', 'zh_man', 'bare_man', 'bare_man_silent', 'bare_cheon', 'cheon', 'man_nowon', 'baekman', 'man_dec', 'cheon_man', 'man_cheon', 'en_million'];
    const full = ['won_comma', 'won_plain', 'won_space', 'sign', 'sign_wide', 'krw_pre', 'krw_post', 'zh_full', 'en_won'];
    const seen = new Set<string>();
    for (const { spec, h } of ofForm('money:')) {
      const id = h.form.slice('money:'.length);
      seen.add(id);
      const out = line(spec, h);
      if (short.includes(id)) expect(out, `${h.form} ${h.show}`).toMatch(new RegExp(`= ${comma(spec.truth[h.field] as number)}원$`));
      else if (full.includes(id)) expect(out, `${h.form} ${h.show}`).toBeNull();
    }
    expect([...seen].filter((id) => short.includes(id)).length).toBeGreaterThan(8);
  });

  it('주·달·시간으로 적은 일수 표기는 꼴마다 일수로 풀린다', () => {
    const list = [...ofForm('deadline:week.'), ...ofForm('lead:week.'), ...ofForm('deadline:hour.')];
    expect(new Set(list.map(({ h }) => h.form)).size).toBeGreaterThan(10);
    for (const { spec, h } of list) expect(line(spec, h), `${h.form} ${h.show}`).toMatch(new RegExp(`= ${spec.truth[h.field] as number}일$`));
  });

  it('다른 단위로 적은 크기 표기는 꼴마다 표준 단위로 풀린다', () => {
    const alt = ['mm_x', 'mm_star', 'mm_comma', 'mm_garo', 'mm_WH', 'mm_bare', 'cm_x', 'cm_bare', 'cm_garo', 'cm_each', 'm_x'];
    const list = [...ofForm('size_m:'), ...ofForm('size_mm:')].filter(({ h }) => alt.includes(h.form.split(':')[1] as string));
    expect(new Set(list.map(({ h }) => h.form)).size).toBeGreaterThan(8);
    for (const { spec, h } of list) {
      const v = spec.truth[h.field] as { width: number; height: number };
      const base = fieldDef(h.field).kind === 'size_m' ? 'm' : 'mm';
      const out = line(spec, h);
      expect(out, `${h.form} ${h.show}`).toContain(` = ${comma(v.width)}${base}`);
      expect(out, `${h.form} ${h.show}`).toContain(` = ${comma(v.height)}${base}`);
    }
  });

  it('늘 보이는 규칙은 있는 칸 이름에만 달려 있고, 파일 형식에는 jpeg 규칙이 있다', () => {
    for (const key of Object.keys(FIELD_RULES)) expect(() => fieldDef(key as FieldKey)).not.toThrow();
    expect(FIELD_RULES.file_format).toContain('JPEG 과 jpg 는 같은 것으로 칩니다(소문자, jpeg → jpg)');
    expect(FIELD_RULES.price_krw).toContain('가장 짧은 기간');
    expect(FIELD_RULES.name).toContain('완전히 같아야');
    expect(FIELD_RULES.refund_full_days).toContain('1개월 = 30일');
  });
});

describe('확인할 문서 고르기', () => {
  const items: TargetItem[] = specs.slice(0, 100).map((s, i) => ({ id: `x-${String(i).padStart(3, '0')}`, type: s.type, style: s.style }));
  const layer = (i: TargetItem) => `${i.type}/${i.style ?? ''}`;
  const countBy = (ids: readonly string[], key: (i: TargetItem) => string) => {
    const out = new Map<string, number>();
    for (const item of items) if (ids.includes(item.id)) out.set(key(item), (out.get(key(item)) ?? 0) + 1);
    return out;
  };

  it('씨앗이 같으면 같은 문서가, 다르면 다른 문서가 나온다', () => {
    const a = pickTarget(items, 40, 7);
    expect(a).toHaveLength(40);
    expect(pickTarget(items, 40, 7)).toEqual(a);
    expect(pickTarget([...items].reverse(), 40, 7)).toEqual(a);
    expect(pickTarget(items, 40, 8)).not.toEqual(a);
    expect([...a].sort()).toEqual(a);
    expect(new Set(a).size).toBe(40);
  });

  it('층(종류 × 글 꼴)마다 크기에 견준 몫만큼 고른다', () => {
    const picked = countBy(pickTarget(items, 40, 7), layer);
    const sizes = countBy(items.map((i) => i.id), layer);
    for (const [key, size] of sizes) {
      const ideal = (40 * size) / items.length;
      expect(picked.get(key) ?? 0, key).toBeGreaterThanOrEqual(Math.floor(ideal));
      expect(picked.get(key) ?? 0, key).toBeLessThanOrEqual(Math.ceil(ideal));
    }
  });

  it('글 꼴을 모르면 종류만으로 층을 나눈다', () => {
    const plain = items.map((i) => ({ id: i.id, type: i.type }));
    const picked = pickTarget(plain, 20, 7);
    expect(picked).toHaveLength(20);
    const byType = countBy(picked, (i) => i.type);
    for (const [type, size] of countBy(items.map((i) => i.id), (i) => i.type)) {
      expect(Math.abs((byType.get(type) ?? 0) - (20 * size) / items.length), type).toBeLessThan(1);
    }
  });

  it('이미 확인한 문서는 반드시 들어가고, 건수는 그대로다', () => {
    const base = pickTarget(items, 20, 7);
    const outside = items.map((i) => i.id).filter((id) => !base.includes(id)).slice(0, 9);
    const picked = pickTarget(items, 20, 7, outside);
    expect(picked).toHaveLength(20);
    for (const id of outside) expect(picked).toContain(id);
    // 한 층에 몰린 문서를 모두 넣어도 건수를 지킨다.
    const oneLayer = items.filter((i) => layer(i) === layer(items[0] as TargetItem)).map((i) => i.id);
    const crowded = pickTarget(items, 20, 7, oneLayer);
    expect(crowded).toHaveLength(Math.max(20, oneLayer.length));
    for (const id of oneLayer) expect(crowded).toContain(id);
  });

  it('고른 문서를 하나씩 확인해 가도 목표는 바뀌지 않는다', () => {
    const already = ['x-000', 'x-001', 'x-002', 'x-003', 'x-004', 'x-006', 'x-008', 'x-009'];
    const first = pickTarget(items, 20, 7, already);
    const keep = [...already];
    for (const id of first) {
      if (!keep.includes(id)) keep.push(id);
      expect(pickTarget(items, 20, 7, keep)).toEqual(first);
    }
  });

  it('건수가 묶음보다 크면 전부, 이미 확인한 것이 건수보다 많으면 그것 전부', () => {
    expect(pickTarget(items.slice(0, 5), 20, 7)).toEqual(items.slice(0, 5).map((i) => i.id));
    const many = items.slice(0, 30).map((i) => i.id);
    expect(pickTarget(items, 20, 7, many)).toEqual(many);
    expect(pickTarget(items, 20, 7, ['없는-번호'])).toHaveLength(20);
    expect(pickTarget([], 20, 7)).toEqual([]);
  });

  it('목표 건수는 연습 20, 안 여는 세트 40 이고 환경 변수로 바꾼다', () => {
    expect(targetCount('dev', env({}))).toBe(20);
    expect(targetCount('test', env({}))).toBe(40);
    expect(targetCount('hand', env({}))).toBeNull();
    expect(targetCount('real', env({ LABEL_TARGET_REAL: '5' }))).toBeNull();
    expect(targetCount('dev', env({ LABEL_TARGET_DEV: '12' }))).toBe(12);
    expect(targetCount('test', env({ LABEL_TARGET_TEST: '60' }))).toBe(60);
    expect(targetCount('dev', env({ LABEL_TARGET_DEV: '열' }))).toBe(20);
    expect(targetCount('dev', env({ LABEL_TARGET_DEV: '0' }))).toBe(20);
  });
});

describe('남은 시간', () => {
  it('가운데값', () => {
    expect(median([])).toBeNull();
    expect(median([75])).toBe(75);
    expect(median([124, 22, 56, 68, 85])).toBe(68);
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it('남은 건수 × 가운데값 초를 분으로 올림한다', () => {
    expect(etaMinutes([75, 75, 75], 51)).toBe(64);
    expect(etaMinutes([30], 1)).toBe(1);
    expect(etaMinutes([30], 0)).toBe(0);
    expect(etaMinutes([], 10)).toBeNull();
  });

  it('한 묶음은 10건이다', () => {
    expect(LABEL_BATCH).toBe(10);
  });

  it('연 지 5초가 안 된 문서는 너무 빠르다고 본다. 등록 대상이 아닌 글은 3초', () => {
    expect([MIN_LOOK_SECONDS, MIN_LOOK_SECONDS_NOT_PRODUCT]).toEqual([5, 3]);
    expect(tooFast('ad', 0)).toBe(0);
    expect(tooFast('ad', 2_900)).toBe(2);
    expect(tooFast('goods', 4_999)).toBe(4);
    expect(tooFast('catering', 5_000)).toBeNull();
    expect(tooFast('ad', 75_000)).toBeNull();
    expect(tooFast('not_product', 2_999)).toBe(2);
    expect(tooFast('not_product', 3_000)).toBeNull();
    expect(tooFast('ad', -50)).toBe(0);
  });
});

describe('방금 판정 되돌리기: 줄 다시 놓기', () => {
  const d = (id: string) => ({ id });
  const queue = { docs: [d('a'), d('b'), d('c')], total: 20, done: 10, seconds: [75, 30, 30] };

  it('같은 묶음의 바로 앞 문서면 한 칸 뒤로 간다', () => {
    const back = putBack(queue, 2, d('b'), 30);
    expect(back).toEqual({ queue, index: 1, sameBatch: true });
    // 묶음을 다 본 뒤(쉬어 가는 화면)에도 마지막 문서로 돌아간다.
    expect(putBack(queue, 3, d('c'), 30)).toMatchObject({ index: 2, sameBatch: true });
  });

  it('앞 묶음의 마지막 문서였으면 지금 자리에 끼워 넣고 끝낸 건수와 걸린 초에서 한 건을 뺀다', () => {
    const back = putBack(queue, 0, d('z'), 30);
    expect(back.sameBatch).toBe(false);
    expect(back.index).toBe(0);
    expect(back.queue.docs.map((x) => x.id)).toEqual(['z', 'a', 'b', 'c']);
    expect(back.queue).toMatchObject({ total: 20, done: 9, seconds: [75, 30] });
    expect(queue.docs).toHaveLength(3);
    expect(putBack({ docs: [], total: 1, done: 0 }, 0, d('z'), 5).queue).toMatchObject({ docs: [d('z')], done: 0, seconds: [] });
  });

  it('걸린 초는 뒤에서부터 하나만 뺀다', () => {
    expect(dropOne([30, 75, 30], 30)).toEqual([30, 75]);
    expect(dropOne([30, 75], 99)).toEqual([30, 75]);
    expect(dropOne([], 1)).toEqual([]);
  });
});

describe('표기 지시 읽기', () => {
  const spec = specs.find((s) => s.surface_hints.some((h) => h.unit)) as GoldSpec;
  const text = JSON.stringify({ seed: 5, specs: [spec, { id: 'x-999' }, '꼴이 다른 줄', { id: 'x-998', style: 'table', surface_hints: [{ field: '없는_칸', tokens: ['가'] }, { field: 'name', tokens: [] }] }] });

  it('문서 번호마다 칸의 조각과 단위, 글 꼴을 꺼낸다. 값(정답)은 꺼내지 않는다', () => {
    const file = parseHintFile(text);
    expect(file?.size).toBe(3);
    const doc = file?.get(spec.id);
    expect(doc?.style).toBe(spec.style);
    expect(doc?.hints.map((h) => h.field)).toEqual(spec.surface_hints.map((h) => h.field));
    expect(doc?.hints.map((h) => h.tokens)).toEqual(spec.surface_hints.map((h) => h.tokens));
    const withUnit = spec.surface_hints.find((h) => h.unit) as SurfaceHint;
    expect(doc?.hints.find((h) => h.field === withUnit.field)).toMatchObject({ unit: withUnit.unit, declareUnit: withUnit.declare_unit });
    expect(Object.keys(doc?.hints[0] ?? {}).sort()).toEqual(['field', 'tokens']);
    expect(file?.get('x-998')).toEqual({ style: 'table', hints: [] });
    expect(file?.get('x-999')).toEqual({ style: null, hints: [] });
  });

  it('요청한 문서의 조각만 내려 준다', () => {
    const file = parseHintFile(text);
    expect(Object.keys(hintsFor(file, [spec.id, '없는-문서']))).toEqual([spec.id]);
    expect(hintsFor(file, [])).toEqual({});
    expect(hintsFor(null, [spec.id])).toEqual({});
  });

  it('꼴이 다른 파일과 없는 파일은 오류 없이 null 이다', async () => {
    expect(parseHintFile('{ 깨진 글')).toBeNull();
    expect(parseHintFile('{"specs": 3}')).toBeNull();
    expect(await readHintFile(env({ LABEL_HINTS_PATH: path.join(os.tmpdir(), '없는-폴더', 'specs.json') }))).toBeNull();
  });

  it('자리는 LABEL_HINTS_PATH, 없으면 홈 아래 작업 폴더의 specs.json', () => {
    expect(hintsPath(env())).toBe(path.join(os.homedir(), 'chaeum-gold-work', 'v2', 'specs.json'));
    expect(hintsPath(env({ LABEL_HINTS_PATH: '~/다른-자리/specs.json' }))).toBe(path.join(os.homedir(), '다른-자리', 'specs.json'));
    expect(hintsPath(env({ LABEL_HINTS_PATH: ' ' }))).toBe(path.join(os.homedir(), 'chaeum-gold-work', 'v2', 'specs.json'));
  });
});
