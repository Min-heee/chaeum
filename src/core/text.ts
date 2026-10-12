// 글자와 사유를 다루는 작은 도구. 맞추기·따지기가 함께 쓴다.
import type { NormalizeResult } from '@/contract/core-api';
import { REASON_CODES, type ReasonCode } from '@/contract/reasons';

/** 전각 글자·합친 글자를 보통 꼴로 바꾸고 소문자로 만든다. "７＊１２（ｍ）" → "7*12(m)" */
export function plain(s: string): string {
  return s.normalize('NFKC').toLowerCase().trim();
}

/** 견줄 때 쓰는 꼴. 글자 꼴을 통일하고 공백·줄바꿈을 모두 지운다. */
export function squash(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '');
}

/** 읽었다. */
export function read<T>(value: T, reasons: ReasonCode[] = []): NormalizeResult<T> {
  return { value, reasons: sortReasons(reasons) };
}

/** 못 읽었다. 값을 짐작해 내지 않는다. */
export function unread<T>(): NormalizeResult<T> {
  return { value: null, reasons: ['PARSE_FAILED'] };
}

/** 겹친 사유를 지우고 약속한 순서로 줄 세운다. */
export function sortReasons(reasons: readonly ReasonCode[]): ReasonCode[] {
  return REASON_CODES.filter((code) => reasons.includes(code));
}

/** 정수에 아주 가까우면 정수로 본다(1.1 × 10000 같은 소수 계산 찌꺼기). 아니면 null. */
export function asInt(n: number): number | null {
  const r = Math.round(n);
  return Math.abs(n - r) < 1e-6 ? r : null;
}
