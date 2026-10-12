// XLSX 내려받기. 양식 맞춤 파일(data/export-templates/<이름>.json)을 시트 셋으로 넓힌다.
//   "상품": 한 줄에 상품 하나(첫 열이 상품 열쇠)   "옵션": 한 줄에 기간·수량 옵션 하나   "안내": 읽는 법
// 꼴은 약속(src/contract/tools/xlsx.ts)에 있다. 칸 값을 적는 법은 CSV 내려받기와 같은 함수(cellOf)를 쓴다.
import writeXlsxFile from 'write-excel-file/node';
import type { ProductText } from '@/contract/content';
import { DEFAULT_EXPORT_TEMPLATE, type ExportColumn, type ExportTemplate } from '@/contract/export-template';
import { PeriodOptionSchema, QuantityOptionSchema } from '@/contract/fields';
import { XLSX_KEY_HEADER, XLSX_OPTION_COLUMNS, XLSX_OPTION_KINDS, XLSX_OPTION_SOURCES, XLSX_SHEETS, xlsxFileName } from '@/contract/tools/xlsx';
import { getPool } from './db';
import { cellOf, loadExportTemplate } from './export-csv';
import { listProducts, listProductTextsByWorkspace, type Product } from './repos/products';
import type { Db } from './types';

/** 칸 하나. 수는 수 칸, 글자는 글자 칸, 없으면 빈칸. */
export type XlsxCell = string | number | null;

export interface XlsxSheet {
  name: string;
  /** 첫 줄은 칸 이름이다. */
  rows: XlsxCell[][];
}

const isOptionColumn = (column: ExportColumn): boolean => 'from' in column && (XLSX_OPTION_SOURCES as readonly string[]).includes(column.from);

/**
 * "상품" 시트의 열. 옵션 칸에서 온 열을 빼고, 상품 열쇠를 첫 열로 둔다.
 * 양식에 상품번호(product_id) 열이 있으면 그 열을 앞으로 옮기고, 없으면 열쇠 열을 더한다(같은 칸 이름이 이미 있으면 뒤에 _ 를 붙인다).
 */
export function productSheetColumns(template: ExportTemplate): ExportColumn[] {
  const columns = template.columns.filter((c) => !isOptionColumn(c));
  const keyAt = columns.findIndex((c) => 'from' in c && c.from === 'product_id' && (c.format ?? 'plain') === 'plain');
  if (keyAt >= 0) {
    const [key] = columns.splice(keyAt, 1);
    return [key as ExportColumn, ...columns];
  }
  let header: string = XLSX_KEY_HEADER;
  while (columns.some((c) => c.header === header)) header += '_';
  return [{ header, from: 'product_id' }, ...columns];
}

const blankToNull = (value: string | number): XlsxCell => (value === '' ? null : value);

/** "옵션" 시트의 줄들. 광고 지면은 기간 옵션, 케이터링은 수량 옵션. 꼴이 틀린 옵션은 줄이 되지 않는다. */
export function optionRows(products: readonly Product[]): XlsxCell[][] {
  const rows: XlsxCell[][] = [];
  for (const product of products) {
    if (product.type === 'ad') {
      const options = product.options.flatMap((o) => {
        const parsed = PeriodOptionSchema.safeParse(o);
        return parsed.success ? [parsed.data] : [];
      });
      for (const o of options.sort((a, b) => a.days - b.days)) rows.push([product.id, product.name, XLSX_OPTION_KINDS.period_options, o.days, null, o.price_krw]);
    } else if (product.type === 'catering') {
      const options = product.options.flatMap((o) => {
        const parsed = QuantityOptionSchema.safeParse(o);
        return parsed.success ? [parsed.data] : [];
      });
      for (const o of options.sort((a, b) => a.qty - b.qty)) rows.push([product.id, product.name, XLSX_OPTION_KINDS.quantity_options, null, o.qty, o.price_krw]);
    }
  }
  return rows;
}

/**
 * 시트 셋의 내용을 만든다. 순수 함수다(만든 시각은 인자로 받는다).
 * products 는 적힐 순서 그대로다(부르는 쪽이 오래된 것부터 넘긴다).
 */
export function productsWorkbook(
  template: ExportTemplate,
  products: readonly Product[],
  textsByProduct: ReadonlyMap<number, ProductText[]>,
  generatedAt: Date,
): XlsxSheet[] {
  const columns = productSheetColumns(template);
  const productRows = products.map((p) => columns.map((c) => blankToNull(cellOf(c, p, textsByProduct.get(p.id) ?? []))));
  const options = optionRows(products);
  const keyHeader = columns[0]?.header ?? XLSX_KEY_HEADER;
  const guide: XlsxCell[][] = [
    ['채움 · 응원장터 상품 내려받기'],
    ['가상 마켓의 합성 자료입니다. 실제 서비스의 상품이 아닙니다.'],
    [null],
    ['만든 시각', generatedAt.toISOString()],
    ['양식', template.name],
    ['상품 수', products.length],
    ['옵션 줄 수', options.length],
    [null],
    [`"${XLSX_SHEETS.products}" 시트`, `한 줄에 상품 하나입니다. 첫 열 "${keyHeader}"가 상품 열쇠입니다. 그 종류에 없는 칸은 빈칸입니다.`],
    [`"${XLSX_SHEETS.options}" 시트`, `한 줄에 기간·수량 옵션 하나입니다. "${XLSX_OPTION_COLUMNS[0]}" 열이 "${XLSX_SHEETS.products}" 시트의 첫 열과 같은 값입니다.`],
    ['옵션종류', `${XLSX_OPTION_KINDS.period_options}: 광고 지면의 기간 옵션(일수에 값). ${XLSX_OPTION_KINDS.quantity_options}: 케이터링의 수량 옵션(수량에 값). 굿즈는 옵션 줄이 없습니다.`],
    ['금액', '원 단위입니다. 원문에 적힌 금액 그대로이고 부가세를 더하거나 빼지 않았습니다.'],
  ];
  return [
    { name: XLSX_SHEETS.products, rows: [columns.map((c) => c.header), ...productRows] },
    { name: XLSX_SHEETS.options, rows: [[...XLSX_OPTION_COLUMNS], ...options] },
    { name: XLSX_SHEETS.guide, rows: guide },
  ];
}

/**
 * 글자 칸에 넣을 수 있는 글자로 정리한다. XLSX 의 속은 XML 이라 XML 이 받지 못하는 제어 글자가 하나라도 들면 파일이 열리지 않는다.
 * 그런 글자와 짝 없는 대리 글자는 빼고, CR 은 줄바꿈 하나로 맞춘다(XML 을 읽는 쪽이 어차피 그렇게 읽는다). 탭과 줄바꿈은 둔다.
 */
export function xlsxText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
}

/**
 * 시트 내용을 XLSX 파일 바이트로 쓴다. 첫 줄(칸 이름)은 굵게.
 * 수식 막기: 칸은 수 칸과 글자 칸 둘뿐이고 수식 칸은 쓰지 않는다. "=", "+", "-", "@", 탭, CR 로 시작하는 값도 글자 칸에 들어가므로
 * 표 프로그램이 수식으로 읽지 않는다. 그래서 CSV 처럼 앞에 ' 를 붙이지 않는다(붙이면 값이 달라진다).
 * 수가 아닌 수(NaN, 무한)는 빈칸으로 둔다.
 */
export async function writeWorkbook(sheets: readonly XlsxSheet[]): Promise<Buffer> {
  const data = sheets.map((sheet) => ({
    sheet: sheet.name,
    data: sheet.rows.map((row, r) =>
      row.map((cell) => {
        if (cell === null) return null;
        const bold = r === 0 && sheet.name !== XLSX_SHEETS.guide;
        if (typeof cell === 'number') return Number.isFinite(cell) ? { value: cell, type: Number, ...(bold ? { fontWeight: 'bold' as const } : {}) } : null;
        return { value: xlsxText(cell), type: String, ...(bold ? { fontWeight: 'bold' as const } : {}) };
      }),
    ),
  }));
  return writeXlsxFile(data).toBuffer();
}

export interface ExportedXlsx {
  filename: string;
  body: Buffer;
  /** 상품 수 */
  rows: number;
  /** 옵션 줄 수 */
  optionRows: number;
}

/** 공간의 승인된 상품을 XLSX 로 만든다(오래된 것부터). 없는 양식 이름이면 NOT_FOUND. 다른 공간의 것은 섞이지 않는다. */
export async function exportXlsx(
  workspaceId: string,
  options: { template?: string; templateDir?: string; now: Date },
  db: Db = getPool(),
): Promise<ExportedXlsx> {
  const template = loadExportTemplate(options.template ?? DEFAULT_EXPORT_TEMPLATE, options.templateDir);
  const products = (await listProducts(db, workspaceId)).reverse();
  const texts = await listProductTextsByWorkspace(db, workspaceId);
  const sheets = productsWorkbook(template, products, texts, options.now);
  return {
    filename: xlsxFileName(template.name),
    body: await writeWorkbook(sheets),
    rows: products.length,
    optionRows: (sheets[1]?.rows.length ?? 1) - 1,
  };
}
