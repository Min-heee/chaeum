// 점검의 DB·파일 일. 공간의 상품(products + product_texts)이나 올린 파일을 "점검할 상품" 꼴로 맞춰 판단 함수에 넘긴다.
// 판단은 src/tools/audit 의 순수 함수가 한다. 여기서는 읽기만 한다. 아무것도 저장하지 않고 LLM 을 부르지 않는다.
import readXlsxFile from 'read-excel-file/node';
import type { GlossaryEntry, ProductText } from '@/contract/content';
import { DEFAULT_EXPORT_TEMPLATE } from '@/contract/export-template';
import { isFieldKey, REQUIRED_OPTION_FIELDS } from '@/contract/fields';
import {
  AUDIT_CSV_COLUMNS,
  AUDIT_LIMITS,
  type AuditFileFormat,
  type AuditItem,
  type AuditResponse,
  type AuditSubject,
} from '@/contract/tools/audit';
import { XLSX_SHEETS } from '@/contract/tools/xlsx';
import { auditCsvRows, auditSubject, parseCsv, readTable, summarize, TEXT_SLOTS, type AuditOptions, type Cell } from '@/tools/audit';
import { getPool } from './db';
import { AppError } from './errors';
import { loadExportTemplate, toCsv } from './export-csv';
import { approvedGlossary } from './repos/glossary-terms';
import { listProducts, listProductTextsByWorkspace, type Product } from './repos/products';
import type { Db } from './types';

/** 등록된 상품 한 줄을 점검할 꼴로 맞춘다. 공통 칸·규격 칸·옵션 칸을 칸 이름 하나의 표로 모은다. */
export function productSubject(product: Product, texts: readonly ProductText[]): AuditSubject {
  const values: Record<string, unknown> = {
    name: product.name,
    price_krw: product.price_krw,
    list_price_krw: product.list_price_krw,
    vat_included: product.vat_included,
  };
  for (const [key, value] of Object.entries(product.spec)) if (isFieldKey(key)) values[key] = value;
  // 광고 지면의 기간 옵션, 케이터링의 수량 옵션. 굿즈는 옵션 칸이 없다.
  for (const key of REQUIRED_OPTION_FIELDS[product.type]) values[key] = product.options;

  const out: AuditSubject['texts'] = {};
  const stored: NonNullable<AuditSubject['stored']> = {};
  for (const { slot, lang, field } of TEXT_SLOTS) {
    const line = texts.find((t) => t.lang === lang && t.field === field);
    if (!line) continue;
    out[slot] = line.text;
    // 본체가 저장한 상태를 함께 넘긴다. 상품 화면의 "글 확인 필요"와 점검이 같은 말을 하게 하려는 것이다.
    stored[slot] = { source: line.source, status: line.status, failCodes: line.failCodes };
  }
  return { key: `product:${product.id}`, productId: product.id, rowNumber: null, type: product.type, subtype: product.subtype, values, texts: out, unreadable: [], stored };
}

function itemsOf(subjects: readonly AuditSubject[], glossary: readonly GlossaryEntry[], options: AuditOptions = {}): AuditItem[] {
  return subjects.map((subject) => ({
    key: subject.key,
    productId: subject.productId,
    rowNumber: subject.rowNumber,
    name: typeof subject.values.name === 'string' ? subject.values.name : null,
    type: subject.type,
    subtype: subject.subtype,
    findings: auditSubject(subject, glossary, options),
  }));
}

/**
 * 공간에 등록된 상품 전체를 살핀다(오래된 것부터). 글 검사의 용어는 그 공간에서 지금 쓰이는 승인된 용어다.
 * 글자는 지금의 값과 용어로 다시 검사하고, 상품에 저장된 글 상태(글을 만들 때의 결과)도 함께 읽는다:
 * "확인 필요"로 저장된 글(틀 문장으로 내려간 글)은 지금 글자가 검사를 통과해도 "글 확인 필요"로 낸다.
 */
export async function auditWorkspace(workspaceId: string, db: Db = getPool()): Promise<AuditResponse> {
  const products = (await listProducts(db, workspaceId)).reverse();
  const texts = await listProductTextsByWorkspace(db, workspaceId);
  const glossary = await approvedGlossary(db, workspaceId);
  const taken = products.slice(0, AUDIT_LIMITS.maxItems);
  const subjects = taken.map((p) => productSubject(p, texts.get(p.id) ?? []));
  return { source: 'workspace', file: null, ...summarize(itemsOf(subjects, glossary)), truncated: products.length > taken.length };
}

// ── 파일 ───────────────────────────────────────────────────

/** XLSX(zip)를 풀었을 때의 크기 상한. 작은 파일이 풀리면서 터지는 것을 막는다. */
const XLSX_UNPACKED_MAX_BYTES = 20 * 1024 * 1024;

const isZip = (bytes: Uint8Array): boolean => bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

/**
 * zip 의 목차에 적힌 "풀었을 때 크기"를 더한다. 목차를 못 찾으면 null.
 * 목차에 적힌 값을 믿는 것이라 거짓으로 적은 파일까지 막지는 못한다. 풀기 전에 볼 수 있는 것이 이것뿐이다.
 */
export function zipUnpackedSize(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 목차의 끝 표시(PK\5\6)는 파일 끝 쪽에 있다.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return null;
    total += view.getUint32(at + 24, true);
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return total;
}

const toCell = (value: unknown): Cell => (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : String(value));

interface Table {
  format: AuditFileFormat;
  header: Cell[];
  rows: Cell[][];
  optionSheet: Cell[][] | null;
}

/** 파일을 표로 읽는다. 머리 바이트가 zip 이면 XLSX("상품"·"옵션" 시트), 아니면 UTF-8 CSV 로 본다. */
async function readTableFile(bytes: Uint8Array): Promise<Table> {
  if (isZip(bytes)) {
    const unpacked = zipUnpackedSize(bytes);
    if (unpacked === null) throw new AppError('UNREADABLE_FILE', 'XLSX 파일을 읽지 못했습니다.');
    if (unpacked > XLSX_UNPACKED_MAX_BYTES) throw new AppError('FILE_TOO_LARGE', 'XLSX 파일이 풀었을 때 너무 큽니다.');
    let sheets: { sheet: string; data: unknown[][] }[];
    try {
      sheets = await readXlsxFile(Buffer.from(bytes));
    } catch {
      throw new AppError('UNREADABLE_FILE', 'XLSX 파일을 읽지 못했습니다.');
    }
    // "상품" 시트가 없으면 첫 시트를 본다(다른 프로그램에서 다시 저장하며 이름이 바뀐 파일).
    const products = sheets.find((s) => s.sheet === XLSX_SHEETS.products) ?? sheets[0];
    const options = sheets.find((s) => s.sheet === XLSX_SHEETS.options);
    const data = (products?.data ?? []).map((row) => row.map(toCell));
    return { format: 'xlsx', header: data[0] ?? [], rows: data.slice(1), optionSheet: options ? options.data.map((row) => row.map(toCell)) : null };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AppError('UNSUPPORTED_FILE', 'CSV(UTF-8) 또는 XLSX 파일만 살필 수 있습니다.');
  }
  if (text.includes('\u0000')) throw new AppError('UNSUPPORTED_FILE', 'CSV(UTF-8) 또는 XLSX 파일만 살필 수 있습니다.');
  const rows = parseCsv(text);
  return { format: 'csv', header: rows[0] ?? [], rows: rows.slice(1), optionSheet: null };
}

export interface AuditFileInput {
  bytes: Uint8Array;
  /** 올린 파일의 이름. 응답에 그대로 싣는다. */
  name: string | null;
  /** 양식 이름. 없으면 기본 양식. 없는 이름이면 NOT_FOUND. */
  template?: string;
  templateDir?: string;
}

/**
 * 양식 꼴 파일 하나를 살핀다. 글 검사의 용어는 요청한 공간에서 지금 쓰이는 승인된 용어다.
 * 파일에 열이 없는 칸은 살피지 않는다(값이 빈 것인지 알 수 없다). 그 칸 이름은 응답의 file.missingHeaders 에 있다.
 * 큰 파일 FILE_TOO_LARGE, CSV·XLSX 가 아닌 파일 UNSUPPORTED_FILE, 칸 이름 줄이 양식과 하나도 안 맞으면 UNREADABLE_FILE.
 */
export async function auditFile(input: AuditFileInput, workspaceId: string, db: Db = getPool()): Promise<AuditResponse> {
  // 남이 올린 파일이다. 풀거나 읽기 전에 크기부터 본다.
  if (input.bytes.byteLength > AUDIT_LIMITS.fileMaxBytes) throw new AppError('FILE_TOO_LARGE', '파일이 너무 큽니다. 1MB까지 살필 수 있습니다.');
  if (input.bytes.byteLength === 0) throw new AppError('UNREADABLE_FILE', '빈 파일입니다.');
  const template = loadExportTemplate(input.template ?? DEFAULT_EXPORT_TEMPLATE, input.templateDir);
  const table = await readTableFile(input.bytes);
  const read = readTable({
    header: table.header,
    rows: table.rows,
    template,
    stripFormulaPrefix: table.format === 'csv',
    optionSheet: table.optionSheet,
    limit: AUDIT_LIMITS.maxItems,
  });
  if (read.matchedHeaders === 0) {
    throw new AppError('UNREADABLE_FILE', `첫 줄에 "${template.name}" 양식의 칸 이름이 하나도 없습니다. 이 양식으로 내려받은 파일인지 확인해 주세요.`);
  }
  const glossary = await approvedGlossary(db, workspaceId);
  return {
    source: 'file',
    file: { name: input.name, format: table.format, template: template.name, rows: read.rows, missingHeaders: read.missingHeaders },
    ...summarize(itemsOf(read.subjects, glossary, { covered: read.covered })),
    truncated: read.rows > read.subjects.length,
  };
}

/** 점검 결과를 CSV 로 적는다(문제 하나가 한 줄). 쓰는 규칙은 내려받기와 같다. */
export function auditCsv(result: Pick<AuditResponse, 'items'>): { filename: string; body: string } {
  return { filename: 'chaeum-audit.csv', body: toCsv(AUDIT_CSV_COLUMNS, auditCsvRows(result.items)) };
}
