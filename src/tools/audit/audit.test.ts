// 점검의 판단 시험. 끝났다는 기준: 일부러 망가뜨린 상품 묶음에서 넣은 문제 수와 잡은 수를 종류별로 낸다.
// 이름과 값은 모두 지어낸 것이다.
import { describe, expect, it } from 'vitest';
import { PLACEHOLDERS, type GenerateContentInput, type GlossaryEntry, type PlaceholderValues } from '@/contract/content';
import type { ExportTemplate } from '@/contract/export-template';
import { AUDIT_CODES, AuditResponseSchema, type AuditCode, type AuditItem, type AuditSubject } from '@/contract/tools/audit';
import { pickGlossary } from '@/content/glossary';
import { templateTexts } from '@/content/template';
import { auditCsvRows, auditSubject, parseCsv, readTable, summarize } from './index';

const GLOSSARY: GlossaryEntry[] = [
  { ko: '전광판', en: 'digital billboard', 'zh-Hans': '电子屏' },
  { ko: '합정역', en: 'Hapjeong Station', 'zh-Hans': '合井站' },
  { ko: '커피차', en: 'coffee truck', 'zh-Hans': '咖啡车' },
  { ko: '포토카드', en: 'photocard', 'zh-Hans': '小卡' },
];

type Values = Record<string, unknown>;

/**
 * 본체가 만드는 틀 문장을 그 상품의 값으로 지어 붙인다(값을 망가뜨려도 글은 그 값과 맞게 나온다).
 * 그래야 값 문제 하나를 넣었을 때 글 문제가 딸려 나오지 않고, 넣은 수와 잡은 수를 하나씩 견줄 수 있다.
 */
function textsFor(type: 'ad' | 'catering' | 'goods', subtype: string, values: Values): AuditSubject['texts'] {
  const name = typeof values.name === 'string' ? values.name : '';
  const region = (type === 'ad' ? values.region : type === 'catering' ? values.service_region : null) as string | null;
  const facts = { type, subtype, name, region: region ?? null };
  const options = (type === 'ad' ? values.period_options : values.quantity_options) as { days?: number; qty?: number }[] | undefined;
  const keys = (options ?? []).map((o) => o.days ?? o.qty ?? 0);
  const numbers: PlaceholderValues = { price: values.price_krw as number };
  if (keys.length > 0) numbers[type === 'ad' ? 'days' : 'qty'] = Math.min(...keys);
  const input: GenerateContentInput = {
    content: { ...facts, glossary: pickGlossary(GLOSSARY, facts), placeholders: PLACEHOLDERS.filter((p) => numbers[p] !== undefined) },
    values: numbers,
  };
  const [titleEn, summaryEn, titleZh, summaryZh] = templateTexts(input).map((t) => t.text);
  return { title_en: titleEn, summary_en: summaryEn, title_zh: titleZh, summary_zh: summaryZh };
}

const AD_VALUES: Values = {
  name: '합정역 전광판',
  price_krw: 1_500_000,
  list_price_krw: 1_800_000,
  vat_included: false,
  region: '합정역 4번 출구',
  size_m: { width: 7, height: 12 },
  hours: { open: '05:00', close: '01:00', nextDay: true },
  footfall_per_day: 100_000,
  period_options: [
    { days: 7, price_krw: 1_500_000 },
    { days: 14, price_krw: 2_800_000 },
  ],
  file_format: ['jpg', 'mp4'],
};
const CATERING_VALUES: Values = {
  name: '달보드레 커피차',
  price_krw: 800_000,
  list_price_krw: null,
  vat_included: true,
  service_region: '서울 전역',
  quantity_options: [{ qty: 100, price_krw: 800_000 }],
};
const GOODS_VALUES: Values = {
  name: '별무리 포토카드 세트',
  price_krw: 12_000,
  list_price_krw: null,
  vat_included: true,
  size_mm: { width: 55, height: 85 },
  material: '스노우지',
  min_order_qty: 10,
};

let serial = 0;
function subject(
  type: AuditSubject['type'],
  subtype: string | null,
  values: Values,
  change: { texts?: Partial<Record<keyof AuditSubject['texts'], string | undefined>>; unreadable?: string[]; stored?: AuditSubject['stored'] } = {},
): AuditSubject {
  serial += 1;
  const texts = { ...(type && subtype ? textsFor(type, subtype, values) : {}), ...change.texts };
  for (const key of Object.keys(texts) as (keyof typeof texts)[]) if (texts[key] === undefined) delete texts[key];
  return { key: `product:${serial}`, productId: serial, rowNumber: null, type, subtype, values, texts: texts as AuditSubject['texts'], unreadable: change.unreadable ?? [], ...(change.stored ? { stored: change.stored } : {}) };
}

const ad = (over: Values = {}, change?: Parameters<typeof subject>[3], subtype: string | null = '전광판') => subject('ad', subtype, { ...AD_VALUES, ...over }, change);
const catering = (over: Values = {}, change?: Parameters<typeof subject>[3]) => subject('catering', '커피차', { ...CATERING_VALUES, ...over }, change);
const goods = (over: Values = {}, change?: Parameters<typeof subject>[3], subtype: string | null = '인쇄물') => subject('goods', subtype, { ...GOODS_VALUES, ...over }, change);

const codesOf = (s: AuditSubject) => auditSubject(s, GLOSSARY).map((f) => f.code);

describe('멀쩡한 상품', () => {
  it('본체가 만든 틀 문장이 붙은 멀쩡한 상품 셋은 하나도 걸리지 않는다', () => {
    for (const s of [ad(), catering(), goods()]) expect(auditSubject(s, GLOSSARY)).toEqual([]);
  });

  it('모델이 쓴 꼴의 글(값·일수와 지역 속 숫자가 든 글)도 걸리지 않는다', () => {
    const s = ad({}, {
      texts: {
        title_en: 'Hapjeong Station Digital Billboard',
        summary_en: 'A digital billboard at Hapjeong Station Exit 4, from KRW 1,500,000 for 7 days.',
        title_zh: '合井站电子屏',
        summary_zh: '合井站4号出口的电子屏广告位，7天1,500,000韩元起。',
      },
    });
    expect(auditSubject(s, GLOSSARY)).toEqual([]);
  });
});

describe('일부러 망가뜨린 상품 묶음', () => {
  // 한 줄이 문제 하나(또는 적어 둔 수)를 넣은 상품이다. 넣은 종류와 수를 적어 둔다.
  const broken: { planted: Partial<Record<AuditCode, number>>; subject: AuditSubject }[] = [
    // 필수 옵션 0개
    { planted: { EMPTY_REQUIRED_OPTIONS: 1 }, subject: ad({ period_options: [] }) },
    { planted: { EMPTY_REQUIRED_OPTIONS: 1 }, subject: catering({ quantity_options: [] }) },
    // 종류·갈래 불일치
    { planted: { TYPE_SUBTYPE_MISMATCH: 1 }, subject: ad({}, undefined, '커피차') },
    { planted: { TYPE_SUBTYPE_MISMATCH: 1 }, subject: goods({}, undefined, '전광판') },
    // 자리 채움 글자
    { planted: { PLACEHOLDER_VALUE: 1 }, subject: ad({ region: '추후 안내' }) },
    { planted: { PLACEHOLDER_VALUE: 1 }, subject: goods({ material: '-' }) },
    { planted: { PLACEHOLDER_VALUE: 1 }, subject: catering({ service_region: '문의' }) },
    // 값 범위: 0 이하, 정가보다 큰 판매가(두 칸에 붙는다), 24시간을 넘는 운영, 기간이 길수록 싸짐, 터무니없는 크기
    { planted: { OUT_OF_RANGE: 1 }, subject: goods({ min_order_qty: 0 }) },
    { planted: { OUT_OF_RANGE: 2 }, subject: ad({ list_price_krw: 1_000_000 }) },
    { planted: { OUT_OF_RANGE: 1 }, subject: ad({ hours: { open: '05:00', close: '06:00', nextDay: true } }) },
    { planted: { OUT_OF_RANGE: 1 }, subject: ad({ period_options: [{ days: 7, price_krw: 1_500_000 }, { days: 14, price_krw: 900_000 }] }) },
    { planted: { OUT_OF_RANGE: 1 }, subject: goods({ size_mm: { width: 55_000, height: 85 } }) },
    // 필수 칸 빔
    { planted: { REQUIRED_MISSING: 1 }, subject: ad({ footfall_per_day: null }) },
    { planted: { REQUIRED_MISSING: 1 }, subject: goods({ size_mm: null }) },
    // 빈 번역: 글 줄이 없음, 점뿐인 글
    { planted: { EMPTY_TEXT: 1 }, subject: ad({}, { texts: { summary_zh: undefined } }) },
    { planted: { EMPTY_TEXT: 1 }, subject: goods({}, { texts: { title_en: '...' } }) },
    { planted: { EMPTY_TEXT: 4 }, subject: catering({}, { texts: { title_en: undefined, summary_en: undefined, title_zh: undefined, summary_zh: undefined } }) },
    // 한글 섞임
    { planted: { HANGUL_IN_TEXT: 1 }, subject: ad({}, { texts: { title_en: 'Hapjeong Station digital billboard 전광판' } }) },
    { planted: { HANGUL_IN_TEXT: 1 }, subject: goods({}, { texts: { title_zh: '별무리 小卡套装' } }) },
    // 혼잣말 흔적
    { planted: { MONOLOGUE: 1 }, subject: goods({}, { texts: { summary_en: 'Sure, here is the summary: a set of printed photocards.' } }) },
    { planted: { MONOLOGUE: 1 }, subject: goods({}, { texts: { title_zh: '以下是标题：小卡套装' } }) },
    // 용어 표기
    { planted: { GLOSSARY_MISS: 1 }, subject: ad({}, { texts: { title_en: 'Hapjeong Station LED screen' } }) },
    { planted: { GLOSSARY_MISS: 1 }, subject: catering({}, { texts: { title_zh: 'Dalbodeure 咖啡餐车' } }) },
    // 숫자 어긋남
    { planted: { STRAY_NUMBER: 1 }, subject: ad({}, { texts: { summary_en: 'Hapjeong Station digital billboard, from KRW 1,600,000 for 7 days.' } }) },
    { planted: { STRAY_NUMBER: 1 }, subject: catering({}, { texts: { summary_zh: '咖啡车，200杯800,000韩元起。' } }) },
    // 숫자 어긋남: 이 상품의 다른 칸에 있는 숫자(다른 옵션의 값·일수, 크기)를 글에 쓴 것. 값과 기간의 짝이 틀린 글이다.
    { planted: { STRAY_NUMBER: 1 }, subject: ad({}, { texts: { summary_en: 'Hapjeong Station digital billboard, from KRW 2,800,000 for 7 days.' } }) },
    { planted: { STRAY_NUMBER: 1 }, subject: ad({}, { texts: { summary_en: 'Hapjeong Station digital billboard, from KRW 1,500,000 for 14 days.' } }) },
    { planted: { STRAY_NUMBER: 1 }, subject: ad({}, { texts: { summary_zh: '合井站电子屏，12天1,500,000韩元起。' } }) },
    // 글 확인 필요: 본체가 "확인 필요"로 저장한 글. 글자는 틀 문장이라 지금의 글 검사를 통과한다.
    { planted: { TEXT_NEEDS_REVIEW: 1 }, subject: goods({}, { stored: { summary_zh: { source: 'template', status: 'needs_review', failCodes: ['MONOLOGUE', 'GLOSSARY_MISS'] } } }) },
    { planted: { TEXT_NEEDS_REVIEW: 1 }, subject: catering({}, { stored: { title_en: { source: 'template', status: 'needs_review', failCodes: [] }, summary_en: { source: 'llm', status: 'ok', failCodes: [] } } }) },
    // 자리표시가 남은 글
    { planted: { PLACEHOLDER_LOST: 1 }, subject: goods({}, { texts: { summary_en: 'Photocard set, from {price}.' } }) },
    // 읽지 못한 칸(파일에서만 난다). 값이 비어 있어도 "필수 칸 빔"을 또 붙이지 않는다.
    { planted: { UNREADABLE_CELL: 1 }, subject: ad({ size_m: null }, { unreadable: ['size_m'] }) },
  ];
  const clean = [ad(), catering(), goods()];

  it('넣은 문제 수와 잡은 문제 수가 종류별로 같다. 멀쩡한 상품은 잡히지 않는다', () => {
    const tally = Object.fromEntries(AUDIT_CODES.map((code) => [code, { planted: 0, caught: 0 }])) as Record<AuditCode, { planted: number; caught: number }>;
    for (const row of broken) {
      for (const [code, n] of Object.entries(row.planted)) tally[code as AuditCode].planted += n;
      for (const f of auditSubject(row.subject, GLOSSARY)) tally[f.code].caught += 1;
    }
    // 종류별 넣은 수와 잡은 수. 이 표가 이 도구의 "끝났다는 기준"이다(바꾼 곳 35군데에서 문제 36건을 넣어 36건을 잡는다.
    // 바꾼 곳보다 문제가 하나 많은 것은 정가 한 칸을 바꾸면 판매가·정가 두 칸에 값 범위가 붙어서다).
    expect(tally).toEqual({
      REQUIRED_MISSING: { planted: 2, caught: 2 },
      EMPTY_REQUIRED_OPTIONS: { planted: 2, caught: 2 },
      TYPE_SUBTYPE_MISMATCH: { planted: 2, caught: 2 },
      PLACEHOLDER_VALUE: { planted: 3, caught: 3 },
      OUT_OF_RANGE: { planted: 6, caught: 6 },
      PLACEHOLDER_LOST: { planted: 1, caught: 1 },
      STRAY_NUMBER: { planted: 5, caught: 5 },
      HANGUL_IN_TEXT: { planted: 2, caught: 2 },
      EMPTY_TEXT: { planted: 6, caught: 6 },
      MONOLOGUE: { planted: 2, caught: 2 },
      GLOSSARY_MISS: { planted: 2, caught: 2 },
      TEXT_NEEDS_REVIEW: { planted: 2, caught: 2 },
      UNREADABLE_CELL: { planted: 1, caught: 1 },
    });
    // 상품 하나씩도 본다: 넣은 종류만, 넣은 수만큼 잡힌다.
    for (const row of broken) {
      const caught: Partial<Record<AuditCode, number>> = {};
      for (const code of codesOf(row.subject)) caught[code] = (caught[code] ?? 0) + 1;
      expect(caught, row.subject.key).toEqual(row.planted);
    }
    for (const s of clean) expect(auditSubject(s, GLOSSARY)).toEqual([]);
  });

  it('묶음: 합계, 사유별(값 문제 먼저, 많은 것부터), 문제 있는 상품이 먼저', () => {
    const items: AuditItem[] = [...clean, ...broken.map((b) => b.subject)].map((s) => ({
      key: s.key,
      productId: s.productId,
      rowNumber: s.rowNumber,
      name: s.values.name as string,
      type: s.type,
      subtype: s.subtype,
      findings: auditSubject(s, GLOSSARY),
    }));
    const out = summarize(items);
    const planted = broken.reduce((sum, b) => sum + Object.values(b.planted).reduce((a, n) => a + n, 0), 0);
    expect(planted).toBe(36);
    expect(out.totals).toEqual({ items: 35, itemsWithFindings: 32, findings: planted, bySeverity: { error: 16, warning: 20 } });
    expect(out.byCode.map((c) => `${c.code}:${c.findings}/${c.items}`)).toEqual([
      'OUT_OF_RANGE:6/5',
      'PLACEHOLDER_VALUE:3/3',
      'REQUIRED_MISSING:2/2',
      'EMPTY_REQUIRED_OPTIONS:2/2',
      'TYPE_SUBTYPE_MISMATCH:2/2',
      'UNREADABLE_CELL:1/1',
      'EMPTY_TEXT:6/3',
      'STRAY_NUMBER:5/5',
      'HANGUL_IN_TEXT:2/2',
      'MONOLOGUE:2/2',
      'GLOSSARY_MISS:2/2',
      'TEXT_NEEDS_REVIEW:2/2',
      'PLACEHOLDER_LOST:1/1',
    ]);
    expect(out.items.slice(0, 32).every((i) => i.findings.length > 0)).toBe(true);
    expect(out.items.slice(32).map((i) => i.key)).toEqual(clean.map((s) => s.key));
    // 약속한 응답 꼴이다.
    expect(AuditResponseSchema.safeParse({ source: 'workspace', file: null, ...out, truncated: false }).success).toBe(true);

    const rows = auditCsvRows(out.items);
    expect(rows).toHaveLength(planted);
    expect(rows[0]).toHaveLength(10);
  });
});

describe('문제 한 줄', () => {
  it('값 문제가 먼저, 그 안에서는 코드 목록 순서다. 무엇이 틀렸는지 사람 말로 적는다', () => {
    const s = ad({ period_options: [], footfall_per_day: null, region: '-' }, { texts: { title_en: 'Hapjeong 전광판' } }, '커피차');
    const found = auditSubject(s, GLOSSARY);
    expect(found.map((f) => [f.code, f.severity, f.field])).toEqual([
      ['REQUIRED_MISSING', 'error', 'footfall_per_day'],
      ['EMPTY_REQUIRED_OPTIONS', 'error', 'period_options'],
      ['TYPE_SUBTYPE_MISMATCH', 'error', null],
      ['PLACEHOLDER_VALUE', 'error', 'region'],
      ['HANGUL_IN_TEXT', 'warning', 'title_en'],
      ['GLOSSARY_MISS', 'warning', 'title_en'],
    ]);
    expect(found[1]?.message).toBe('기간 옵션: 고를 것이 0개입니다.');
    expect(found[2]?.message).toBe('종류·갈래: 광고 지면에 없는 갈래입니다("커피차").');
    expect(found[5]?.message).toBe('영어 제목: 용어 사전에 정한 표기가 글에 없습니다: "Hapjeong Station", "digital billboard".');
  });

  it('어긋난 숫자가 무엇인지 적는다. 쉼표만 다른 같은 수는 봐준다', () => {
    const s = ad({}, { texts: { summary_en: 'Hapjeong Station digital billboard: 1500000 won for 7 days, or 2,900,000 for 14.' } });
    const found = auditSubject(s, GLOSSARY);
    expect(found.map((f) => f.code)).toEqual(['STRAY_NUMBER']);
    expect(found[0]?.message).toContain('2,900,000');
    expect(found[0]?.message).not.toContain('1500000');
  });

  it('글에 나와도 되는 숫자는 본체가 자리표시로 넣는 값과 이름·지역의 숫자뿐이다. 다른 칸의 숫자는 어긋난 숫자다', () => {
    const withText = (summary_en: string) => auditSubject(ad({ resolution_px: { width: 1080, height: 1920 }, spots_per_day: 100 }, { texts: { summary_en } }), GLOSSARY);
    // 판매가 1,500,000 · 가장 짧은 기간 7 · 지역의 "4번 출구" 는 된다.
    expect(withText('Hapjeong Station digital billboard at Exit 4, from KRW 1,500,000 for 7 days.')).toEqual([]);
    // 14일 옵션의 값, 해상도, 하루 송출 횟수, 크기는 이 상품의 값이지만 글에 나오면 어긋난 숫자다.
    for (const [text, stray] of [
      ['Hapjeong Station digital billboard, from KRW 2,800,000 for 7 days.', '2,800,000'],
      ['Hapjeong Station digital billboard, from KRW 1,080 for 100 days.', '1,080, 100'],
      ['Hapjeong Station digital billboard, 12 m tall, from KRW 1,500,000.', '12'],
    ] as const) {
      const found = withText(text);
      expect(found.map((f) => f.code), text).toEqual(['STRAY_NUMBER']);
      expect(found[0]?.message, text).toContain(`: ${stray}.`);
    }
    // 굿즈는 최소 주문 수량이 된다.
    expect(auditSubject(goods({}, { texts: { summary_en: 'A photocard set, from KRW 12,000, minimum order 10.' } }), GLOSSARY)).toEqual([]);
    expect(auditSubject(goods({}, { texts: { summary_en: 'A photocard set, from KRW 12,000, size 55 mm.' } }), GLOSSARY).map((f) => f.code)).toEqual(['STRAY_NUMBER']);
  });

  it('본체가 "확인 필요"로 저장한 글은 지금 글자가 검사를 통과해도 "글 확인 필요"로 낸다. 까닭을 함께 적는다', () => {
    const stored: AuditSubject['stored'] = {
      title_zh: { source: 'llm', status: 'ok', failCodes: [] },
      summary_zh: { source: 'template', status: 'needs_review', failCodes: ['MONOLOGUE', 'GLOSSARY_MISS'] },
      summary_en: { source: 'template', status: 'needs_review', failCodes: [] },
    };
    const found = auditSubject(goods({}, { stored }), GLOSSARY);
    expect(found.map((f) => [f.code, f.severity, f.field])).toEqual([
      ['TEXT_NEEDS_REVIEW', 'warning', 'summary_en'],
      ['TEXT_NEEDS_REVIEW', 'warning', 'summary_zh'],
    ]);
    expect(found[0]?.message).toBe('영어 요약: 모델 글 대신 코드의 틀 문장이 들어가 있습니다(모델을 부르지 못했습니다). 사람이 읽어 봐야 합니다.');
    expect(found[1]?.message).toContain('모델이 마지막으로 쓴 글이 걸린 검사: 혼잣말 흔적, 용어 표기 다름');
    // 저장된 상태가 없는 줄(파일)은 글자만 본다.
    expect(auditSubject(goods(), GLOSSARY)).toEqual([]);
  });

  it('지역의 용어 표기는 요약에만 있어야 한다. 제목에는 이름 속 낱말의 표기만 본다', () => {
    // 이름에는 "합정역"이 없고 지역에만 있다.
    const base = { name: '루미온 전광판', region: '합정역 4번 출구' };
    const texts = { title_en: 'Lumion digital billboard', title_zh: 'Lumion电子屏' };
    expect(auditSubject(ad(base, { texts }), GLOSSARY)).toEqual([]);
    // 요약에서 지역 표기를 빼면 요약만 걸린다. 제목은 그대로 통과다.
    const found = auditSubject(ad(base, { texts: { ...texts, summary_en: 'Lumion digital billboard, from KRW 1,500,000 for 7 days.' } }), GLOSSARY);
    expect(found.map((f) => [f.code, f.field])).toEqual([['GLOSSARY_MISS', 'summary_en']]);
    expect(found[0]?.message).toContain('"Hapjeong Station"');
  });

  it('용어 사전이 바뀌면 같은 글이 달리 판정된다(승인된 용어만 넘어온다)', () => {
    const s = ad();
    expect(auditSubject(s, GLOSSARY)).toEqual([]);
    const changed = GLOSSARY.map((e) => (e.ko === '전광판' ? { ...e, en: 'LED billboard' } : e));
    const found = auditSubject(s, changed);
    expect(found.map((f) => [f.code, f.field])).toEqual([
      ['GLOSSARY_MISS', 'title_en'],
      ['GLOSSARY_MISS', 'summary_en'],
    ]);
    // 용어가 하나도 없으면 용어 표기는 걸릴 것이 없다.
    expect(auditSubject(s, [])).toEqual([]);
  });

  it('종류를 모르면 종류 문제만 내고 칸 규칙은 돌리지 않는다. 글 규칙은 돈다', () => {
    const s = subject(null, null, { name: '이름 모를 상품', price_krw: -5 }, { texts: { title_en: 'Unknown', summary_en: '한글', title_zh: '未知', summary_zh: '未知商品' } });
    expect(auditSubject(s, GLOSSARY).map((f) => [f.code, f.field])).toEqual([
      ['TYPE_SUBTYPE_MISMATCH', null],
      ['HANGUL_IN_TEXT', 'summary_en'],
    ]);
  });

  it('살필 수 없는 자리(파일에 열이 없는 칸)는 비어 있어도 걸지 않는다', () => {
    const s = subject('ad', '전광판', { name: '합정역 전광판', price_krw: 1_500_000 }, { texts: { title_en: undefined, summary_en: undefined, title_zh: undefined, summary_zh: undefined } });
    expect(auditSubject(s, GLOSSARY).length).toBeGreaterThan(4);
    expect(auditSubject(s, GLOSSARY, { covered: new Set(['name', 'price_krw']) })).toEqual([]);
  });
});

// ── 파일 읽기 ──────────────────────────────────────────────

const TEMPLATE: ExportTemplate = {
  name: 't',
  columns: [
    { header: '상품번호', from: 'product_id' },
    { header: '종류', from: 'type_label' },
    { header: '갈래', from: 'subtype' },
    { header: '상품명', from: 'name' },
    { header: '판매가(원)', from: 'price_krw' },
    { header: '통화', value: 'KRW' },
    { header: '부가세포함', from: 'vat_included', format: 'yn' },
    { header: '위치', from: 'region' },
    { header: '크기(m)', from: 'size_m' },
    { header: '운영시간', from: 'hours' },
    { header: '하루유동인구(명)', from: 'footfall_per_day' },
    { header: '기간옵션', from: 'period_options' },
    { header: '소재파일형식', from: 'file_format' },
    { header: '수량옵션', from: 'quantity_options' },
    { header: '영문제목', from: 'title_en' },
  ],
};
const HEADER = TEMPLATE.columns.map((c) => c.header);
const read = (csv: string, template = TEMPLATE, limit = 500) => {
  const [header, ...rows] = parseCsv(csv);
  return readTable({ header: header ?? [], rows, template, stripFormulaPrefix: true, limit });
};

describe('CSV 가르기', () => {
  it('따옴표 안의 쉼표·줄바꿈·겹따옴표를 읽고 BOM 을 뗀다', () => {
    expect(parseCsv('﻿a,b\r\n"1,2","줄\n바꿈"\r\n"그는 ""네""라고 했다",\r\n')).toEqual([
      ['a', 'b'],
      ['1,2', '줄\n바꿈'],
      ['그는 "네"라고 했다', ''],
    ]);
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('')).toEqual([]);
  });
});

describe('양식 꼴 표 읽기', () => {
  it('내려받기가 적은 꼴(크기, 시간, 옵션, 형식, Y/N)을 표준 값으로 읽는다', () => {
    const out = read(
      [
        HEADER.join(','),
        '7,광고 지면,전광판,합정역 전광판,1500000,KRW,N,합정역,7x12,05:00~01:00(+1),100000,7일:1500000;14일:2800000,jpg;mp4,,Hapjeong Station digital billboard',
        "8,케이터링,커피차,'=달보드레 커피차,800000,KRW,Y,,,,,,,100개:800000,",
      ].join('\r\n'),
    );
    expect(out.rows).toBe(2);
    expect(out.missingHeaders).toEqual([]);
    expect(out.subjects[0]).toMatchObject({
      key: 'row:1', productId: 7, rowNumber: 1, type: 'ad', subtype: '전광판', unreadable: [],
      texts: { title_en: 'Hapjeong Station digital billboard' },
    });
    expect(out.subjects[0]?.values).toMatchObject({
      name: '합정역 전광판', price_krw: 1500000, vat_included: false, region: '합정역',
      size_m: { width: 7, height: 12 }, hours: { open: '05:00', close: '01:00', nextDay: true }, footfall_per_day: 100000,
      period_options: [{ days: 7, price_krw: 1500000 }, { days: 14, price_krw: 2800000 }], file_format: ['jpg', 'mp4'],
    });
    // 수식 막기로 붙은 ' 는 뗀다. 빈칸은 "없음"이고, 글 줄이 빈 자리는 빠진다.
    expect(out.subjects[1]?.values).toMatchObject({ name: '=달보드레 커피차', region: null, size_m: null, quantity_options: [{ qty: 100, price_krw: 800000 }] });
    expect(out.subjects[1]?.texts).toEqual({});
  });

  it('꼴대로 못 읽은 칸은 값을 비우고 읽지 못한 칸으로 남긴다', () => {
    const out = read([HEADER.join(','), '1,광고 지면,전광판,합정역 전광판,150만원,KRW,예,합정역,7 by 12,05시~25시,많음,1주 150,jpg,,'].join('\n'));
    const s = out.subjects[0] as AuditSubject;
    expect(s.unreadable).toEqual(['price_krw', 'vat_included', 'size_m', 'hours', 'footfall_per_day', 'period_options']);
    expect(s.values).toMatchObject({ price_krw: null, size_m: null, hours: null, period_options: null, region: '합정역' });
    // 읽지 못한 칸은 "읽지 못한 칸" 하나로만 알린다(필수 칸 빔을 또 붙이지 않는다).
    const codes = auditSubject(s, GLOSSARY, { covered: out.covered }).map((f) => f.code);
    expect(codes.filter((c) => c === 'UNREADABLE_CELL')).toHaveLength(6);
    expect(codes).not.toContain('REQUIRED_MISSING');
  });

  it('광고 지면의 기간 옵션 칸이 비었으면 옵션 0개다', () => {
    const out = read([HEADER.join(','), '1,광고 지면,전광판,합정역 전광판,1500000,KRW,N,합정역,7x12,05:00~01:00(+1),100000,,jpg,,Hapjeong Station digital billboard'].join('\n'));
    expect(out.subjects[0]?.values.period_options).toEqual([]);
    expect(auditSubject(out.subjects[0] as AuditSubject, GLOSSARY, { covered: out.covered }).map((f) => f.code)).toEqual(['EMPTY_REQUIRED_OPTIONS']);
  });

  it('종류를 모르면 null 이다. 빈 줄은 건너뛰고 줄 번호는 파일의 자리 그대로다', () => {
    const out = read([HEADER.join(','), '1,기타,전광판,이름 모를 상품,1,KRW,N,,,,,,,,', ',,,,,,,,,,,,,,', '3,굿즈,인쇄물,별무리 포토카드 세트,12000,KRW,Y,,,,,,,,'].join('\n'));
    expect(out.rows).toBe(2);
    expect(out.subjects.map((s) => [s.key, s.type])).toEqual([['row:1', null], ['row:3', 'goods']]);
  });

  it('파일에 없는 열은 살필 수 없는 자리다. 모르는 칸 이름은 무시한다', () => {
    const out = read(['상품명,종류,갈래,판매가(원),메모', '합정역 전광판,광고 지면,전광판,1500000,아무 말'].join('\n'));
    expect(out.matchedHeaders).toBe(4);
    expect(out.missingHeaders).toContain('위치');
    expect([...out.covered].sort()).toEqual(['name', 'price_krw']);
    // 열이 없는 필수 칸(위치, 크기 …)과 글 자리는 걸지 않는다.
    expect(auditSubject(out.subjects[0] as AuditSubject, GLOSSARY, { covered: out.covered })).toEqual([]);
  });

  it('나눠 적은 열(가로·세로, 시작·끝·다음 날)과 JSON 열, 쉼표 든 수를 읽는다. 나눈 열이 모자라면 살피지 않는다', () => {
    const split: ExportTemplate = {
      name: 's',
      columns: [
        { header: 'category', from: 'type' },
        { header: 'title_ko', from: 'name' },
        { header: 'width_m', from: 'size_m', format: 'width' },
        { header: 'height_m', from: 'size_m', format: 'height' },
        { header: 'open_time', from: 'hours', format: 'open' },
        { header: 'close_time', from: 'hours', format: 'close' },
        { header: 'close_next_day', from: 'hours', format: 'next_day' },
        { header: 'price', from: 'price_krw', format: 'comma' },
        { header: 'tax_included', from: 'vat_included', format: 'bool' },
        { header: 'period_prices_json', from: 'period_options', format: 'json' },
      ],
    };
    const header = split.columns.map((c) => c.header).join(',');
    const out = read([header, 'ad,합정역 전광판,7.5,12,05:00,01:00,Y,"1,500,000",false,"[{""days"":7,""price_krw"":1500000}]"', 'ad,강남역 전광판,7,,09:00,25:00,N,x,true,[oops'].join('\n'), split);
    expect(out.subjects[0]?.values).toEqual({
      name: '합정역 전광판', size_m: { width: 7.5, height: 12 }, hours: { open: '05:00', close: '01:00', nextDay: true },
      price_krw: 1500000, vat_included: false, period_options: [{ days: 7, price_krw: 1500000 }],
    });
    expect(out.subjects[1]?.unreadable).toEqual(['size_m', 'hours', 'price_krw', 'period_options']);

    const noNextDay = read(['category,title_ko,open_time,close_time', 'ad,합정역 전광판,05:00,01:00'].join('\n'), split);
    expect(noNextDay.covered.has('hours')).toBe(false);
    expect(noNextDay.subjects[0]?.values).toEqual({ name: '합정역 전광판' });
  });

  it('XLSX 의 "옵션" 시트를 상품 열쇠로 이어 옵션 칸을 채운다. 줄이 없는 상품은 옵션 0개다', () => {
    const template: ExportTemplate = { name: 'x', columns: TEMPLATE.columns.filter((c) => !('from' in c && (c.from === 'period_options' || c.from === 'quantity_options'))) };
    const header = template.columns.map((c) => c.header);
    const row = (id: number, type: string, subtype: string, name: string) => [id, type, subtype, name, 1000, 'KRW', 'Y', null, null, null, null, null, null];
    const out = readTable({
      header,
      rows: [row(7, '광고 지면', '전광판', '=합정역 전광판'), row(8, '케이터링', '커피차', '달보드레 커피차'), row(9, '광고 지면', '버스', '옵션 없는 버스'), row(10, '굿즈', '인쇄물', '별무리 포토카드 세트')],
      template,
      stripFormulaPrefix: false,
      optionSheet: [
        ['상품번호', '상품명', '옵션종류', '일수', '수량', '값(원)'],
        [7, '합정역 전광판', '기간', 7, null, 1500000],
        [7, '합정역 전광판', '기간', 14, null, 2800000],
        [8, '달보드레 커피차', '수량', null, 100, 800000],
      ],
      limit: 500,
    });
    expect(out.covered.has('period_options') && out.covered.has('quantity_options')).toBe(true);
    expect(out.subjects.map((s) => s.values.period_options ?? s.values.quantity_options ?? null)).toEqual([
      [{ days: 7, price_krw: 1500000 }, { days: 14, price_krw: 2800000 }],
      [{ qty: 100, price_krw: 800000 }],
      [],
      null,
    ]);
    // XLSX 는 수식 막기 글자를 붙이지 않으므로 떼지도 않는다.
    expect(out.subjects[0]?.values.name).toBe('=합정역 전광판');
  });

  it('상한까지만 상품으로 만들고 줄 수는 끝까지 센다', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `${i + 1},굿즈,인쇄물,포토카드 ${i + 1}호,1000,KRW,Y,,,,,,,,`);
    const out = read([HEADER.join(','), ...lines].join('\n'), TEMPLATE, 3);
    expect(out.rows).toBe(5);
    expect(out.subjects).toHaveLength(3);
  });
});
