// 묶음을 다루는 판단: 거르기, 차례 매기기, 경고, 나란히 놓기. 순수 함수다.
import { PRODUCT_TYPES, type ProductType } from '@/contract/fields';
import {
  COMPARE_FACTS,
  COMPARE_METRIC_DEFS,
  COMPARE_RANK_GROUPS,
  compareMetricDef,
  type CompareBasis,
  type CompareBestWithheld,
  type CompareFact,
  type CompareMetric,
  type CompareProduct,
  type CompareQuery,
  type CompareRankGroup,
  type CompareResponse,
  type CompareRow,
  type CompareSide,
  type CompareWarning,
} from '@/contract/tools/compare';
import { compareRow, regionOf } from './metrics';

// ── 거르기 ─────────────────────────────────────────────────

/** 견줄 때의 꼴: 글자 꼴을 맞추고 소문자로, 빈칸은 뗀다. */
const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/**
 * 종류·갈래·지역 글자로 거른다. 안 준 조건으로는 거르지 않는다.
 * 지역은 상품의 위치(출장 지역) 글에 그 글자가 들어 있는지만 본다(빈칸과 대소문자는 무시). 지도를 모른다.
 * 굿즈는 지역 칸이 없어 지역으로 거르면 빠진다.
 */
export function filterProducts<P extends Pick<CompareProduct, 'type' | 'subtype' | 'spec'>>(
  products: readonly P[],
  filter: { type?: ProductType | null; subtype?: string | null; region?: string | null },
): P[] {
  const needle = filter.region ? norm(filter.region) : '';
  return products.filter((p) => {
    if (filter.type && p.type !== filter.type) return false;
    if (filter.subtype && p.subtype !== filter.subtype) return false;
    if (needle !== '') {
      const region = regionOf(p);
      if (region === null || !norm(region).includes(needle)) return false;
    }
    return true;
  });
}

// ── 부가세 ─────────────────────────────────────────────────

const vatGroupOf = (row: Pick<CompareRow, 'vatIncluded'>): CompareRankGroup => (row.vatIncluded === true ? 'vat_included' : row.vatIncluded === false ? 'vat_excluded' : 'vat_unknown');

/** 부가세 포함·별도·모름이 둘 이상 섞였는가. 모름도 다른 것으로 친다(같다고 짐작하지 않는다). */
export function vatMixed(rows: readonly Pick<CompareRow, 'vatIncluded'>[]): boolean {
  return new Set(rows.map(vatGroupOf)).size > 1;
}

// ── 차례 매기기 ─────────────────────────────────────────────

/** 순서를 안 줬을 때: 작을수록 좋은 잣대는 작은 것부터, 클수록 좋은 잣대는 큰 것부터. 방향이 없으면 작은 것부터. */
export function defaultOrder(metric: CompareMetric): 'asc' | 'desc' {
  return compareMetricDef(metric).better === 'higher' ? 'desc' : 'asc';
}

/**
 * 잣대 하나로 차례를 매긴다.
 * - 값이 없는 것은 맨 뒤(번호순)이고 차례가 없다(rank null).
 * - 같은 값은 같은 차례다(다음 차례는 그만큼 건너뛴다: 1, 1, 3). 놓는 순서는 번호가 작은 것이 앞이다.
 * - 돈 잣대인데 값이 있는 줄의 부가세가 섞였으면 합쳐 견주지 않는다: 별도끼리, 포함끼리, 모름끼리 묶어 그 안에서만 차례를 매긴다(split 참).
 *   묶음은 별도 → 포함 → 모름 순으로 놓는다. 부가세를 더하거나 빼서 맞추지 않는다. 값이 없는 줄의 부가세는 보지 않는다.
 * - 종류마다 뜻이 다른 잣대(판매가)인데 값이 있는 줄의 종류가 섞였으면 종류끼리 묶어 그 안에서만 차례를 매긴다(byType 참).
 *   광고의 기간 옵션 값, 케이터링의 수량 옵션 값, 굿즈의 낱개 값을 한 줄로 세우지 않는다.
 */
export function rankRows(
  rows: readonly CompareRow[],
  metric: CompareMetric,
  order: 'asc' | 'desc' = defaultOrder(metric),
): { rows: CompareRow[]; split: boolean; byType: boolean } {
  const def = compareMetricDef(metric);
  const valued = rows.filter((r) => r.values[metric].value !== null);
  const empty = rows.filter((r) => r.values[metric].value === null);
  const split = def.money && vatMixed(valued);
  const byType = def.betterOnlyFor !== undefined && typesIn(valued).length > 1;
  const sign = order === 'asc' ? 1 : -1;
  const groupIndex = (row: CompareRow) =>
    (byType ? PRODUCT_TYPES.indexOf(row.type) : 0) * COMPARE_RANK_GROUPS.length + (split ? COMPARE_RANK_GROUPS.indexOf(vatGroupOf(row)) : 0);
  const valueOf = (row: CompareRow) => row.values[metric].value as number;

  valued.sort((a, b) => groupIndex(a) - groupIndex(b) || sign * (valueOf(a) - valueOf(b)) || a.productId - b.productId);
  empty.sort((a, b) => a.productId - b.productId);

  const seen = new Map<number, { count: number; value: number; rank: number }>();
  const ranked = valued.map((row): CompareRow => {
    const g = groupIndex(row);
    const before = seen.get(g);
    const count = (before?.count ?? 0) + 1;
    const rank = before && before.value === valueOf(row) ? before.rank : count;
    seen.set(g, { count, value: valueOf(row), rank });
    return { ...row, rank, rankType: byType ? row.type : null, rankGroup: split ? vatGroupOf(row) : null };
  });
  return { rows: [...ranked, ...empty.map((row): CompareRow => ({ ...row, rank: null, rankType: null, rankGroup: null }))], split, byType };
}

// ── 묶음의 경고 ─────────────────────────────────────────────

/** 묶음에 있는 종류(정한 순서대로). */
export function typesIn(rows: readonly Pick<CompareRow, 'type'>[]): ProductType[] {
  return PRODUCT_TYPES.filter((t) => rows.some((r) => r.type === t));
}

/**
 * 묶음의 경고.
 * - vat_mixed: 부가세 포함·별도·모름이 섞였다. 이 묶음에 있는 돈 잣대를 함께 낸다(합쳐 견주지 않는 칸).
 * - mixed_types: 종류가 섞였다. 어떤 종류에는 없어서 묶음 전체로는 견줄 수 없는 잣대를 함께 낸다.
 */
export function groupWarnings(rows: readonly CompareRow[]): CompareWarning[] {
  const warnings: CompareWarning[] = [];
  const types = typesIn(rows);
  const present = COMPARE_METRIC_DEFS.filter((d) => d.types.some((t) => types.includes(t)));
  if (vatMixed(rows)) {
    warnings.push({
      code: 'vat_mixed',
      included: rows.filter((r) => r.vatIncluded === true).length,
      excluded: rows.filter((r) => r.vatIncluded === false).length,
      unknown: rows.filter((r) => r.vatIncluded === null).length,
      metrics: present.filter((d) => d.money).map((d) => d.key),
    });
  }
  if (types.length > 1) {
    warnings.push({ code: 'mixed_types', types, metrics: present.filter((d) => !types.every((t) => d.types.includes(t))).map((d) => d.key) });
  }
  return warnings;
}

// ── 나란히 놓기 ─────────────────────────────────────────────

const factText = (row: CompareRow, fact: CompareFact): string => {
  if (fact === 'type') return row.type;
  if (fact === 'subtype') return row.subtype;
  if (fact === 'region') return row.region ?? '';
  return vatGroupOf(row);
};

/** 옵션에서 나눈 값이면 그 옵션의 일수(수량). 옵션에서 나눈 값이 아니면 null. */
function basisSize(basis: CompareBasis | null): number | null {
  if (basis?.kind === 'period_option' || basis?.kind === 'per_footfall') return basis.days;
  if (basis?.kind === 'quantity_option') return basis.qty;
  return null;
}

/** 값이 있는 칸 가운데 가장 좋은 쪽. 표시할 수 없으면 까닭을 낸다. */
function bestOf(rows: readonly CompareRow[], metric: CompareMetric): { best: number[]; bestWithheld: CompareBestWithheld | null } {
  const def = compareMetricDef(metric);
  const withheld = (bestWithheld: CompareBestWithheld) => ({ best: [], bestWithheld });
  const valued = rows.filter((r) => r.values[metric].value !== null);
  if (def.better === null) return withheld('no_direction');
  if (valued.length < 2) return withheld('too_few');
  const types = typesIn(valued);
  if (types.length > 1) return withheld('mixed_types');
  if (def.betterOnlyFor && !def.betterOnlyFor.includes(types[0] as ProductType)) return withheld('no_direction');
  // 돈 잣대는 부가세가 모두 같고, 모름이 없어야 견준다.
  if (def.money && (vatMixed(valued) || valued.some((r) => r.vatIncluded === null))) return withheld('vat_mixed');
  const numbers = valued.map((r) => r.values[metric].value as number);
  const top = def.better === 'lower' ? Math.min(...numbers) : Math.max(...numbers);
  if (numbers.every((n) => n === top)) return withheld('all_same');
  // 옵션에서 나눈 값은 그 옵션의 기간(수량)이 모두 같아야 견준다. 30일 옵션의 하루당 값과 7일 옵션의 하루당 값은 같은 것이 아니다.
  const sizes = valued.map((r) => basisSize(r.values[metric].basis));
  if (new Set(sizes).size > 1) return withheld('mixed_basis');
  return { best: valued.filter((r) => r.values[metric].value === top).map((r) => r.productId), bestWithheld: null };
}

/**
 * 고른 상품(2~4개)을 나란히 놓는다. 받은 차례 그대로다.
 * - 잣대는 고른 상품의 종류 가운데 하나에라도 있는 것만 낸다.
 * - differs: 칸의 값이 서로 다른가. 값과 없음이 섞여도 다르다. 모두 없음이면 같다(없는 까닭이 달라도).
 * - best: "작을수록(클수록) 좋다"가 분명한 잣대에만, 종류가 같고 (돈이면) 부가세가 같고 (옵션에서 나눈 값이면) 그 옵션의 기간·수량이 같을 때만 붙인다.
 */
export function sideBySide(rows: readonly CompareRow[]): CompareSide {
  const types = typesIn(rows);
  const metrics = COMPARE_METRIC_DEFS.filter((d) => d.types.some((t) => types.includes(t))).map((d) => {
    const cells = rows.map((r) => r.values[d.key].value);
    return { metric: d.key, differs: new Set(cells).size > 1, ...bestOf(rows, d.key) };
  });
  const facts = COMPARE_FACTS.map((fact) => ({ fact, differs: new Set(rows.map((r) => factText(r, fact))).size > 1 }));
  return {
    productIds: rows.map((r) => r.productId),
    rows: rows.map((r) => ({ ...r, rank: null, rankType: null, rankGroup: null })),
    facts,
    metrics,
    warnings: groupWarnings(rows),
  };
}

// ── 한 번에 ────────────────────────────────────────────────

/**
 * 공간의 상품 목록과 주소 값으로 응답을 만든다.
 * ids 에 이 목록에 없는 번호가 있으면 missingIds 로 돌려준다(부르는 쪽이 404 로 답한다). 남의 공간 상품은 목록에 없으니 없는 번호와 같다.
 */
export function buildCompare(products: readonly CompareProduct[], query: CompareQuery): { ok: true; response: CompareResponse } | { ok: false; missingIds: number[] } {
  let side: CompareSide | null = null;
  if (query.ids) {
    const byId = new Map(products.map((p) => [p.id, p]));
    const missingIds = query.ids.filter((id) => !byId.has(id));
    if (missingIds.length > 0) return { ok: false, missingIds };
    side = sideBySide(query.ids.map((id) => compareRow(byId.get(id) as CompareProduct)));
  }

  const filter = { type: query.type ?? null, subtype: query.subtype ?? null, region: query.region ?? null };
  const listed = filterProducts(products, filter)
    .map(compareRow)
    .sort((a, b) => a.productId - b.productId);
  const order = query.sort ? (query.order ?? defaultOrder(query.sort)) : null;
  const ranked = query.sort && order ? rankRows(listed, query.sort, order) : null;
  return {
    ok: true,
    response: {
      total: products.length,
      filter,
      sort: query.sort && order && ranked ? { metric: query.sort, order, split: ranked.split, byType: ranked.byType } : null,
      rows: ranked ? ranked.rows : listed,
      warnings: groupWarnings(listed),
      side,
    },
  };
}
