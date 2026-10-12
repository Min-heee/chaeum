// 글 속의 수 덩어리를 찾는다. "150만", "1억 2천만", "1.5천만", "1,500,000" 을 한 덩어리로 읽는다.
// 금액·유동인구·횟수 맞추기와 규칙만으로 뽑기가 함께 쓴다.

/** 수 하나. 쉼표는 세 자리마다만 받는다. */
export const NUM = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const UNIT = '[억만천백십万]';

/**
 * 수 덩어리.
 * 띄어 쓴 다음 수는 뒤에 단위가 올 때만 잇는다. "1억 2천만"은 한 덩어리, "150만 2주"는 "150만"에서 끊는다.
 */
export const CHUNK = String.raw`${NUM}(?:\s?${UNIT}+(?:\s?${NUM}(?=\s?(?:${UNIT}|원)))?)*`;

const MULT: Record<string, number> = { 억: 1e8, 만: 1e4, 万: 1e4, 천: 1e3, 백: 1e2, 십: 10 };

export interface NumberChunk {
  start: number;
  end: number;
  text: string;
  /** 읽은 값. 단위 순서가 이상하거나("200만 150만") 만이 빠진 꼴("1억5천")이면 null. */
  value: number | null;
  /** 억·만·천 같은 단위 글자가 붙었나 */
  hasUnit: boolean;
}

/** "1천5백만" → 15000000. 큰 단위(억 → 만)와 작은 단위(천 → 백 → 십)는 내려가는 순서여야 한다. */
function evalChunk(text: string): number | null {
  const tokens = text.match(new RegExp(`${NUM}|${UNIT}`, 'g')) ?? [];
  let total = 0;
  let section = 0;
  let cur: number | null = null;
  let lastBig = Infinity;
  let lastSmall = Infinity;
  for (const tok of tokens) {
    const mult = MULT[tok];
    if (mult === undefined) {
      cur = Number(tok.replace(/,/g, ''));
    } else if (mult < 1e4) {
      if (mult >= lastSmall) return null;
      section += (cur ?? 1) * mult;
      cur = null;
      lastSmall = mult;
    } else {
      if (mult >= lastBig) return null;
      section += cur ?? 0;
      total += section * mult;
      section = 0;
      cur = null;
      lastBig = mult;
      lastSmall = Infinity;
    }
  }
  // "1억5천"은 말로는 1억 5천만이지만 글자대로는 1억 5천이다. 어느 쪽인지 정하지 않는다.
  if (lastBig === 1e8 && lastSmall !== Infinity) return null;
  const sum = total + section + (cur ?? 0);
  return Number.isFinite(sum) ? Math.round(sum * 1e6) / 1e6 : null;
}

/** 글에서 수 덩어리를 차례로 찾는다. */
export function findNumberChunks(text: string): NumberChunk[] {
  const out: NumberChunk[] = [];
  for (const m of text.matchAll(new RegExp(CHUNK, 'g'))) {
    const chunk = m[0];
    out.push({
      start: m.index,
      end: m.index + chunk.length,
      text: chunk,
      value: evalChunk(chunk),
      hasUnit: new RegExp(UNIT).test(chunk),
    });
  }
  return out;
}

/** 수 사이의 물결표·줄표. "150~200만원", "7-10일", "10만-12만" 은 범위라 값 하나로 못 정한다. */
export function hasNumberRange(text: string): boolean {
  return (
    /[\d억만천백원]\s*[~∼〜]\s*\d/.test(text) ||
    /\d\s*[-–—]\s*\d/.test(text) ||
    // 줄표 앞이 단위 글자면 뒤에도 단위가 있을 때만 범위로 본다("150만 - 2주"는 범위가 아니다).
    /[억만천백]\s?[-–—]\s?\d[\d,.]*\s?[억만천백]/.test(text)
  );
}
