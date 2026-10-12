// XLSX 내려받기: 시트 셋, 상품 열쇠로 잇기, 옵션 하나가 한 줄, 수는 수 칸으로.
import readXlsxFile from 'read-excel-file/node';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProductText } from '@/contract/content';
import type { ExportTemplate } from '@/contract/export-template';
import { XLSX_CONTENT_TYPE, XLSX_OPTION_COLUMNS, XLSX_SHEETS } from '@/contract/tools/xlsx';
import { closePool, getPool } from '@/server/db';
import { loadExportTemplate } from '@/server/export-csv';
import { exportXlsx, optionRows, productSheetColumns, productsWorkbook, writeWorkbook, xlsxText } from '@/server/export-xlsx';
import type { Product } from '@/server/repos/products';
import { approveDraft } from '@/server/review';
import { GET as exportXlsxRoute } from '../../app/api/export.xlsx/route';
import { call } from '../api/helpers';
import { at, dropWorkspaces, field, newWorkspace, reviewableDraft } from './helpers';

const product = (over: Partial<Product>): Product => ({
  id: 1, workspaceId: 'w', draftId: 1, type: 'goods', subtype: '인쇄물', name: '응원 슬로건', price_krw: 5000, list_price_krw: null,
  vat_included: true, spec: {}, options: [], createdAt: at(0), ...over,
});

const AD = product({
  id: 7, type: 'ad', subtype: '전광판', name: '합정역 전광판', price_krw: 1500000, vat_included: false,
  spec: { region: '합정역', size_m: { width: 7, height: 12 }, file_format: ['jpg', 'mp4'] },
  options: [{ days: 14, price_krw: 2800000 }, { days: 7, price_krw: 1500000 }],
});
const CATERING = product({
  id: 8, type: 'catering', subtype: '커피차', name: '=커피차 100잔', price_krw: 800000,
  spec: { service_region: '서울 전역' }, options: [{ qty: 100, price_krw: 800000 }, { qty: 'x', price_krw: 1 }],
});
const GOODS = product({ id: 9 });

beforeEach(async () => {
  await getPool().query('TRUNCATE jobs RESTART IDENTITY');
});

afterAll(async () => {
  await dropWorkspaces();
  await closePool();
});

describe('시트의 내용', () => {
  it('"상품" 시트는 옵션 칸을 빼고 상품 열쇠를 첫 열로 둔다', () => {
    const columns = productSheetColumns(loadExportTemplate());
    expect(columns[0]).toEqual({ header: '상품번호', from: 'product_id' });
    expect(columns.map((c) => c.header)).not.toContain('기간옵션');
    expect(columns.map((c) => c.header)).not.toContain('수량옵션');
    expect(columns).toHaveLength(loadExportTemplate().columns.length - 2);
  });

  it('양식에 상품번호 열이 없으면 열쇠 열을 더한다. 같은 칸 이름이 있으면 비켜 적는다', () => {
    const template: ExportTemplate = { name: 't', columns: [{ header: '상품번호', from: 'name' }, { header: '값', from: 'price_krw' }] };
    expect(productSheetColumns(template).map((c) => c.header)).toEqual(['상품번호_', '상품번호', '값']);
    const moved: ExportTemplate = { name: 't', columns: [{ header: '이름', from: 'name' }, { header: 'sku', from: 'product_id' }] };
    expect(productSheetColumns(moved).map((c) => c.header)).toEqual(['sku', '이름']);
  });

  it('"옵션" 시트는 옵션 하나가 한 줄이다. 작은 것부터, 꼴이 틀린 옵션은 빠진다. 굿즈는 줄이 없다', () => {
    expect(optionRows([AD, CATERING, GOODS])).toEqual([
      [7, '합정역 전광판', '기간', 7, null, 1500000],
      [7, '합정역 전광판', '기간', 14, null, 2800000],
      [8, '=커피차 100잔', '수량', null, 100, 800000],
    ]);
  });

  it('시트는 상품 · 옵션 · 안내 순서다. 안내에 만든 시각과 줄 수가 있다', () => {
    const sheets = productsWorkbook(loadExportTemplate(), [AD, CATERING, GOODS], new Map(), at(0));
    expect(sheets.map((s) => s.name)).toEqual([XLSX_SHEETS.products, XLSX_SHEETS.options, XLSX_SHEETS.guide]);
    expect(sheets[0]?.rows).toHaveLength(4);
    expect(sheets[1]?.rows[0]).toEqual([...XLSX_OPTION_COLUMNS]);
    const guide = sheets[2]?.rows ?? [];
    expect(guide).toContainEqual(['만든 시각', at(0).toISOString()]);
    expect(guide).toContainEqual(['상품 수', 3]);
    expect(guide).toContainEqual(['옵션 줄 수', 3]);
  });
});

describe('파일로 쓰고 다시 읽기', () => {
  it('수는 수 칸, 글자는 글자 칸이다. "="로 시작하는 이름도 글자 그대로 남는다', async () => {
    const body = await writeWorkbook(productsWorkbook(loadExportTemplate(), [AD, CATERING, GOODS], new Map(), at(0)));
    // XLSX 는 zip 이다.
    expect([...body.subarray(0, 2)]).toEqual([0x50, 0x4b]);
    const sheets = await readXlsxFile(body);
    expect(sheets.map((s) => s.sheet)).toEqual(['상품', '옵션', '안내']);

    const [header, ...rows] = sheets[0]?.data ?? [];
    const col = (name: string) => (header ?? []).indexOf(name);
    expect(col('상품번호')).toBe(0);
    expect(rows.map((r) => r[0])).toEqual([7, 8, 9]);
    expect(rows[0]?.[col('판매가(원)')]).toBe(1500000);
    expect(rows[0]?.[col('크기(m)')]).toBe('7x12');
    expect(rows[0]?.[col('부가세포함')]).toBe('N');
    expect(rows[1]?.[col('상품명')]).toBe('=커피차 100잔');
    expect(rows[2]?.[col('위치')] ?? null).toBeNull();

    // 옵션 시트의 상품번호는 상품 시트의 첫 열에 있는 값이다.
    const [, ...options] = sheets[1]?.data ?? [];
    expect(options).toHaveLength(3);
    const keys = new Set(rows.map((r) => r[0]));
    for (const option of options) expect(keys.has(option[0] as number)).toBe(true);
    expect(options[1]?.slice(2)).toEqual(['기간', 14, null, 2800000]);
  });

  it('내려받은 파일을 다시 읽으면 세 시트의 모든 칸이 쓴 값과 같다(수는 수, 글자는 글자, 빈칸은 빈칸)', async () => {
    const texts = new Map<number, ProductText[]>([[7, [{ field: 'title', lang: 'en', text: 'Hapjeong Station Billboard', source: 'llm', status: 'ok', failCodes: [] }]]]);
    const hours = { open: '05:00', close: '01:00', nextDay: true };
    const sheets = productsWorkbook(loadExportTemplate(), [{ ...AD, spec: { ...AD.spec, hours } }, CATERING, GOODS], texts, at(0));
    const read = await readXlsxFile(await writeWorkbook(sheets), { trim: false });
    expect(read.map((s) => s.sheet)).toEqual(sheets.map((s) => s.name));
    for (const [i, sheet] of sheets.entries()) {
      const width = Math.max(...sheet.rows.map((r) => r.length));
      const padded = sheet.rows.map((r) => [...r, ...Array.from({ length: width - r.length }, () => null)]);
      expect(read[i]?.data).toEqual(padded);
    }
    // 시간과 날짜는 글자 칸이다(표 프로그램의 날짜 칸으로 바뀌지 않는다).
    const guide = read[2]?.data ?? [];
    expect(guide.find((r) => r[0] === '만든 시각')?.[1]).toBe(at(0).toISOString());
    const [header, first] = read[0]?.data ?? [];
    const hoursCell = first?.[(header ?? []).indexOf('운영시간')];
    expect(typeof hoursCell).toBe('string');
    expect(hoursCell).toContain('05:00');
  });

  it('수식처럼 보이는 값(=, +, -, @, 탭, CR 로 시작)도 글자 칸에 그대로 들어간다. 따옴표를 붙이지 않는다', async () => {
    const risky = ['=1+1', '+82-10', '-3', '@SUM(A1)', '\t=1+1', '=HYPERLINK("http://example.org","x")', '00123', '1e5', 'TRUE', '2026-10-12', '05:00'];
    const body = await writeWorkbook([{ name: '상품', rows: [['값'], ...risky.map((v) => [v])] }]);
    const read = await readXlsxFile(body, { trim: false });
    const cells = (read[0]?.data ?? []).slice(1).map((r) => r[0]);
    expect(cells).toEqual(risky);
    for (const cell of cells) expect(typeof cell).toBe('string');
  });

  it('XML 이 받지 못하는 글자가 섞여도 파일이 열린다. CR 은 줄바꿈 하나가 되고, 수가 아닌 수는 빈칸이다', async () => {
    expect(xlsxText('가\u0000나\u0001다\ud800')).toBe('가나다');
    expect(xlsxText('\r=1+1')).toBe('\n=1+1');
    expect(xlsxText('줄1\r\n줄2\t끝')).toBe('줄1\n줄2\t끝');
    const body = await writeWorkbook([{ name: '상품', rows: [['값', '수'], ['가\u0000나\u000b', Number.NaN], ['\r=1+1', 1.5]] }]);
    const read = await readXlsxFile(body, { trim: false });
    expect(read[0]?.data).toEqual([['값', '수'], ['가나', null], ['\n=1+1', 1.5]]);
  });
});

describe('내려받기', () => {
  it('공간의 승인된 상품만 담긴다. 경로는 XLSX 형식으로 내려준다', async () => {
    const ws = await newWorkspace();
    const other = await newWorkspace();
    const ad = [
      field('name', '합정역 전광판'), field('price_krw', 1500000), field('list_price_krw', null), field('vat_included', false),
      field('region', '합정역'), field('size_m', { width: 7, height: 12 }), field('hours', { open: '05:00', close: '01:00', nextDay: true }),
      field('footfall_per_day', 100000), field('period_options', [{ days: 7, price_krw: 1500000 }, { days: 14, price_krw: 2800000 }]),
    ];
    const mine = await reviewableDraft(ws, 'READY', ad, 'ad', '전광판');
    const { productId } = await approveDraft({ workspaceId: ws, draftId: mine.draftId, version: mine.version, now: at(0) });
    const theirs = await reviewableDraft(other);
    await approveDraft({ workspaceId: other, draftId: theirs.draftId, version: theirs.version, now: at(0) });

    const out = await exportXlsx(ws, { now: at(0) });
    expect(out).toMatchObject({ filename: 'chaeum-products-default.xlsx', rows: 1, optionRows: 2 });

    const got = await call<string>(exportXlsxRoute, 'GET', '/api/export.xlsx', { ws });
    expect(got.status).toBe(200);
    expect(got.response.headers.get('content-type')).toBe(XLSX_CONTENT_TYPE);
    expect(got.response.headers.get('content-disposition')).toContain('chaeum-products-default.xlsx');
    const sheets = await readXlsxFile(Buffer.from(await got.response.arrayBuffer()));
    expect(sheets[0]?.data.slice(1).map((r) => r[0])).toEqual([productId]);
    expect(sheets[1]?.data.slice(1).map((r) => [r[0], r[3], r[5]])).toEqual([[productId, 7, 1500000], [productId, 14, 2800000]]);
  });

  it('없는 양식 이름은 404, 꼴이 틀린 이름은 400', async () => {
    const ws = await newWorkspace();
    expect((await call(exportXlsxRoute, 'GET', '/api/export.xlsx?template=no-such', { ws })).status).toBe(404);
    expect((await call(exportXlsxRoute, 'GET', '/api/export.xlsx?template=../x', { ws })).status).toBe(400);
  });
});
