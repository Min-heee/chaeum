// 씨앗으로 도는 난수. 같은 씨앗이면 같은 차례가 나온다. Math.random 은 쓰지 않는다.

export interface Rng {
  /** 0 이상 1 미만 */
  next(): number;
  /** min 이상 max 이하 정수 */
  int(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** 새 배열로 섞는다 */
  shuffle<T>(items: readonly T[]): T[];
  /** 겹치지 않게 k 개 */
  sample<T>(items: readonly T[], k: number): T[];
}

/** 글자를 32비트 수로 바꾼다(FNV-1a). 문서마다 다른 씨앗을 만들 때 쓴다. */
export function hashSeed(seed: number, salt: string): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < salt.length; i += 1) {
    h ^= salt.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error('빈 목록에서는 고를 수 없다');
    return items[int(0, items.length - 1)] as T;
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      const a = out[i] as T;
      out[i] = out[j] as T;
      out[j] = a;
    }
    return out;
  };
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick,
    shuffle,
    sample: (items, k) => shuffle(items).slice(0, k),
  };
}
