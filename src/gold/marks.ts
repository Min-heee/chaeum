// 표기 조각이 원문의 어디에 있는지 찾는다. 확인 화면이 그 자리를 강조한다.
// 글자 위치만 센다. 원문을 고치거나 HTML 로 바꾸지 않는다. 브라우저에서도 도는 순수 함수만 둔다.

export interface HintLike {
  field: string;
  tokens: readonly string[];
}

/** 원문의 한 자리. start 이상 end 미만. */
export interface Span {
  start: number;
  end: number;
  field: string;
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/**
 * 조각이 글에 나오는 자리 전부.
 * 더 큰 수의 한 토막인 자리는 뺀다("7일"이 "17일" 안에 있으면 세지 않는다). 그런 자리를 강조하면 다른 값을 맞다고 보게 된다.
 * 검산(check.ts 의 cleanIndexes)과 같은 셈이다. 시험이 둘이 같은지 본다.
 */
export function findToken(text: string, token: string): number[] {
  const out: number[] = [];
  if (token.trim() === '') return out;
  const startsNum = /^[0-9]/.test(token);
  const endsNum = /[0-9]$/.test(token);
  for (let i = text.indexOf(token); i >= 0; i = text.indexOf(token, i + 1)) {
    const b1 = text[i - 1];
    const b2 = text[i - 2];
    const a1 = text[i + token.length];
    const a2 = text[i + token.length + 1];
    if (startsNum && (isDigit(b1) || (b1 === '.' && isDigit(b2)) || (b1 === ',' && isDigit(b2) && /^\d{3}(\D|$)/.test(token)))) continue;
    if (endsNum && (isDigit(a1) || ((a1 === '.' || a1 === ',') && isDigit(a2) && isDigit(text[i + token.length + 2]) && isDigit(text[i + token.length + 3])))) continue;
    if (endsNum && a1 === '.' && isDigit(a2)) continue;
    if (/[0-9]m$/.test(token) && a1 === 'm') continue;
    out.push(i);
  }
  return out;
}

export interface Found {
  /** 찾은 자리 전부(같은 조각이 여러 번 나오면 모두). 앞에서부터 차례로. */
  spans: Span[];
  /** 칸마다: 원문에서 못 찾은 조각 */
  missing: Record<string, string[]>;
}

/** 칸마다 조각의 자리를 모은다. */
export function findSpans(text: string, hints: readonly HintLike[]): Found {
  const spans: Span[] = [];
  const missing: Record<string, string[]> = {};
  for (const hint of hints) {
    for (const token of new Set(hint.tokens)) {
      const at = findToken(text, token);
      if (at.length === 0) (missing[hint.field] ??= []).push(token);
      for (const start of at) spans.push({ start, end: start + token.length, field: hint.field });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  return { spans, missing };
}

/** 원문을 자른 토막 하나. */
export interface Piece {
  start: number;
  text: string;
  /** 이 토막을 덮는 칸들. 비어 있으면 그냥 글이다. */
  fields: string[];
  /** 이 토막에서 조각이 끝나는 칸들. 꼬리표를 붙일 자리다. */
  ends: string[];
}

/**
 * 원문을 조각의 경계에서 자른다. 조각끼리 겹쳐도(판매가가 기간 옵션 안에 들어 있을 때) 토막은 겹치지 않는다.
 * 토막의 글을 이어 붙이면 원문과 글자 하나 다르지 않다.
 */
export function cutPieces(text: string, spans: readonly Span[]): Piece[] {
  const valid = spans.filter((s) => s.start >= 0 && s.end <= text.length && s.start < s.end);
  const cuts = [...new Set([0, text.length, ...valid.flatMap((s) => [s.start, s.end])])].sort((a, b) => a - b);
  const pieces: Piece[] = [];
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const a = cuts[i] as number;
    const b = cuts[i + 1] as number;
    const over = valid.filter((s) => s.start <= a && s.end >= b);
    pieces.push({
      start: a,
      text: text.slice(a, b),
      fields: [...new Set(over.map((s) => s.field))],
      ends: [...new Set(over.filter((s) => s.end === b).map((s) => s.field))],
    });
  }
  return pieces;
}
