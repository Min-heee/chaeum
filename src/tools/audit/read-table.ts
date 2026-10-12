// 양식 꼴의 표(첫 줄이 칸 이름)를 점검할 상품들로 읽는다. 내려받기(양식 맞춤 파일)의 거꾸로다.
// 값은 내려받기가 적은 꼴 그대로만 읽는다. 꼴대로 못 읽은 칸은 값을 비우고 "읽지 못한 칸"으로 남긴다(짐작하지 않는다).
import { CSV_RULES, type ExportFormat, type ExportTemplate } from '@/contract/export-template';
import {
  fieldDef,
  isFieldKey,
  parseFieldValue,
  PRODUCT_TYPES,
  REQUIRED_OPTION_FIELDS,
  TYPE_LABELS,
  type FieldKey,
  type ProductType,
} from '@/contract/fields';
import { AUDIT_FILE_RULES, type AuditSubject } from '@/contract/tools/audit';
import { XLSX_OPTION_COLUMNS, XLSX_OPTION_KINDS } from '@/contract/tools/xlsx';
import { TEXT_SLOTS, type TextSlot } from './subject';

/** 표의 칸 하나. CSV 는 전부 글자이고, XLSX 는 수 칸이 수로 온다. */
export type Cell = string | number | boolean | null;

export interface ReadTableInput {
  /** 첫 줄(칸 이름) */
  header: readonly Cell[];
  /** 그다음 줄들 */
  rows: readonly (readonly Cell[])[];
  template: ExportTemplate;
  /** 수식 막기로 붙은 맨 앞의 ' 를 뗄 것인가. CSV 는 뗀다. XLSX 는 붙이지 않으므로 떼지 않는다. */
  stripFormulaPrefix: boolean;
  /** XLSX 의 "옵션" 시트(첫 줄이 칸 이름). 있으면 상품 시트의 첫 열(상품 열쇠)로 이어 옵션 칸을 채운다. */
  optionSheet?: readonly (readonly Cell[])[] | null;
  /** 이만큼만 상품으로 만든다. 줄 수(rows)는 끝까지 센다. */
  limit: number;
}

export interface ReadTableResult {
  subjects: AuditSubject[];
  /** 이 파일로 살필 수 있는 자리(칸 이름과 글 자리 이름). 열이 없는 자리는 살피지 않는다. */
  covered: Set<string>;
  /** 양식의 칸 이름 가운데 파일에 없던 것 */
  missingHeaders: string[];
  /** 양식의 칸 이름 가운데 파일에 있던 것의 수 */
  matchedHeaders: number;
  /** 빈 줄을 뺀 줄 수(자르기 전) */
  rows: number;
}

type Read = { ok: true; value: unknown } | { ok: false };
const got = (value: unknown): Read => ({ ok: true, value });
const BAD: Read = { ok: false };

const INT = /^-?\d+$/;
const INT_COMMA = /^-?\d{1,3}(?:,\d{3})+$/;
const NUM = '-?\\d+(?:\\.\\d+)?';
const SIZE = new RegExp(`^(${NUM})x(${NUM})$`, 'i');
const HOURS = /^(\d\d:\d\d)~(\d\d:\d\d)(\(\+1\))?$/;

function readInt(text: string): number | null {
  if (INT.test(text)) return Number(text);
  if (INT_COMMA.test(text)) return Number(text.replace(/,/g, ''));
  return null;
}

function readNumber(text: string): number | null {
  return new RegExp(`^${NUM}$`).test(text) ? Number(text) : null;
}

function readBool(text: string): boolean | null {
  const t = text.toLowerCase();
  if (t === 'y' || t === 'true') return true;
  if (t === 'n' || t === 'false') return false;
  return null;
}

/** "7일:1500000;14일:2800000" 또는 "100개:800000". 빈칸은 옵션 0개다(상품의 옵션은 "없음"이 아니라 빈 목록으로 저장된다). */
function readOptions(text: string, unit: '일' | '개', key: 'days' | 'qty'): Read {
  if (text === '') return got([]);
  const out: Record<string, number>[] = [];
  for (const part of text.split(';')) {
    const m = new RegExp(`^(-?\\d+)${unit}:(-?\\d+)$`).exec(part.trim());
    if (!m) return BAD;
    out.push({ [key]: Number(m[1]), price_krw: Number(m[2]) });
  }
  return got(out);
}

type Parts = Partial<Record<ExportFormat, string>>;

/** 한 칸에 적힌 꼴(plain)을 읽는다. 빈칸은 "없음"(null)이다. 옵션 칸만 빈칸이 빈 목록이다. */
function readPlain(key: FieldKey, text: string): Read {
  const kind = fieldDef(key).kind;
  if (kind === 'period_options') return readOptions(text, '일', 'days');
  if (kind === 'quantity_options') return readOptions(text, '개', 'qty');
  if (text === '') return got(null);
  switch (kind) {
    case 'text':
      return got(text);
    case 'money':
    case 'count':
    case 'days':
    case 'footfall': {
      const n = readInt(text);
      return n === null ? BAD : got(n);
    }
    case 'bool': {
      const b = readBool(text);
      return b === null ? BAD : got(b);
    }
    case 'size_m':
    case 'size_mm':
    case 'resolution': {
      const m = SIZE.exec(text);
      return m ? got({ width: Number(m[1]), height: Number(m[2]) }) : BAD;
    }
    case 'hours': {
      const m = HOURS.exec(text);
      return m ? got({ open: m[1], close: m[2], nextDay: m[3] !== undefined }) : BAD;
    }
    case 'formats':
      return got(text.split(';').map((s) => s.trim()).filter((s) => s !== ''));
    default:
      return BAD;
  }
}

/** 한 값을 여러 열로 나눠 적는 서식. 이 열들이 모두 있어야 값을 다시 만들 수 있다. */
const SPLIT_FORMATS = {
  size: ['width', 'height'],
  hours: ['open', 'close', 'next_day'],
} as const satisfies Record<string, readonly ExportFormat[]>;

function splitOf(key: FieldKey): readonly ExportFormat[] | null {
  const kind = fieldDef(key).kind;
  if (kind === 'size_m' || kind === 'size_mm' || kind === 'resolution') return SPLIT_FORMATS.size;
  if (kind === 'hours') return SPLIT_FORMATS.hours;
  return null;
}

/** 이 칸의 열로 볼 수 있는 서식인가. 값의 꼴과 안 맞는 서식은 내려받기가 plain 으로 적으므로 plain 으로 읽는다. */
function effectiveFormat(key: FieldKey, format: ExportFormat): ExportFormat {
  if (format === 'json') return 'json';
  return splitOf(key)?.includes(format) ? format : 'plain';
}

/** 열에 적힌 것들(서식 → 글자)에서 칸 값 하나를 읽는다. 읽을 열이 모자라면 undefined(살필 수 없는 칸). */
function readField(key: FieldKey, parts: Parts): Read | undefined {
  let read: Read;
  if (parts.plain !== undefined) read = readPlain(key, parts.plain);
  else if (parts.json !== undefined) {
    if (parts.json === '') read = got(null);
    else {
      try {
        read = got(JSON.parse(parts.json));
      } catch {
        read = BAD;
      }
    }
  } else {
    const split = splitOf(key);
    if (!split || split.some((f) => parts[f] === undefined)) return undefined;
    const texts = split.map((f) => parts[f] as string);
    if (texts.every((t) => t === '')) read = got(null);
    else if (split === SPLIT_FORMATS.size) {
      const [width, height] = texts.map(readNumber);
      read = width === null || height === null ? BAD : got({ width, height });
    } else {
      const nextDay = readBool(texts[2] as string);
      read = nextDay === null ? BAD : got({ open: texts[0], close: texts[1], nextDay });
    }
  }
  if (!read.ok) return BAD;
  // 읽은 값이 그 칸의 표준 꼴인지 본체의 꼴 검사로 한 번 더 본다("25:00" 같은 시각, 소수인 금액).
  const parsed = parseFieldValue(key, read.value);
  return parsed.ok ? got(parsed.value) : BAD;
}

const LABEL_TO_TYPE = new Map<string, ProductType>(PRODUCT_TYPES.map((t) => [TYPE_LABELS[t], t]));
const isProductType = (value: string): value is ProductType => (PRODUCT_TYPES as readonly string[]).includes(value);
const isTextSlot = (value: string): value is TextSlot => TEXT_SLOTS.some((s) => s.slot === value);

/** "옵션" 시트를 상품 열쇠별로 모은다. 칸 이름이 약속과 다르면 null(옵션 시트가 없는 것으로 본다). */
function optionsByKey(sheet: readonly (readonly Cell[])[] | null | undefined, cell: (c: Cell | undefined) => string) {
  if (!sheet || sheet.length === 0) return null;
  const header = (sheet[0] ?? []).map(cell);
  const [keyAt, , kindAt, daysAt, qtyAt, priceAt] = XLSX_OPTION_COLUMNS.map((name) => header.indexOf(name));
  if ([keyAt, kindAt, daysAt, qtyAt, priceAt].some((at) => at === undefined || at < 0)) return null;
  const out = new Map<string, { kind: string; days: string; qty: string; price: string }[]>();
  for (const row of sheet.slice(1)) {
    const key = cell(row[keyAt as number]);
    if (key === '') continue;
    const list = out.get(key) ?? [];
    list.push({ kind: cell(row[kindAt as number]), days: cell(row[daysAt as number]), qty: cell(row[qtyAt as number]), price: cell(row[priceAt as number]) });
    out.set(key, list);
  }
  return out;
}

export function readTable(input: ReadTableInput): ReadTableResult {
  const prefix = AUDIT_FILE_RULES.skipFormulaPrefix;
  const cell = (c: Cell | undefined): string => {
    if (c === null || c === undefined) return '';
    if (typeof c !== 'string') return String(c);
    const t = c.trim();
    const guarded = input.stripFormulaPrefix && t.startsWith(prefix) && (CSV_RULES.formulaStarts as readonly string[]).includes(t.charAt(prefix.length));
    return guarded ? t.slice(prefix.length) : t;
  };

  // 양식의 열이 파일의 몇째 열인가. 모르는 칸 이름은 보지 않는다.
  const header = input.header.map((h) => (h === null ? '' : String(h).trim()));
  const columns: { from: string; format: ExportFormat; at: number }[] = [];
  const missingHeaders: string[] = [];
  let matchedHeaders = 0;
  for (const column of input.template.columns) {
    const at = header.indexOf(column.header);
    if (at < 0) {
      missingHeaders.push(column.header);
      continue;
    }
    matchedHeaders += 1;
    if ('from' in column) columns.push({ from: column.from, format: column.format ?? 'plain', at });
  }

  const fieldKeys = [...new Set(columns.map((c) => c.from).filter(isFieldKey))];
  const partsOf = (key: FieldKey, row: readonly Cell[]): Parts => {
    const parts: Parts = {};
    for (const c of columns) if (c.from === key) parts[effectiveFormat(key, c.format)] ??= cell(row[c.at]);
    return parts;
  };
  const first = (from: string, row: readonly Cell[]): string | undefined => {
    const column = columns.find((c) => c.from === from && c.format === 'plain');
    return column ? cell(row[column.at]) : undefined;
  };

  const covered = new Set<string>();
  const blankRow: Cell[] = [];
  for (const key of fieldKeys) if (readField(key, partsOf(key, blankRow)) !== undefined) covered.add(key);
  for (const { slot } of TEXT_SLOTS) if (columns.some((c) => c.from === slot)) covered.add(slot);

  // 옵션 칸이 상품 시트에 없으면 "옵션" 시트에서 읽는다.
  const options = optionsByKey(input.optionSheet, cell);
  const fromSheet = (['period_options', 'quantity_options'] as const).filter((key) => options !== null && !covered.has(key));
  for (const key of fromSheet) covered.add(key);

  const subjects: AuditSubject[] = [];
  let rows = 0;
  input.rows.forEach((row, i) => {
    if (row.every((c) => cell(c) === '')) return;
    rows += 1;
    if (subjects.length >= input.limit) return;

    const code = first('type', row);
    const label = first('type_label', row);
    const type = code !== undefined && isProductType(code) ? code : ((label !== undefined ? LABEL_TO_TYPE.get(label) : undefined) ?? null);
    const id = readInt(first('product_id', row) ?? '');

    const values: Record<string, unknown> = {};
    const unreadable: string[] = [];
    for (const key of fieldKeys) {
      const read = readField(key, partsOf(key, row));
      if (read === undefined) continue;
      values[key] = read.ok ? read.value : null;
      if (!read.ok) unreadable.push(key);
    }
    for (const key of fromSheet) {
      // 그 종류의 필수 옵션 칸만 채운다(광고 지면의 기간 옵션, 케이터링의 수량 옵션).
      if (type === null || !REQUIRED_OPTION_FIELDS[type].includes(key)) continue;
      const kind = XLSX_OPTION_KINDS[key];
      const unit = key === 'period_options' ? 'days' : 'qty';
      const mine = (options?.get(cell(row[0])) ?? []).filter((o) => o.kind === kind);
      const list = mine.map((o) => ({ [unit]: readInt(o[unit]), price_krw: readInt(o.price) }));
      const parsed = parseFieldValue(key, list);
      values[key] = parsed.ok ? parsed.value : null;
      if (!parsed.ok) unreadable.push(key);
    }

    const texts: AuditSubject['texts'] = {};
    for (const c of columns) {
      if (!isTextSlot(c.from)) continue;
      const body = cell(row[c.at]);
      if (body !== '') texts[c.from] ??= body;
    }

    subjects.push({
      key: `row:${i + 1}`,
      productId: id !== null && id > 0 ? id : null,
      rowNumber: i + 1,
      type,
      subtype: first('subtype', row) || null,
      values,
      texts,
      unreadable,
    });
  });

  return { subjects, covered, missingHeaders, matchedHeaders, rows };
}
