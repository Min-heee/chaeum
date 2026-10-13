// 화면에서 고른 값 → 경로에 보낼 주소. 순수 함수다.
import { SUBTYPES, type ProductType } from '@/contract/fields';
import { COMPARE_LIMITS, metricsOfType, type CompareMetric } from '@/contract/tools/compare';
import { defaultOrder, typesIn } from './group';

export interface CompareChoice {
  type: ProductType | null;
  subtype: string | null;
  /** 지역 글자. 빈 글자면 거르지 않는다. */
  region: string;
  sort: { metric: CompareMetric; order: 'asc' | 'desc' } | null;
  /** 나란히 놓을 상품 번호. 2~4개가 아니면 보내지 않는다. */
  ids: readonly number[];
}

/** 고른 값으로 주소를 만든다. 갈래가 고른 종류의 것이 아니면 갈래를 보내지 않는다(종류를 바꾼 직후). */
export function comparePath(choice: CompareChoice): string {
  const params = new URLSearchParams();
  if (choice.type) params.set('type', choice.type);
  const subtypeFits = choice.subtype !== null && (choice.type === null || (SUBTYPES[choice.type] as readonly string[]).includes(choice.subtype));
  if (subtypeFits && choice.subtype) params.set('subtype', choice.subtype);
  const region = choice.region.trim().slice(0, COMPARE_LIMITS.regionMaxChars);
  if (region !== '') params.set('region', region);
  if (choice.sort) {
    params.set('sort', choice.sort.metric);
    params.set('order', choice.sort.order);
  }
  if (choice.ids.length >= COMPARE_LIMITS.sideMin && choice.ids.length <= COMPARE_LIMITS.sideMax) params.set('ids', choice.ids.join(','));
  const text = params.toString();
  return text === '' ? '/api/compare' : `/api/compare?${text}`;
}

/**
 * 잣대 칸을 눌렀을 때의 다음 차례. 처음 누르면 그 잣대의 좋은 쪽이 앞(방향이 없으면 작은 것부터),
 * 같은 칸을 다시 누르면 거꾸로, 또 누르면 다시 처음 순서다.
 */
export function nextSort(current: CompareChoice['sort'], metric: CompareMetric): NonNullable<CompareChoice['sort']> {
  if (current === null || current.metric !== metric) return { metric, order: defaultOrder(metric) };
  return { metric, order: current.order === 'asc' ? 'desc' : 'asc' };
}

/** 고르기를 켜고 끈다. 넷이 찼으면 더 고르지 않는다. */
export function togglePick(picked: readonly number[], id: number): number[] {
  if (picked.includes(id)) return picked.filter((p) => p !== id);
  return picked.length >= COMPARE_LIMITS.sideMax ? [...picked] : [...picked, id];
}

/**
 * 표에 놓을 잣대 칸. 종류를 골랐으면 그 종류의 잣대 전부.
 * 안 골랐으면 표에 있는 종류 모두에 있는 잣대만 놓는다(한쪽에만 있는 칸은 종류를 골라야 보인다).
 */
export function tableMetrics(type: ProductType | null, rows: readonly { type: ProductType }[]): CompareMetric[] {
  if (type) return metricsOfType(type);
  const types = typesIn(rows);
  if (types.length === 0) return ['price_krw'];
  const [first, ...rest] = types.map(metricsOfType);
  return (first ?? []).filter((m) => rest.every((list) => list.includes(m)));
}
