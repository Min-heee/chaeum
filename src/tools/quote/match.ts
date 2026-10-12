// 조건에 맞는 상품을 고르고 총액과 마감을 센다. 순수 함수다(시계·DB·네트워크 없음). 오늘은 인자로 받는다.
// 돈 계산과 날짜 계산은 전부 여기서 한다. 모델은 하지 않는다.
// 읽는 것은 본체가 채운 칸 그대로다: 종류·갈래, 위치·출장 지역, 기간·수량 옵션, 판매가, 최소 주문 수량, 마감 일수.
import { PeriodOptionSchema, QuantityOptionSchema } from '@/contract/fields';
import {
  QUOTE_EXCLUDE_REASONS,
  QUOTE_MATCH_REASONS,
  type QuoteCandidate,
  type QuoteConditions,
  type QuoteExcludeReason,
  type QuoteMatchReason,
  type QuoteMatchResult,
  type QuotePricing,
  type QuoteProduct,
} from '@/contract/tools/quote';
import { countableSpec, countDeadlines, diffDays } from '../shared/deadline';

// ── 지역 ───────────────────────────────────────────────────

/** 견줄 때의 꼴. 글자 꼴을 맞추고 소문자로 만든다. */
const norm = (s: string): string => s.normalize('NFKC').toLowerCase();

/** 지역 표현에 붙는 "근처" 같은 말. 지명이 아니므로 떼고 견준다. */
const REGION_FILLERS = /근처|인근|주변|부근|일대|쪽(?=\s|$)|에서|near(?:by)?|around|close to|in the|area|附近|一带|周边|旁边/g;

/** 조건의 지역에서 지명만 남긴다. "홍대 근처" → "홍대". 공백도 뗀다. */
export function regionCore(region: string): string {
  return norm(region).replace(REGION_FILLERS, ' ').replace(/[\s,.·/()]+/g, '');
}

/** 상품의 위치·출장 지역. 광고는 region, 케이터링은 service_region. 굿즈는 지역이 없다(null). */
export function productRegion(product: Pick<QuoteProduct, 'type' | 'spec'>): string | null {
  const value = product.type === 'ad' ? product.spec.region : product.type === 'catering' ? product.spec.service_region : null;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * 지역이 맞는가. 글자의 포함 관계만 본다. 지도를 모른다.
 *  1. 상품의 지역 글에 조건의 지명이 들어 있으면 맞다.            조건 "홍대" ⊂ 상품 "홍대입구역 9번 출구"
 *  2. 조건의 지명에 상품 지역의 낱말(두 글자 이상, 숫자 없는 것)이 들어 있어도 맞다. 조건 "서울역" ⊃ 상품 "서울, 경기 남부"의 "서울"
 *     상품 낱말 끝의 "역"은 떼고도 본다.                           조건 "강남" 과 상품 "강남역"
 * 그래서 못 보는 것이 있다: "서울"이라는 조건은 "합정역"이라고만 적힌 지면과 맞지 않는다(합정이 서울인 줄 모른다).
 * 헛맞음도 있다: 조건 "경기장"은 상품 "경기 남부"의 "경기"와 맞는다. 화면이 맞은 까닭을 보여 주고 사람이 고친다.
 */
export function regionMatches(conditionRegion: string, productRegionText: string): boolean {
  const core = regionCore(conditionRegion);
  if (core === '') return true;
  const hay = norm(productRegionText).replace(/\s+/g, '');
  if (hay.includes(core)) return true;
  const words = norm(productRegionText)
    .split(/[\s,.·/()~∼-]+/)
    .filter((w) => !/\d/.test(w))
    .flatMap((w) => (w.endsWith('역') && w.length > 2 ? [w, w.slice(0, -1)] : [w]))
    .filter((w) => [...w].length >= 2);
  return words.some((w) => core.includes(w));
}

// ── 총액 ───────────────────────────────────────────────────

const usable = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/**
 * 옵션 가운데 하나를 고른다. want 가 없으면 가장 작은 것. 있으면 같은 것, 없으면 그보다 큰 것 가운데 가장 작은 것(exact 거짓).
 * 더 큰 옵션도 없으면 null. 옵션 값을 날 수나 수량으로 나눠 새 값을 지어내지 않는다.
 */
export function pickOption<T extends { size: number; price_krw: number }>(options: readonly T[], want: number | null): { option: T; exact: boolean } | null {
  const sorted = [...options].sort((a, b) => a.size - b.size || a.price_krw - b.price_krw);
  if (sorted.length === 0) return null;
  if (want === null) return { option: sorted[0]!, exact: true };
  const same = sorted.find((o) => o.size === want);
  if (same) return { option: same, exact: true };
  const bigger = sorted.find((o) => o.size > want);
  return bigger ? { option: bigger, exact: false } : null;
}

export type PricingResult = { ok: true; pricing: QuotePricing } | { ok: false; reason: Extract<QuoteExcludeReason, 'no_option' | 'below_min_qty'> };

/**
 * 총액. 광고는 기간 옵션, 케이터링은 수량 옵션, 굿즈는 판매가 × 수량.
 * 금액은 상품에 적힌 그대로다. 부가세를 더하지도 빼지도 않고, 들었는지만 vatIncluded 로 알린다.
 */
export function priceProduct(product: QuoteProduct, want: Pick<QuoteConditions, 'days' | 'qty'>): PricingResult {
  const vatIncluded = product.vat_included;
  if (product.type === 'ad') {
    const options = product.options.flatMap((o) => {
      const parsed = PeriodOptionSchema.safeParse(o);
      return parsed.success && usable(parsed.data.days) && usable(parsed.data.price_krw) ? [{ size: parsed.data.days, price_krw: parsed.data.price_krw }] : [];
    });
    const picked = pickOption(options, want.days);
    if (!picked) return { ok: false, reason: 'no_option' };
    const { size, price_krw } = picked.option;
    return { ok: true, pricing: { basis: 'period_option', days: size, qty: null, unitKrw: price_krw, totalKrw: price_krw, exact: picked.exact, vatIncluded } };
  }
  if (product.type === 'catering') {
    const options = product.options.flatMap((o) => {
      const parsed = QuantityOptionSchema.safeParse(o);
      return parsed.success && usable(parsed.data.qty) && usable(parsed.data.price_krw) ? [{ size: parsed.data.qty, price_krw: parsed.data.price_krw }] : [];
    });
    const picked = pickOption(options, want.qty);
    if (!picked) return { ok: false, reason: 'no_option' };
    const { size, price_krw } = picked.option;
    return { ok: true, pricing: { basis: 'quantity_option', days: null, qty: size, unitKrw: price_krw, totalKrw: price_krw, exact: picked.exact, vatIncluded } };
  }
  // 굿즈: 낱개 값 × 수량. 수량 조건이 없으면 최소 주문 수량(없으면 1)으로 센다.
  const minQty = usable(product.spec.min_order_qty) ? product.spec.min_order_qty : null;
  if (want.qty !== null && minQty !== null && want.qty < minQty) return { ok: false, reason: 'below_min_qty' };
  const qty = want.qty ?? minQty ?? 1;
  const totalKrw = product.price_krw * qty;
  if (!usable(product.price_krw) || !Number.isSafeInteger(totalKrw)) return { ok: false, reason: 'no_option' };
  return { ok: true, pricing: { basis: 'unit_price', days: null, qty, unitKrw: product.price_krw, totalKrw, exact: true, vatIncluded } };
}

// ── 고르기 ─────────────────────────────────────────────────

/**
 * 조건 + 상품 목록 + 오늘 → 맞는 상품(왜 맞는지)과 빠진 상품(왜 빠졌는지). 자르지 않은 전체를 돌려준다.
 * - null 인 조건으로는 거르지 않는다. 조건이 하나도 없으면 값을 낼 수 있는 상품이 모두 맞는 쪽에 온다.
 * - 예산은 총액과 그대로 견준다. 총액이 예산과 같으면 예산 안이고, 1원이라도 넘으면 빠진다.
 *   부가세 별도인 상품도 적힌 총액으로 견준다(세금을 더해 보지 않는다. 화면과 답장이 "부가세 별도"라고 적는다).
 * - 굿즈는 지역이 없어 지역 조건으로 거르지 않는다.
 * - 날짜 조건이 있으면 그 첫날을 기준일로 마감을 센다. 마감 당일은 아직 된다. 하루라도 지났으면 빠진다.
 *   기준일 자체가 오늘보다 앞이어도 빠진다. 상품에 마감 일수가 안 적혀 있으면 그 마감은 세지 않는다(없는 것을 지어내지 않는다).
 *   범위가 오늘을 품은 문의("이번 달")는 조건을 다듬을 때 첫날이 오늘로 당겨져 온다(resolveDateRange).
 *   마감일이 다룰 수 있는 날짜(1900년) 앞으로 나가는 경우는 세지 않는다. 그런 기준일은 어차피 지난 날이라 빠진다.
 * - 순서: 총액이 작은 것부터. 다만 지역 조건이 있으면 지역이 맞은 상품이 지역을 보지 않는 굿즈보다 앞에 온다
 *   (지역을 말한 문의에 지역 없는 상품이 첫 후보가 되지 않게).
 */
export function matchQuote(conditions: QuoteConditions, products: readonly QuoteProduct[], today: string): QuoteMatchResult {
  const candidates: QuoteCandidate[] = [];
  const excluded: QuoteMatchResult['excluded'] = [];

  for (const product of products) {
    const matched = new Set<QuoteMatchReason>();
    const reasons = new Set<QuoteExcludeReason>();
    const region = productRegion(product);

    if (conditions.type !== null) {
      if (product.type === conditions.type) matched.add('type');
      else reasons.add('type_mismatch');
    }
    if (conditions.subtype !== null) {
      if (product.subtype === conditions.subtype) matched.add('subtype');
      else reasons.add('subtype_mismatch');
    }
    if (conditions.region !== null && product.type !== 'goods') {
      if (region !== null && regionMatches(conditions.region, region)) matched.add('region');
      else reasons.add('region_mismatch');
    }

    const priced = priceProduct(product, conditions);
    if (!priced.ok) reasons.add(priced.reason);
    else {
      const wanted = product.type === 'ad' ? conditions.days : conditions.qty;
      if (wanted !== null && priced.pricing.exact) matched.add('option');
      if (conditions.budgetKrw !== null) {
        if (priced.pricing.totalKrw <= conditions.budgetKrw) matched.add('budget');
        else reasons.add('over_budget');
      }
    }

    let schedule: QuoteCandidate['schedule'] = { startDate: null, deadlines: [] };
    if (conditions.dateFrom !== null) {
      const { deadlines } = countDeadlines(product.type, countableSpec(product.type, product.spec, conditions.dateFrom), conditions.dateFrom, today);
      schedule = { startDate: conditions.dateFrom, deadlines };
      const startPassed = diffDays(today, conditions.dateFrom) < 0;
      if (startPassed || deadlines.some((d) => d.status === 'late')) reasons.add('deadline_passed');
      else if (deadlines.length > 0) matched.add('deadline');
    }

    if (reasons.size > 0 || !priced.ok) {
      excluded.push({ productId: product.id, name: product.name, reasons: QUOTE_EXCLUDE_REASONS.filter((r) => reasons.has(r)) });
      continue;
    }
    candidates.push({
      productId: product.id,
      name: product.name,
      type: product.type,
      subtype: product.subtype,
      region,
      matched: QUOTE_MATCH_REASONS.filter((r) => matched.has(r)),
      pricing: priced.pricing,
      schedule,
    });
  }

  // 지역 조건이 있을 때만: 지역이 맞은 것 먼저.
  const regionRank = (c: QuoteCandidate) => (conditions.region !== null && !c.matched.includes('region') ? 1 : 0);
  candidates.sort((a, b) => regionRank(a) - regionRank(b) || a.pricing.totalKrw - b.pricing.totalKrw || a.productId - b.productId);
  excluded.sort((a, b) => a.productId - b.productId);
  return { candidates, excluded };
}

/**
 * 무엇을 찾는지 알 수 있는 조건이 있는가. 종류·갈래·지역이 모두 없으면(예산이나 날짜만 있거나 아무것도 없으면) 없다.
 * 없으면 상품을 대신 골라 주지 않는다. 맞는 상품 목록은 그대로 보여 주고, 답장은 무엇을 찾는지 되묻는 글이 된다.
 */
export function hasSearchCondition(conditions: QuoteConditions): boolean {
  return conditions.type !== null || conditions.subtype !== null || conditions.region !== null;
}
