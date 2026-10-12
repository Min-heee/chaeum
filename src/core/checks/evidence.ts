// 근거 구절이 원문에 실제로 있는지 본다.
import type { ReasonCode } from '@/contract/reasons';
import { squash } from '../text';

/** 한두 글자짜리 근거("원")는 어디에나 있어서 근거가 못 된다. */
const MIN_EVIDENCE_CHARS = 2;

/**
 * 값이 있는데 근거 구절이 없거나 원문에 없으면 NO_EVIDENCE.
 * 전각·반각과 공백·줄바꿈 차이는 봐준다. 값이 없으면 따지지 않는다.
 */
export function checkEvidence(sourceText: string, evidence: string | null, hasValue: boolean): ReasonCode[] {
  if (!hasValue) return [];
  const needle = squash(evidence ?? '');
  if (needle.length < MIN_EVIDENCE_CHARS) return ['NO_EVIDENCE'];
  return squash(sourceText).includes(needle) ? [] : ['NO_EVIDENCE'];
}

/**
 * 원문 표현(raw)이 원문에 있는가.
 * 표의 여러 줄을 " / " 나 쉼표로 이어 붙인 표현은 조각마다 본다.
 */
export function rawInSource(sourceText: string, raw: string): boolean {
  const hay = squash(sourceText);
  if (hay.includes(squash(raw))) return true;
  const pieces = raw.split(/[\n/|;·]|,\s/).map(squash).filter(Boolean);
  return pieces.length > 1 && pieces.every((p) => hay.includes(p));
}
