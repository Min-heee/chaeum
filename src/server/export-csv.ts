// CSV 내려받기. 칸 이름과 순서는 양식 맞춤 파일(data/export-templates/<이름>.json)이 정한다.
// 그 파일만 바꾸면 다른 마켓의 양식 꼴로 나온다. 쓰는 규칙은 약속의 CSV_RULES 다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CORRECTION_COLUMNS, type ExportKind } from '@/contract/api';
import {
  CSV_RULES,
  DEFAULT_EXPORT_TEMPLATE,
  ExportTemplateSchema,
  isExportTemplateName,
  type ExportColumn,
  type ExportFormat,
  type ExportSource,
  type ExportTemplate,
} from '@/contract/export-template';
import type { ProductText } from '@/contract/content';
import { isFieldKey, TYPE_LABELS } from '@/contract/fields';
import defaultTemplateJson from '../../data/export-templates/default.json';
import { getPool } from './db';
import { AppError } from './errors';
import { listCorrections, type Correction } from './repos/draft-events';
import { listProducts, listProductTextsByWorkspace, textStateOf, type Product } from './repos/products';
import type { Db } from './types';

// ── CSV 쓰기 ───────────────────────────────────────────────

/** 칸 하나. 수식으로 읽힐 글자는 앞에 ' 를 붙이고, 쉼표·따옴표·줄바꿈이 있으면 큰따옴표로 감싼다. */
export function csvCell(value: string | number): string {
  let text = String(value);
  const numeric = typeof value === 'number' || /^[+-]?\d+(\.\d+)?$/.test(text);
  // 수로만 된 칸(-5)은 그대로 둔다. 그 밖에 =, +, -, @, 탭, 줄 돌림으로 시작하면 표 프로그램이 수식으로 읽는다.
  if (!numeric && (CSV_RULES.formulaStarts as readonly string[]).includes(text.charAt(0))) text = CSV_RULES.formulaPrefix + text;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 첫 줄은 칸 이름. 맨 앞에 BOM(표 프로그램이 한글을 바로 읽게), 줄 끝은 \r\n. */
export function toCsv(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(','));
  return (CSV_RULES.bom ? '﻿' : '') + lines.join(CSV_RULES.newline) + CSV_RULES.newline;
}

// ── 양식 맞춤 파일 ─────────────────────────────────────────

/** 양식 맞춤 파일이 놓인 폴더. */
export function exportTemplateDir(): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), 'data', 'export-templates');
}

function checked(json: unknown, name: string): ExportTemplate {
  const parsed = ExportTemplateSchema.safeParse(json);
  if (!parsed.success) throw new Error(`양식 맞춤 파일의 꼴이 틀렸다: ${name}.json`);
  if (parsed.data.name !== name) throw new Error(`양식 맞춤 파일의 name 이 파일 이름과 다르다: ${name}.json`);
  return parsed.data as ExportTemplate;
}

/**
 * 이름으로 양식 맞춤 파일을 읽는다. 이름의 꼴이 틀리면 BAD_INPUT, 없는 이름이면 NOT_FOUND.
 * 기본 틀은 빌드에 함께 묶여 있어 폴더를 못 읽는 곳에서도 나온다.
 */
export function loadExportTemplate(name: string = DEFAULT_EXPORT_TEMPLATE, dir: string = exportTemplateDir()): ExportTemplate {
  // 주소의 값을 파일 이름으로 쓰기 전에 꼴을 본다(경로 글자를 막는다).
  if (!isExportTemplateName(name)) throw new AppError('BAD_INPUT', '양식 이름의 꼴이 틀렸습니다.');
  const file = path.join(dir, `${name}.json`);
  if (existsSync(/* turbopackIgnore: true */ file)) return checked(JSON.parse(readFileSync(/* turbopackIgnore: true */ file, 'utf8')), name);
  if (name === DEFAULT_EXPORT_TEMPLATE) return checked(defaultTemplateJson, name);
  throw new AppError('NOT_FOUND', '그런 이름의 양식이 없습니다.');
}

/** 쓸 수 있는 양식의 이름과 설명. */
export function listExportTemplates(dir: string = exportTemplateDir()): { name: string; description: string | null }[] {
  const names = existsSync(/* turbopackIgnore: true */ dir)
    ? readdirSync(/* turbopackIgnore: true */ dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter(isExportTemplateName)
    : [];
  if (!names.includes(DEFAULT_EXPORT_TEMPLATE)) names.push(DEFAULT_EXPORT_TEMPLATE);
  return names.sort().map((name) => ({ name, description: loadExportTemplate(name, dir).description ?? null }));
}

// ── 값 적기 ────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isSize = (v: unknown): v is { width: number; height: number } => isObj(v) && typeof v.width === 'number' && typeof v.height === 'number';
const isHours = (v: unknown): v is { open: string; close: string; nextDay: boolean } =>
  isObj(v) && typeof v.open === 'string' && typeof v.close === 'string' && typeof v.nextDay === 'boolean';

/** 사람이 읽는 꼴. 크기 "7x12", 시간 "05:00~01:00(+1)", 옵션 "7일:1500000;14일:2800000", 형식 "jpg;mp4". */
function plain(value: unknown): string | number {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'Y' : 'N';
  if (isSize(value)) return `${value.width}x${value.height}`;
  if (isHours(value)) return `${value.open}~${value.close}${value.nextDay ? '(+1)' : ''}`;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (isObj(item) && typeof item.days === 'number') return `${item.days}일:${String(item.price_krw)}`;
        if (isObj(item) && typeof item.qty === 'number') return `${item.qty}개:${String(item.price_krw)}`;
        return typeof item === 'string' ? item : JSON.stringify(item);
      })
      .join(';');
  }
  return JSON.stringify(value);
}

/** 값을 서식대로 적는다. 값이 없으면 빈칸. 값의 꼴과 안 맞는 서식이면 plain 으로 적는다. */
export function formatExportValue(value: unknown, format: ExportFormat = 'plain'): string | number {
  if (value === null || value === undefined) return '';
  switch (format) {
    case 'json':
      return JSON.stringify(value);
    case 'yn':
      return typeof value === 'boolean' ? (value ? 'Y' : 'N') : plain(value);
    case 'bool':
      return typeof value === 'boolean' ? String(value) : plain(value);
    case 'comma':
      return typeof value === 'number' ? value.toLocaleString('en-US') : plain(value);
    case 'width':
      return isSize(value) ? value.width : plain(value);
    case 'height':
      return isSize(value) ? value.height : plain(value);
    case 'open':
      return isHours(value) ? value.open : plain(value);
    case 'close':
      return isHours(value) ? value.close : plain(value);
    case 'next_day':
      return isHours(value) ? (value.nextDay ? 'Y' : 'N') : plain(value);
    default:
      return plain(value);
  }
}

// ── 양식 꼴(products) ──────────────────────────────────────

const TEXT_SOURCES: Record<string, { field: ProductText['field']; lang: ProductText['lang'] }> = {
  title_en: { field: 'title', lang: 'en' },
  summary_en: { field: 'summary', lang: 'en' },
  title_zh: { field: 'title', lang: 'zh-Hans' },
  summary_zh: { field: 'summary', lang: 'zh-Hans' },
};

/** 열 하나의 값이 나오는 곳을 상품에서 찾는다. 그 종류에 없는 칸은 null(빈칸). */
function sourceValue(from: ExportSource, product: Product, texts: readonly ProductText[]): unknown {
  switch (from) {
    case 'product_id':
      return product.id;
    case 'draft_id':
      return product.draftId;
    case 'type':
      return product.type;
    case 'type_label':
      return TYPE_LABELS[product.type];
    case 'subtype':
      return product.subtype;
    case 'text_status':
      return texts.length === 0 ? null : textStateOf(texts);
    case 'approved_at':
      return product.createdAt.toISOString();
    case 'name':
      return product.name;
    case 'price_krw':
      return product.price_krw;
    case 'list_price_krw':
      return product.list_price_krw;
    case 'vat_included':
      return product.vat_included;
    case 'period_options':
      return product.type === 'ad' ? product.options : null;
    case 'quantity_options':
      return product.type === 'catering' ? product.options : null;
    default: {
      const text = TEXT_SOURCES[from];
      if (text) return texts.find((t) => t.field === text.field && t.lang === text.lang)?.text ?? null;
      return isFieldKey(from) ? (product.spec[from] ?? null) : null;
    }
  }
}

function cellOf(column: ExportColumn, product: Product, texts: readonly ProductText[]): string | number {
  if ('value' in column) return column.value;
  return formatExportValue(sourceValue(column.from, product, texts), column.format);
}

/** 상품들을 양식 꼴 CSV 글로 만든다. 순수 함수다. */
export function productsCsv(template: ExportTemplate, products: readonly Product[], textsByProduct: ReadonlyMap<number, ProductText[]>): string {
  const rows = products.map((p) => template.columns.map((c) => cellOf(c, p, textsByProduct.get(p.id) ?? [])));
  return toCsv(template.columns.map((c) => c.header), rows);
}

// ── 사람이 고친 값(corrections) ────────────────────────────

const loose = (value: unknown): string => (value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value));

/** 사람이 고친 값 한 번이 한 줄. 열은 약속의 CORRECTION_COLUMNS 그대로다. */
export function correctionsCsv(corrections: readonly Correction[]): string {
  const rows = corrections.map((c) => [c.draftId, c.sourceDocId, c.field, c.raw ?? '', loose(c.before), loose(c.after), c.at.toISOString()]);
  return toCsv(CORRECTION_COLUMNS, rows);
}

// ── 경로 파일이 부르는 것 ──────────────────────────────────

export interface ExportedCsv {
  /** 내려받는 파일 이름 */
  filename: string;
  /** BOM 이 붙은 CSV 글. Content-Type 은 text/csv; charset=utf-8 로 낸다. */
  body: string;
  rows: number;
}

/**
 * 공간의 CSV 를 만든다. 다른 공간의 것은 섞이지 않는다.
 * kind=products: 승인된 상품을 오래된 것부터(template 은 양식 이름. 없는 이름이면 NOT_FOUND).
 * kind=corrections: 사람이 고친 값을 고친 순서대로.
 */
export async function exportCsv(
  workspaceId: string,
  options: { kind?: ExportKind; template?: string; templateDir?: string } = {},
  db: Db = getPool(),
): Promise<ExportedCsv> {
  if ((options.kind ?? 'products') === 'corrections') {
    const corrections = await listCorrections(db, workspaceId);
    return { filename: 'chaeum-corrections.csv', body: correctionsCsv(corrections), rows: corrections.length };
  }
  const template = loadExportTemplate(options.template ?? DEFAULT_EXPORT_TEMPLATE, options.templateDir);
  const products = (await listProducts(db, workspaceId)).reverse();
  const texts = await listProductTextsByWorkspace(db, workspaceId);
  return { filename: `chaeum-products-${template.name}.csv`, body: productsCsv(template, products, texts), rows: products.length };
}
