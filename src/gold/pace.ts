// 확인 속도. 지금까지 건마다 걸린 초의 가운데값으로 남은 시간을 어림하고, 너무 빨리 넘기는 일을 한 번 되묻는다. 순수 함수만 둔다.

/** 가운데값. 짝수 개면 가운데 둘의 평균. 빈 목록이면 null. */
export function median(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** 남은 건수 × 건당 가운데값 초 → 분(올림). 걸린 초 기록이 없으면 null. */
export function etaMinutes(seconds: readonly number[], left: number): number | null {
  const m = median(seconds);
  if (m === null) return null;
  return Math.ceil((m * Math.max(0, left)) / 60);
}

/** 한 건을 연 지 이만큼(초)이 안 됐는데 "확인 끝"을 누르면 한 번 되묻는다. */
export const MIN_LOOK_SECONDS = 5;
/** 등록 대상이 아닌 글은 채울 칸이 없는 짧은 글이라 더 짧게 잡는다. */
export const MIN_LOOK_SECONDS_NOT_PRODUCT = 3;

/**
 * 너무 빨리 넘기려는가. 그렇다면 지금까지 본 초(내림)를 돌려준다. 충분히 봤으면 null.
 * 막지는 않는다. 화면이 한 번 되묻고, 한 번 더 누르면 넘어간다. 걸린 초는 그대로 기록된다.
 */
export function tooFast(type: string, lookedMs: number): number | null {
  const floor = type === 'not_product' ? MIN_LOOK_SECONDS_NOT_PRODUCT : MIN_LOOK_SECONDS;
  return lookedMs < floor * 1000 ? Math.floor(Math.max(0, lookedMs) / 1000) : null;
}

// ── 방금 판정 되돌리기: 화면 쪽 줄 다시 놓기 ───────────────

/** 목록에서 그 값을 뒤에서부터 하나만 뺀다. */
export function dropOne(list: readonly number[], value: number): number[] {
  const at = list.lastIndexOf(value);
  return at < 0 ? [...list] : [...list.slice(0, at), ...list.slice(at + 1)];
}

export interface QueueLike<D extends { id: string }> {
  docs: D[];
  total: number;
  done: number;
  seconds?: number[];
}

/**
 * 되돌린 문서를 지금 볼 자리에 다시 놓는다.
 * - 같은 묶음의 바로 앞 문서면 한 칸 뒤로 간다(줄은 그대로).
 * - 앞 묶음의 마지막 문서였으면(새 묶음을 읽은 뒤에 되돌렸으면) 지금 자리에 끼워 넣고, 끝낸 건수와 걸린 초 목록에서 그 한 건을 뺀다.
 * sameBatch 가 true 면 이번 묶음에서 잰 초 목록에서 그 한 건을 빼야 한다.
 */
export function putBack<D extends { id: string }, Q extends QueueLike<D>>(queue: Q, index: number, doc: D, seconds: number): { queue: Q; index: number; sameBatch: boolean } {
  if (index > 0 && queue.docs[index - 1]?.id === doc.id) return { queue, index: index - 1, sameBatch: true };
  return {
    queue: {
      ...queue,
      docs: [...queue.docs.slice(0, index), doc, ...queue.docs.slice(index)],
      done: Math.max(0, queue.done - 1),
      seconds: dropOne(queue.seconds ?? [], seconds),
    },
    index,
    sameBatch: false,
  };
}
