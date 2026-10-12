// 이번에 확인할 문서 고르기. 묶음의 일부만 확인할 때, 종류와 글 꼴이 고르게 섞이도록 씨앗으로 고른다.
// 순수 함수다. 문서의 번호·종류·글 꼴만 본다(원문과 정답 값은 보지 않는다).
import { hashSeed, makeRng } from './rng';

export interface TargetItem {
  id: string;
  /** 종류(광고 지면, 케이터링 …) */
  type: string;
  /** 글 꼴(공지, 메신저 …). 모르면 비운다. 그러면 종류만으로 층을 나눈다. */
  style?: string | null;
}

const layerOf = (item: TargetItem) => `${item.type}/${item.style ?? ''}`;

/**
 * 묶음에서 count 건을 고른다. 번호순으로 돌려준다.
 * - 층(종류 × 글 꼴)마다 그 층의 크기에 견준 몫만큼 고른다. 나머지는 소수 부분이 큰 층부터 하나씩 준다.
 * - 층 안에서는 씨앗으로 섞은 차례의 앞에서부터 고른다. 씨앗이 같으면 같은 문서가 나온다.
 * - keep(이미 확인한 문서)은 반드시 넣는다. 그 때문에 한 층이 몫을 넘으면, 몫보다 가장 많이 가진 다른 층에서 하나씩 뺀다.
 * - 고른 문서를 keep 에 더해 다시 불러도 같은 문서가 나온다(확인을 이어 가는 동안 목표가 바뀌지 않는다).
 * keep 이 count 보다 많으면 keep 전부를 돌려준다.
 */
export function pickTarget(items: readonly TargetItem[], count: number, seed: number, keep: readonly string[] = []): string[] {
  const ids = new Set(items.map((i) => i.id));
  const must = new Set(keep.filter((id) => ids.has(id)));
  const want = Math.max(0, Math.min(Math.floor(count), items.length));
  if (must.size >= want) return [...must].sort();

  const layers = new Map<string, string[]>();
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = layerOf(item);
    layers.set(key, [...(layers.get(key) ?? []), item.id]);
  }
  const keys = [...layers.keys()].sort();

  // 몫: 크기에 견준 값의 내림 + 소수 부분이 큰 차례로 하나씩
  const ideal = new Map(keys.map((k) => [k, (want * (layers.get(k) as string[]).length) / items.length]));
  const quota = new Map(keys.map((k) => [k, Math.floor(ideal.get(k) as number)]));
  const spare = want - [...quota.values()].reduce((a, b) => a + b, 0);
  const byFraction = [...keys].sort((a, b) => ((ideal.get(b) as number) % 1) - ((ideal.get(a) as number) % 1) || a.localeCompare(b));
  for (const k of byFraction.slice(0, spare)) quota.set(k, (quota.get(k) as number) + 1);

  // 이미 확인한 문서가 몫보다 많은 층은 그만큼 늘리고, 다른 층에서 뺀다.
  const kept = new Map(keys.map((k) => [k, (layers.get(k) as string[]).filter((id) => must.has(id)).length]));
  for (const k of keys) quota.set(k, Math.max(quota.get(k) as number, kept.get(k) as number));
  const total = () => [...quota.values()].reduce((a, b) => a + b, 0);
  while (total() > want) {
    const over = (k: string) => (quota.get(k) as number) - (ideal.get(k) as number);
    const from = keys.filter((k) => (quota.get(k) as number) > (kept.get(k) as number)).sort((a, b) => over(b) - over(a) || a.localeCompare(b))[0];
    if (from === undefined) break;
    quota.set(from, (quota.get(from) as number) - 1);
  }

  const picked: string[] = [];
  for (const k of keys) {
    const members = layers.get(k) as string[];
    const order = makeRng(hashSeed(seed, k)).shuffle(members);
    const fresh = order.filter((id) => !must.has(id)).slice(0, (quota.get(k) as number) - (kept.get(k) as number));
    picked.push(...members.filter((id) => must.has(id)), ...fresh);
  }
  return picked.sort();
}
