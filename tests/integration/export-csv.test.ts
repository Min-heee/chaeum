// CSV 내려받기: 따옴표·BOM·수식 막기, 양식 맞춤 파일로 칸 이름과 순서 바꾸기, 사람이 고친 값.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CORRECTION_COLUMNS } from '@/contract/api';
import { ExportTemplateSchema } from '@/contract/export-template';
import { parseCsvRows } from '@/server/bulk-csv';
import { closePool, getPool, withTx } from '@/server/db';
import { editFields } from '@/server/edit-fields';
import { csvCell, exportCsv, formatExportValue, listExportTemplates, loadExportTemplate, toCsv } from '@/server/export-csv';
import { saveProductTexts } from '@/server/repos/products';
import { approveDraft } from '@/server/review';
import { at, dropWorkspaces, field, newWorkspace, reviewableDraft } from './helpers';
import { fakeRouter, goodsText, handlersFor, processed } from './pipeline-helpers';

const pool = () => getPool();
const BOM = '﻿';
const tmp = mkdtempSync(path.join(tmpdir(), 'chaeum-export-'));

/** CSV 글을 줄(칸 목록)로 되읽는다. */
const read = (csv: string) => parseCsvRows(csv);

beforeEach(async () => {
  await pool().query('TRUNCATE jobs RESTART IDENTITY');
});

afterAll(async () => {
  rmSync(tmp, { recursive: true, force: true });
  await dropWorkspaces();
  await closePool();
});

describe('CSV 쓰기', () => {
  it('쉼표·따옴표·줄바꿈이 든 칸은 큰따옴표로 감싸고 안의 따옴표는 두 번 적는다', () => {
    expect(csvCell('그냥 글')).toBe('그냥 글');
    expect(csvCell('1주, 2주')).toBe('"1주, 2주"');
    expect(csvCell('"특가" 전광판')).toBe('"""특가"" 전광판"');
    expect(csvCell('첫 줄\n둘째 줄')).toBe('"첫 줄\n둘째 줄"');
  });

  it('=, +, -, @ 로 시작하는 글자 칸은 앞에 작은따옴표를 붙인다. 수로만 된 칸은 그대로 둔다', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvCell('+82 10 0000 0000')).toBe("'+82 10 0000 0000");
    expect(csvCell('-추후 안내')).toBe("'-추후 안내");
    expect(csvCell('@담당자')).toBe("'@담당자");
    // 탭이나 줄 돌림 뒤에 숨긴 수식도 막는다.
    expect(csvCell("\t=cmd|' /C calc'!A0")).toBe("'\t=cmd|' /C calc'!A0");
    expect(csvCell('\r=1+1')).toBe(`"'\r=1+1"`);
    expect(csvCell('=1+1,"x"')).toBe(`"'=1+1,""x"""`);
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell(1500000)).toBe('1500000');
  });

  it('맨 앞에 BOM 이 있고 줄 끝은 \\r\\n 이다', () => {
    const csv = toCsv(['이름', '값'], [['가', 1], ['나', 2]]);
    expect(csv).toBe(`${BOM}이름,값\r\n가,1\r\n나,2\r\n`);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('값을 서식대로 적는다. 꼴과 안 맞는 서식이면 그냥 적는다', () => {
    const hours = { open: '05:00', close: '01:00', nextDay: true };
    expect(formatExportValue(null)).toBe('');
    expect(formatExportValue(true)).toBe('Y');
    expect(formatExportValue(false, 'bool')).toBe('false');
    expect(formatExportValue({ width: 7, height: 12 })).toBe('7x12');
    expect(formatExportValue({ width: 7, height: 12 }, 'height')).toBe(12);
    expect(formatExportValue(hours)).toBe('05:00~01:00(+1)');
    expect(formatExportValue(hours, 'close')).toBe('01:00');
    expect(formatExportValue(hours, 'next_day')).toBe('Y');
    expect(formatExportValue({ ...hours, nextDay: false }, 'next_day')).toBe('N');
    expect(formatExportValue([{ days: 7, price_krw: 1500000 }, { days: 14, price_krw: 2800000 }])).toBe('7일:1500000;14일:2800000');
    expect(formatExportValue([{ qty: 100, price_krw: 800000 }])).toBe('100개:800000');
    expect(formatExportValue(['jpg', 'mp4'])).toBe('jpg;mp4');
    expect(formatExportValue(1500000, 'comma')).toBe('1,500,000');
    expect(formatExportValue([{ days: 7, price_krw: 1 }], 'json')).toBe('[{"days":7,"price_krw":1}]');
    expect(formatExportValue('글자', 'comma')).toBe('글자');
  });
});

describe('양식 맞춤 파일', () => {
  it('저장소에 든 틀은 약속의 꼴을 지키고 이름이 파일 이름과 같다', () => {
    const names = listExportTemplates().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['default', 'ad-board']));
    for (const name of names) {
      const template = loadExportTemplate(name);
      expect(ExportTemplateSchema.safeParse(template).success).toBe(true);
      expect(template.name).toBe(name);
    }
  });

  it('없는 이름은 404, 꼴이 틀린 이름은 400 이다. 경로 글자는 파일을 읽기 전에 막힌다', () => {
    expect(() => loadExportTemplate('no-such-market')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => loadExportTemplate('../../package')).toThrow(expect.objectContaining({ code: 'BAD_INPUT' }));
    expect(() => loadExportTemplate('Default')).toThrow(expect.objectContaining({ code: 'BAD_INPUT' }));
  });

  it('폴더를 못 읽는 곳에서도 기본 틀은 나온다. 꼴이 틀린 파일은 조용히 쓰지 않는다', () => {
    expect(loadExportTemplate('default', path.join(tmp, '없는-폴더')).columns.length).toBeGreaterThan(10);
    writeFileSync(path.join(tmp, 'broken.json'), JSON.stringify({ name: 'broken', columns: [{ header: '값', from: '없는칸' }] }));
    expect(() => loadExportTemplate('broken', tmp)).toThrow(/꼴이 틀렸다/);
    writeFileSync(path.join(tmp, 'renamed.json'), JSON.stringify({ name: 'other', columns: [{ header: '값', from: 'name' }] }));
    expect(() => loadExportTemplate('renamed', tmp)).toThrow(/파일 이름과 다르다/);
  });
});

describe('내려받기', () => {
  it('승인된 상품이 기본 양식의 한 줄이 된다. 그 종류에 없는 칸은 빈칸이다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    const approved = await approveDraft({ workspaceId: ws, draftId, version, now: at(0) });
    await withTx((c) => saveProductTexts(c, approved.productId, [
      { field: 'title', lang: 'en', text: 'Cheer Slogan', source: 'llm', status: 'ok', failCodes: [] },
      { field: 'summary', lang: 'en', text: 'Reflective slogan, from KRW 5,000.', source: 'llm', status: 'ok', failCodes: [] },
      { field: 'title', lang: 'zh-Hans', text: '应援手幅', source: 'template', status: 'needs_review', failCodes: [] },
      { field: 'summary', lang: 'zh-Hans', text: '反光应援手幅，5,000韩元起。', source: 'template', status: 'needs_review', failCodes: [] },
    ]));

    const out = await exportCsv(ws);
    expect(out).toMatchObject({ filename: 'chaeum-products-default.csv', rows: 1 });
    expect(out.body.startsWith(BOM)).toBe(true);
    const [header, row, ...rest] = read(out.body) as [string[], string[], ...string[][]];
    expect(rest).toEqual([]);
    expect(header).toEqual(loadExportTemplate().columns.map((c) => c.header));
    const cell = (name: string) => row[header.indexOf(name)];
    expect(cell('상품번호')).toBe(String(approved.productId));
    expect(cell('종류')).toBe('굿즈');
    expect(cell('갈래')).toBe('인쇄물');
    expect(cell('상품명')).toBe('응원 슬로건');
    expect(cell('판매가(원)')).toBe('5000');
    expect(cell('정가(원)')).toBe('6000');
    expect(cell('통화')).toBe('KRW');
    expect(cell('부가세포함')).toBe('Y');
    expect(cell('크기(mm)')).toBe('200x600');
    expect(cell('최소주문수량')).toBe('10');
    expect(cell('운영시간')).toBe('');
    expect(cell('기간옵션')).toBe('');
    expect(cell('영문제목')).toBe('Cheer Slogan');
    expect(cell('영문요약')).toBe('Reflective slogan, from KRW 5,000.');
    expect(cell('글상태')).toBe('needs_review');
    expect(cell('승인시각')).toBe(at(0).toISOString());
  });

  it('맞춤 파일을 바꾸면 같은 상품이 다른 칸 이름과 순서로 나온다', async () => {
    const ws = await newWorkspace();
    const ad = [
      field('name', '합정역 전광판'), field('price_krw', 1500000), field('list_price_krw', null), field('vat_included', false),
      field('region', '합정역'), field('size_m', { width: 7, height: 12 }), field('hours', { open: '05:00', close: '01:00', nextDay: true }),
      field('footfall_per_day', 100000), field('period_options', [{ days: 7, price_krw: 1500000 }, { days: 14, price_krw: 2800000 }]),
      field('file_format', ['jpg', 'mp4']),
    ];
    const { draftId, version } = await reviewableDraft(ws, 'READY', ad, 'ad', '전광판');
    const { productId } = await approveDraft({ workspaceId: ws, draftId, version, now: at(0) });

    const board = read((await exportCsv(ws, { template: 'ad-board' })).body);
    expect(board[0]).toEqual(['sku', 'category', 'sub_category', 'title_ko', 'title_en', 'title_zh', 'location', 'width_m', 'height_m', 'open_time', 'close_time', 'close_next_day', 'price', 'currency', 'tax_included', 'period_prices_json', 'file_types']);
    // 번호는 기본 양식과 같은 상품 번호다. 끝 시각이 다음 날이라는 것도 열로 남는다.
    expect(board[1]).toEqual([String(productId), 'ad', '전광판', '합정역 전광판', '', '', '합정역', '7', '12', '05:00', '01:00', 'Y', '1,500,000', 'KRW', 'false', '[{"days":7,"price_krw":1500000},{"days":14,"price_krw":2800000}]', 'jpg;mp4']);

    // 저장소 밖의 새 틀: 파일 하나만 더하면 된다.
    writeFileSync(path.join(tmp, 'tiny.json'), JSON.stringify({ name: 'tiny', columns: [{ header: '값', from: 'price_krw' }, { header: '이름', from: 'name' }, { header: '메모', value: '=확인' }] }));
    const tiny = await exportCsv(ws, { template: 'tiny', templateDir: tmp });
    expect(tiny.body).toBe(`${BOM}값,이름,메모\r\n1500000,합정역 전광판,'=확인\r\n`);
    expect(tiny.filename).toBe('chaeum-products-tiny.csv');
  });

  it('상품은 승인한 순서(오래된 것부터)로 나온다. 케이터링의 수량 옵션은 수량 옵션 칸에만 들어간다', async () => {
    const ws = await newWorkspace();
    const first = await reviewableDraft(ws);
    const a = await approveDraft({ workspaceId: ws, draftId: first.draftId, version: first.version, now: at(0) });
    const catering = [
      field('name', '달무리 커피차'), field('price_krw', 800000), field('service_region', '합정역'),
      field('quantity_options', [{ qty: 100, price_krw: 800000 }, { qty: 200, price_krw: 1500000 }]),
    ];
    const second = await reviewableDraft(ws, 'READY', catering, 'catering', '커피차');
    const b = await approveDraft({ workspaceId: ws, draftId: second.draftId, version: second.version, now: at(1000) });

    const [header, ...rows] = read((await exportCsv(ws)).body) as [string[], ...string[][]];
    const cell = (row: string[] | undefined, name: string) => row?.[header.indexOf(name)];
    expect(rows.map((r) => cell(r, '상품번호'))).toEqual([String(a.productId), String(b.productId)]);
    expect(cell(rows[1], '수량옵션')).toBe('100개:800000;200개:1500000');
    expect(cell(rows[1], '기간옵션')).toBe('');
    expect(cell(rows[0], '수량옵션')).toBe('');
  });

  it('사람이 고친 값이 한 번에 한 줄로 나온다. 승인 전이어도 나온다', async () => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText().text, handlersFor({ router: fakeRouter() }));
    await editFields({ workspaceId: ws, draftId: draft.id, version: 2, edits: { price_krw: 4500, material: '=반사, "원단"' }, now: at(5000) });

    const out = await exportCsv(ws, { kind: 'corrections' });
    expect(out).toMatchObject({ filename: 'chaeum-corrections.csv', rows: 2 });
    const rows = read(out.body);
    expect(rows[0]).toEqual([...CORRECTION_COLUMNS]);
    expect(rows.slice(1)).toEqual(expect.arrayContaining([
      [String(draft.id), String(draft.sourceDocId), 'price_krw', '5,000원', '5000', '4500', at(5000).toISOString()],
      [String(draft.id), String(draft.sourceDocId), 'material', '', '', `'=반사, "원단"`, at(5000).toISOString()],
    ]));
  });

  it('다른 공간의 것은 섞이지 않는다. 상품이 없으면 첫 줄만 나온다', async () => {
    const mine = await newWorkspace();
    const theirs = await newWorkspace();
    const { draftId, version } = await reviewableDraft(theirs);
    await approveDraft({ workspaceId: theirs, draftId, version, now: at(0) });
    const out = await exportCsv(mine);
    expect(out.rows).toBe(0);
    expect(read(out.body)).toHaveLength(1);
    expect((await exportCsv(mine, { kind: 'corrections' })).body).toBe(`${BOM}${CORRECTION_COLUMNS.join(',')}\r\n`);
    await expect(exportCsv(mine, { template: 'no-such-market' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
