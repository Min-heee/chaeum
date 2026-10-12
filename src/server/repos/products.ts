// 확정 상품. 초안은 느슨하게, 확정은 엄격하게.
// 넣기 전에 코드가 꼴을 보고(zod), 그래도 놓친 것은 표의 제약이 막는다.
import { z } from 'zod';
import type { EvaluatedField } from '@/contract/core-api';
import type { ProductText } from '@/contract/content';
import {
  COMMON_FIELD_KEYS,
  FIELD_SCHEMAS,
  FIELDS_BY_TYPE,
  isSubtypeOf,
  PeriodOptionSchema,
  PRODUCT_TYPES,
  QuantityOptionSchema,
  type DocType,
  type FieldKey,
  type ProductType,
} from '@/contract/fields';
import { toId, type Db } from '../types';

/** 상품으로 넣을 수 없는 초안. issues 에 까닭이 사람 말로 들어 있다. */
export class ProductInvalid extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join(' '));
    this.name = 'ProductInvalid';
    this.issues = issues;
  }
}

export interface ProductDraft {
  type: ProductType;
  subtype: string;
  name: string;
  price_krw: number;
  list_price_krw: number | null;
  vat_included: boolean | null;
  /** 종류별 규격(공통 칸과 옵션 칸을 뺀 나머지). 값이 있는 칸만. */
  spec: Record<string, unknown>;
  /** 광고 지면은 기간 옵션, 케이터링은 수량 옵션, 굿즈는 빈 목록 */
  options: unknown[];
}

const OPTION_FIELD: Record<ProductType, FieldKey | null> = { ad: 'period_options', catering: 'quantity_options', goods: null };

const BaseSchema = z.object({
  type: z.enum(PRODUCT_TYPES),
  subtype: z.string().min(1),
  name: z.string().min(2),
  price_krw: z.number().int().positive(),
  list_price_krw: z.number().int().positive().nullable(),
  vat_included: z.boolean().nullable(),
});

/** 종류별 규격 칸의 이름들. */
export function specKeysOf(type: ProductType): FieldKey[] {
  return FIELDS_BY_TYPE[type].filter((k) => !COMMON_FIELD_KEYS.includes(k) && k !== OPTION_FIELD[type]);
}

/**
 * 초안의 최종 값으로 상품 한 줄을 만든다. 넣을 수 없으면 ProductInvalid.
 * 보는 것: 종류·갈래, 이름 2자 이상, 판매가 > 0, 정가 >= 판매가, 규격과 옵션의 꼴.
 */
export function buildProduct(type: DocType | null, subtype: string | null, fields: readonly EvaluatedField[]): ProductDraft {
  const issues: string[] = [];
  if (type === null || type === 'not_product') throw new ProductInvalid(['상품 종류가 정해지지 않았습니다.']);
  if (subtype === null || !isSubtypeOf(type, subtype)) issues.push('종류와 갈래가 맞지 않습니다.');

  const valueOf = (key: FieldKey) => fields.find((f) => f.field === key)?.finalValue ?? null;
  const base = BaseSchema.safeParse({
    type,
    subtype: subtype ?? '',
    name: typeof valueOf('name') === 'string' ? (valueOf('name') as string).trim() : valueOf('name'),
    price_krw: valueOf('price_krw'),
    list_price_krw: valueOf('list_price_krw'),
    vat_included: valueOf('vat_included'),
  });
  if (!base.success) {
    const labels: Record<string, string> = {
      subtype: '갈래가 비었습니다.',
      name: '상품 이름은 2자 이상이어야 합니다.',
      price_krw: '판매가는 0보다 큰 정수여야 합니다.',
      list_price_krw: '정가는 0보다 큰 정수여야 합니다.',
      vat_included: '부가세 포함 여부의 꼴이 틀렸습니다.',
    };
    for (const issue of base.error.issues) issues.push(labels[String(issue.path[0])] ?? '값의 꼴이 틀렸습니다.');
    throw new ProductInvalid([...new Set(issues)]);
  }
  const p = base.data;
  if (p.list_price_krw !== null && p.list_price_krw < p.price_krw) issues.push('정가가 판매가보다 작습니다.');

  const spec: Record<string, unknown> = {};
  for (const key of specKeysOf(p.type)) {
    const value = valueOf(key);
    if (value === null) continue;
    if (FIELD_SCHEMAS[key].safeParse(value).success) spec[key] = value;
    else issues.push(`규격 칸의 꼴이 틀렸습니다: ${key}`);
  }

  let options: unknown[] = [];
  const optionField = OPTION_FIELD[p.type];
  if (optionField) {
    const schema = z.array(p.type === 'ad' ? PeriodOptionSchema : QuantityOptionSchema);
    const parsed = schema.safeParse(valueOf(optionField) ?? []);
    if (parsed.success) options = parsed.data;
    else issues.push('옵션의 꼴이 틀렸습니다.');
  }

  if (issues.length > 0) throw new ProductInvalid(issues);
  return { ...p, spec, options };
}

/** 상품 한 줄을 넣는다. 제약에 걸리면 PostgreSQL 오류(23xxx)가 그대로 나간다. 부르는 쪽 트랜잭션이 통째로 되돌아간다. */
export async function insertProduct(db: Db, workspaceId: string, draftId: number, p: ProductDraft, now: Date): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO products (workspace_id, draft_id, type, subtype, name, price_krw, list_price_krw, vat_included, spec, options, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11) RETURNING id`,
    [workspaceId, draftId, p.type, p.subtype, p.name, p.price_krw, p.list_price_krw, p.vat_included, JSON.stringify(p.spec), JSON.stringify(p.options), now],
  );
  const row = rows[0];
  if (!row) throw new Error('상품을 넣지 못했다');
  return toId(row.id);
}

export interface Product extends ProductDraft {
  id: number;
  workspaceId: string;
  draftId: number;
  createdAt: Date;
}

interface ProductRow {
  id: string;
  workspace_id: string;
  draft_id: string;
  type: ProductType;
  subtype: string;
  name: string;
  price_krw: string;
  list_price_krw: string | null;
  vat_included: boolean | null;
  spec: Record<string, unknown>;
  options: unknown[];
  created_at: Date;
}

const toProduct = (r: ProductRow): Product => ({
  id: toId(r.id),
  workspaceId: r.workspace_id,
  draftId: toId(r.draft_id),
  type: r.type,
  subtype: r.subtype,
  name: r.name,
  price_krw: Number(r.price_krw),
  list_price_krw: r.list_price_krw === null ? null : Number(r.list_price_krw),
  vat_included: r.vat_included,
  spec: r.spec,
  options: r.options,
  createdAt: r.created_at,
});

export async function getProduct(db: Db, workspaceId: string, productId: number): Promise<Product | null> {
  const { rows } = await db.query<ProductRow>('SELECT * FROM products WHERE id = $1 AND workspace_id = $2', [productId, workspaceId]);
  return rows[0] ? toProduct(rows[0]) : null;
}

/** 번호만으로 찾는다. 글 만들기 처리기가 쓴다. */
export async function getProductById(db: Db, productId: number): Promise<Product | null> {
  const { rows } = await db.query<ProductRow>('SELECT * FROM products WHERE id = $1', [productId]);
  return rows[0] ? toProduct(rows[0]) : null;
}

export async function listProducts(db: Db, workspaceId: string): Promise<Product[]> {
  const { rows } = await db.query<ProductRow>('SELECT * FROM products WHERE workspace_id = $1 ORDER BY id DESC', [workspaceId]);
  return rows.map(toProduct);
}

// ── 언어별 글 ──────────────────────────────────────────────

/** 글을 쓴다. (상품, 칸, 언어)가 같으면 덮어쓴다. 그래서 글 작업이 두 번 돌아도 한 줄만 남는다. */
export async function saveProductTexts(db: Db, productId: number, texts: readonly ProductText[]): Promise<void> {
  for (const t of texts) {
    await db.query(
      `INSERT INTO product_texts (product_id, field, lang, text, source, status, fail_codes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (product_id, field, lang) DO UPDATE
         SET text = EXCLUDED.text, source = EXCLUDED.source, status = EXCLUDED.status, fail_codes = EXCLUDED.fail_codes`,
      [productId, t.field, t.lang, t.text, t.source, t.status, t.failCodes],
    );
  }
}

export async function listProductTexts(db: Db, productId: number): Promise<ProductText[]> {
  const { rows } = await db.query<{ field: ProductText['field']; lang: ProductText['lang']; text: string; source: ProductText['source']; status: ProductText['status']; fail_codes: ProductText['failCodes'] }>(
    'SELECT field, lang, text, source, status, fail_codes FROM product_texts WHERE product_id = $1 ORDER BY lang, field DESC',
    [productId],
  );
  return rows.map((r) => ({ field: r.field, lang: r.lang, text: r.text, source: r.source, status: r.status, failCodes: r.fail_codes }));
}
