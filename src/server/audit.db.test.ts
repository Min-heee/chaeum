// 점검: 공간의 상품 읽기, 올린 파일 읽기, 경로. 시험용 DB 가 필요하다.
// 이 시험은 tests/ 아래가 아니라 여기 있다. DB 시험이 도는 자리(vitest 의 db 쪽 include)가 src/**/*.db.test.ts 이기 때문이다.
// 이름과 값은 모두 지어낸 것이다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvaluatedField } from '@/contract/core-api';
import type { ProductText } from '@/contract/content';
import { AuditResponseSchema, AUDIT_CSV_COLUMNS, AUDIT_LIMITS, type AuditItem, type AuditResponse } from '@/contract/tools/audit';
import { parseCsv, readTable, regionOfSubject } from '@/tools/audit';
import { POST as auditRoute } from '../../app/api/audits/route';
import { call } from '../../tests/api/helpers';
import { at, count, dropWorkspaces, field, GOODS_FIELDS, newWorkspace, reviewableDraft } from '../../tests/integration/helpers';
import { auditFile, auditWorkspace, productSubject, zipUnpackedSize } from './audit';
import { regionOf } from './content-input';
import { closePool, getPool } from './db';
import { exportCsv, loadExportTemplate, productsCsv } from './export-csv';
import { exportXlsx } from './export-xlsx';
import { listProducts, listProductTextsByWorkspace, saveProductTexts } from './repos/products';
import { approveDraft } from './review';

const line = (lang: ProductText['lang'], f: ProductText['field'], text: string): ProductText => ({ field: f, lang, text, source: 'human', status: 'ok', failCodes: [] });
const fourTexts = (titleEn: string, summaryEn: string, titleZh: string, summaryZh: string): ProductText[] => [
  line('en', 'title', titleEn),
  line('en', 'summary', summaryEn),
  line('zh-Hans', 'title', titleZh),
  line('zh-Hans', 'summary', summaryZh),
];

const AD_FIELDS: EvaluatedField[] = [
  field('name', '합정역 전광판'), field('price_krw', 1500000), field('list_price_krw', null), field('vat_included', false),
  field('region', '합정역 4번 출구'), field('size_m', { width: 7, height: 12 }), field('hours', { open: '05:00', close: '01:00', nextDay: true }),
  field('footfall_per_day', 100000), field('period_options', [{ days: 7, price_krw: 1500000 }, { days: 14, price_krw: 2800000 }]),
  field('file_format', ['jpg', 'mp4']), field('resolution_px', { width: 1920, height: 1080 }),
];
// 필수 옵션 0개, 하루 유동인구 없음.
const BROKEN_AD_FIELDS: EvaluatedField[] = [
  field('name', '강남역 전광판'), field('price_krw', 2000000), field('list_price_krw', null), field('vat_included', null),
  field('region', '강남역'), field('size_m', { width: 5, height: 3 }), field('hours', { open: '06:00', close: '00:00', nextDay: true }),
  field('footfall_per_day', null), field('period_options', []),
];
const CATERING_FIELDS: EvaluatedField[] = [
  field('name', '달보드레 커피차'), field('price_krw', 800000), field('list_price_krw', null), field('vat_included', true),
  field('service_region', '서울 전역'), field('quantity_options', [{ qty: 100, price_krw: 800000 }]),
];

let ws: string;
let ids: { goods: number; ad: number; brokenAd: number; catering: number };

async function approve(status: 'READY' | 'NEEDS_REVIEW', fields: EvaluatedField[], type: 'ad' | 'catering' | 'goods', subtype: string): Promise<number> {
  const draft = await reviewableDraft(ws, status, fields, type, subtype);
  return (await approveDraft({ workspaceId: ws, draftId: draft.draftId, version: draft.version, now: at(0) })).productId;
}

beforeAll(async () => {
  ws = await newWorkspace();
  const pool = getPool();
  // 1. 멀쩡한 굿즈
  const goods = await approve('READY', GOODS_FIELDS, 'goods', '인쇄물');
  await saveProductTexts(pool, goods, fourTexts('Cheering slogan banner', 'A slogan banner from KRW 5,000, minimum order 10.', '应援手幅', '应援手幅，5,000韩元起，最少10。'));
  // 2. 멀쩡한 광고 지면. 다만 영어 제목에 한글이 섞였고, 중국어 요약의 값이 틀렸다.
  const ad = await approve('READY', AD_FIELDS, 'ad', '전광판');
  await saveProductTexts(pool, ad, fourTexts(
    'Hapjeong Station digital billboard 전광판',
    'A digital billboard at Hapjeong Station Exit 4, from KRW 1,500,000 for 7 days.',
    '合井站电子屏',
    '合井站4号出口的电子屏，7天1,900,000韩元起。',
  ));
  // 3. 옵션 0개 + 필수 칸 빔 + 글이 아직 없음
  const brokenAd = await approve('NEEDS_REVIEW', BROKEN_AD_FIELDS, 'ad', '전광판');
  // 4. 케이터링. 승인 뒤에 표를 직접 고쳐 갈래를 틀리게 하고 자리 채움 글자를 넣는다(등록 길로는 못 들어가는 값이다).
  const catering = await approve('READY', CATERING_FIELDS, 'catering', '커피차');
  await pool.query(`UPDATE products SET subtype = '전광판', spec = spec || '{"service_region": "추후 안내"}'::jsonb WHERE id = $1`, [catering]);
  await saveProductTexts(pool, catering, fourTexts('Dalbodeure coffee truck', 'Sure, here is the summary: a coffee truck.', 'Dalbodeure 咖啡车', '咖啡车，100杯800,000韩元起。'));
  ids = { goods, ad, brokenAd, catering };
});

afterAll(async () => {
  await dropWorkspaces();
  await closePool();
});

const codes = (item: AuditItem | undefined) => (item?.findings ?? []).map((f) => `${f.code}@${f.field ?? '-'}`);
const byProduct = (result: AuditResponse, productId: number) => result.items.find((i) => i.productId === productId);

const EXPECTED = () => ({
  [ids.goods]: [],
  [ids.ad]: ['STRAY_NUMBER@summary_zh', 'HANGUL_IN_TEXT@title_en'],
  [ids.brokenAd]: [
    'REQUIRED_MISSING@footfall_per_day', 'EMPTY_REQUIRED_OPTIONS@period_options',
    'EMPTY_TEXT@title_en', 'EMPTY_TEXT@summary_en', 'EMPTY_TEXT@title_zh', 'EMPTY_TEXT@summary_zh',
  ],
  [ids.catering]: ['TYPE_SUBTYPE_MISMATCH@-', 'PLACEHOLDER_VALUE@service_region', 'MONOLOGUE@summary_en'],
});

describe('공간의 상품 전체', () => {
  it('상품마다 넣어 둔 문제만 잡는다. 문제 있는 상품이 먼저 온다', async () => {
    const result = await auditWorkspace(ws);
    expect(AuditResponseSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ source: 'workspace', file: null, truncated: false });
    for (const [id, expected] of Object.entries(EXPECTED())) expect(codes(byProduct(result, Number(id))), `상품 ${id}`).toEqual(expected);
    expect(result.totals).toEqual({ items: 4, itemsWithFindings: 3, findings: 11, bySeverity: { error: 4, warning: 7 } });
    expect(result.items.map((i) => i.productId)).toEqual([ids.ad, ids.brokenAd, ids.catering, ids.goods]);
    expect(result.items[0]).toMatchObject({ key: `product:${ids.ad}`, rowNumber: null, name: '합정역 전광판', type: 'ad', subtype: '전광판' });
    expect(result.byCode[0]?.severity).toBe('error');
    expect(result.byCode.find((c) => c.code === 'EMPTY_TEXT')).toMatchObject({ label: '빈 글', findings: 4, items: 1 });
  });

  it('본체가 "확인 필요"로 저장한 글은 점검에도 나온다. 상품 화면과 점검이 같은 상품을 다르게 말하지 않는다', async () => {
    // 모델 글이 두 번 걸려 틀 문장으로 내려간 중국어 요약. 글자는 틀 문장이라 지금의 글 검사는 통과한다.
    const other = await newWorkspace();
    const draft = await reviewableDraft(other, 'READY', GOODS_FIELDS, 'goods', '인쇄물');
    const productId = (await approveDraft({ workspaceId: other, draftId: draft.draftId, version: draft.version, now: at(0) })).productId;
    const texts = fourTexts('Cheering slogan banner', 'A slogan banner from KRW 5,000, minimum order 10.', '应援手幅', '应援手幅，5,000韩元起，最少10。');
    texts[3] = { ...texts[3]!, source: 'template', status: 'needs_review', failCodes: ['MONOLOGUE', 'GLOSSARY_MISS'] };
    await saveProductTexts(getPool(), productId, texts);

    const result = await auditWorkspace(other);
    expect(AuditResponseSchema.safeParse(result).success).toBe(true);
    expect(codes(byProduct(result, productId))).toEqual(['TEXT_NEEDS_REVIEW@summary_zh']);
    expect(result.totals).toEqual({ items: 1, itemsWithFindings: 1, findings: 1, bySeverity: { error: 0, warning: 1 } });
    expect(byProduct(result, productId)?.findings[0]?.message).toContain('혼잣말 흔적, 용어 표기 다름');
    // 내려받은 파일에는 글의 상태가 실려 있지 않다. 파일 점검은 글자만 보므로 이 문제가 나오지 않는다(화면과 문서에 적어 둔 차이).
    const csv = await exportCsv(other);
    const fromFile = await auditFile({ bytes: new TextEncoder().encode(csv.body), name: 'x.csv' }, other);
    expect(fromFile.totals.findings).toBe(0);
  });

  it('다른 공간의 상품은 섞이지 않는다. 상품이 없는 공간은 빈 결과다', async () => {
    const empty = await auditWorkspace(await newWorkspace());
    expect(empty.totals).toEqual({ items: 0, itemsWithFindings: 0, findings: 0, bySeverity: { error: 0, warning: 0 } });
    expect(empty.items).toEqual([]);
    expect(empty.byCode).toEqual([]);
  });

  it('아무것도 쓰지 않는다', async () => {
    const before = [await count('products'), await count('product_texts'), await count('jobs'), await count('llm_calls')];
    await auditWorkspace(ws);
    expect([await count('products'), await count('product_texts'), await count('jobs'), await count('llm_calls')]).toEqual(before);
  });

  it('지역을 고르는 법이 본체의 글 만들기와 같다', async () => {
    const products = await listProducts(getPool(), ws);
    expect(products).toHaveLength(4);
    for (const p of products) expect(regionOfSubject(productSubject(p, []))).toBe(regionOf(p));
  });
});

describe('양식 꼴 파일', () => {
  it('기본 양식으로 내려받은 CSV 를 다시 읽으면 상품의 값이 그대로 돌아온다', async () => {
    const pool = getPool();
    const products = (await listProducts(pool, ws)).reverse();
    const texts = await listProductTextsByWorkspace(pool, ws);
    const [header, ...rows] = parseCsv(productsCsv(loadExportTemplate(), products, texts));
    const read = readTable({ header: header ?? [], rows, template: loadExportTemplate(), stripFormulaPrefix: true, limit: 500 });
    expect(read.missingHeaders).toEqual([]);
    expect(read.subjects).toHaveLength(products.length);
    products.forEach((product, i) => {
      const want = productSubject(product, texts.get(product.id) ?? []);
      const got = read.subjects[i];
      expect(got).toMatchObject({ productId: product.id, type: want.type, subtype: want.subtype, texts: want.texts, unreadable: [] });
      // 파일에서는 그 종류에 없는 칸도 빈칸("없음")으로 온다. 값이 있는 칸만 견준다.
      const filled = Object.fromEntries(Object.entries(got?.values ?? {}).filter(([key, value]) => value !== null && key in want.values));
      expect(filled).toEqual(Object.fromEntries(Object.entries(want.values).filter(([, value]) => value !== null)));
    });
  });

  it('내려받은 CSV 를 올리면 공간을 직접 살핀 것과 같은 문제가 나온다', async () => {
    const csv = await exportCsv(ws);
    const result = await auditFile({ bytes: new TextEncoder().encode(csv.body), name: 'products-default.csv' }, ws);
    expect(AuditResponseSchema.safeParse(result).success).toBe(true);
    expect(result.file).toEqual({ name: 'products-default.csv', format: 'csv', template: 'default', rows: 4, missingHeaders: [] });
    for (const [id, expected] of Object.entries(EXPECTED())) expect(codes(byProduct(result, Number(id))), `상품 ${id}`).toEqual(expected);
    expect(result.items.every((i) => i.key.startsWith('row:') && i.rowNumber !== null)).toBe(true);
  });

  it('내려받은 XLSX 도 같다. 옵션은 "옵션" 시트에서 이어 읽는다', async () => {
    const xlsx = await exportXlsx(ws, { now: at(0) });
    const result = await auditFile({ bytes: new Uint8Array(xlsx.body), name: 'products.xlsx' }, ws);
    expect(result.file).toMatchObject({ format: 'xlsx', rows: 4 });
    // XLSX 의 "상품" 시트에는 옵션 열이 없다. 그 둘만 "파일에 없던 칸 이름"이다.
    expect(result.file?.missingHeaders).toEqual(['기간옵션', '수량옵션']);
    for (const [id, expected] of Object.entries(EXPECTED())) expect(codes(byProduct(result, Number(id))), `상품 ${id}`).toEqual(expected);
  });

  it('다른 양식(광고 지면만, 나눠 적은 열)으로 내려받은 것도 그 양식 이름을 주면 읽는다', async () => {
    const csv = await exportCsv(ws, { template: 'ad-board' });
    const result = await auditFile({ bytes: new TextEncoder().encode(csv.body), name: null, template: 'ad-board' }, ws);
    // 이 양식에는 요약 글·하루 유동인구 열이 없다. 열이 없는 자리는 살피지 않는다.
    expect(codes(byProduct(result, ids.ad))).toEqual(['HANGUL_IN_TEXT@title_en']);
    expect(codes(byProduct(result, ids.brokenAd))).toEqual(['EMPTY_REQUIRED_OPTIONS@period_options', 'EMPTY_TEXT@title_en', 'EMPTY_TEXT@title_zh']);
    await expect(auditFile({ bytes: new TextEncoder().encode(csv.body), name: null }, ws)).rejects.toMatchObject({ code: 'UNREADABLE_FILE' });
    await expect(auditFile({ bytes: new TextEncoder().encode(csv.body), name: null, template: 'no-such' }, ws)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('큰 파일, 빈 파일, 표가 아닌 파일은 받지 않는다', async () => {
    await expect(auditFile({ bytes: new Uint8Array(AUDIT_LIMITS.fileMaxBytes + 1), name: null }, ws)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(auditFile({ bytes: new Uint8Array(0), name: null }, ws)).rejects.toMatchObject({ code: 'UNREADABLE_FILE' });
    await expect(auditFile({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), name: 'a.jpg' }, ws)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
    // zip 머리만 있고 목차가 없는 파일
    await expect(auditFile({ bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), name: 'a.xlsx' }, ws)).rejects.toMatchObject({ code: 'UNREADABLE_FILE' });
  });

  it('XLSX 를 풀기 전에 목차에 적힌 크기를 더해 본다', async () => {
    const xlsx = await exportXlsx(ws, { now: at(0) });
    const size = zipUnpackedSize(new Uint8Array(xlsx.body));
    expect(size).toBeGreaterThan(xlsx.body.byteLength / 2);
    expect(zipUnpackedSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('POST /api/audits', () => {
  it('JSON 이면 헤더의 공간을 살핀다', async () => {
    const got = await call<AuditResponse>(auditRoute, 'POST', '/api/audits', { ws, body: { source: 'workspace' } });
    expect(got.status).toBe(200);
    expect(got.body.totals.items).toBe(4);
    expect(got.response.headers.get('cache-control')).toBe('no-store');
  });

  it('헤더가 없으면 본보기 공간을 읽는다(읽기 전용이어도 된다)', async () => {
    const got = await call<AuditResponse>(auditRoute, 'POST', '/api/audits', { body: { source: 'workspace' } });
    expect(got.status).toBe(200);
    expect(got.body.source).toBe('workspace');
    expect(got.body.items.every((i) => i.productId !== ids.ad)).toBe(true);
  });

  it('format=csv 면 문제 하나가 한 줄인 CSV 로 내려준다', async () => {
    const got = await call<string>(auditRoute, 'POST', '/api/audits?format=csv', { ws, body: { source: 'workspace' } });
    expect(got.status).toBe(200);
    expect(got.response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(got.response.headers.get('content-disposition')).toContain('chaeum-audit.csv');
    const rows = parseCsv(got.body);
    expect(rows[0]).toEqual([...AUDIT_CSV_COLUMNS]);
    expect(rows).toHaveLength(1 + 11);
    expect(rows.find((r) => r[6] === 'TYPE_SUBTYPE_MISMATCH')).toEqual([
      `product:${ids.catering}`, String(ids.catering), '', '달보드레 커피차', 'catering', 'error', 'TYPE_SUBTYPE_MISMATCH', '종류·갈래 불일치', '',
      '종류·갈래: 케이터링에 없는 갈래입니다("전광판").',
    ]);
  });

  it('파일을 올리면 그 파일을 살핀다', async () => {
    const csv = await exportCsv(ws);
    const form = new FormData();
    form.append('file', new File([csv.body], '내려받은 것.csv'));
    form.append('template', 'default');
    const got = await call<AuditResponse>(auditRoute, 'POST', '/api/audits', { ws, body: form });
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ source: 'file', file: { name: '내려받은 것.csv', format: 'csv', rows: 4 } });
    expect(got.body.totals.findings).toBe(11);
  });

  it('꼴이 틀린 요청', async () => {
    expect((await call(auditRoute, 'POST', '/api/audits', { ws, body: { source: 'file' } })).status).toBe(400);
    expect((await call(auditRoute, 'POST', '/api/audits', { ws, body: { source: 'workspace', extra: 1 } })).status).toBe(400);
    expect((await call(auditRoute, 'POST', '/api/audits?format=pdf', { ws, body: { source: 'workspace' } })).status).toBe(400);
    expect((await call(auditRoute, 'POST', '/api/audits', { ws, body: new FormData() })).status).toBe(400);
    const big = new FormData();
    big.append('file', new File([new Uint8Array(AUDIT_LIMITS.fileMaxBytes + 64 * 1024)], 'big.csv'));
    expect((await call(auditRoute, 'POST', '/api/audits', { ws, body: big })).body).toMatchObject({ code: 'FILE_TOO_LARGE' });
    const notTable = new FormData();
    notTable.append('file', new File(['아무 글이나 적은 파일'], 'memo.txt'));
    expect((await call(auditRoute, 'POST', '/api/audits', { ws, body: notTable })).body).toMatchObject({ code: 'UNREADABLE_FILE' });
  });
});
