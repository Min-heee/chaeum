// 초안 상태 6개와 이동 표. 표에 없는 이동은 422 다.

export const DRAFT_STATUSES = ['PROCESSING', 'NEEDS_REVIEW', 'READY', 'FAILED', 'APPROVED', 'REJECTED'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const STATUS_LABELS: Record<DraftStatus, string> = {
  PROCESSING: '처리 중',
  NEEDS_REVIEW: '확인 필요',
  READY: '바로 승인 가능',
  FAILED: '처리 실패',
  APPROVED: '승인됨',
  REJECTED: '반려됨',
};

/**
 * 이동 표. 왼쪽 상태에서 갈 수 있는 상태들.
 *
 *   PROCESSING ─┬→ NEEDS_REVIEW ─┬→ APPROVED
 *               ├→ READY ────────┤
 *               └→ FAILED        └→ REJECTED
 *   NEEDS_REVIEW ↔ READY          (칸을 고치면 갈래가 바뀔 수 있다)
 *   FAILED / REJECTED → PROCESSING (다시 돌리기)
 *
 * READY 도 사람이 승인해야 APPROVED 가 된다. APPROVED 에서는 어디로도 가지 않는다.
 */
export const TRANSITIONS: Record<DraftStatus, readonly DraftStatus[]> = {
  PROCESSING: ['NEEDS_REVIEW', 'READY', 'FAILED'],
  NEEDS_REVIEW: ['READY', 'APPROVED', 'REJECTED'],
  READY: ['NEEDS_REVIEW', 'APPROVED', 'REJECTED'],
  FAILED: ['PROCESSING'],
  APPROVED: [],
  REJECTED: ['PROCESSING'],
};

/** from 에서 to 로 갈 수 있는가. 같은 상태로의 이동은 이동이 아니다(false). */
export function canTransition(from: DraftStatus, to: DraftStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isDraftStatus(value: string): value is DraftStatus {
  return (DRAFT_STATUSES as readonly string[]).includes(value);
}

/** 갈래의 결과. 따지기가 끝난 초안이 가는 두 상태. */
export type Route = 'READY' | 'NEEDS_REVIEW';

/** 사람이 칸을 고치거나 결정을 내릴 수 있는 상태. */
export const REVIEWABLE_STATUSES: readonly DraftStatus[] = ['NEEDS_REVIEW', 'READY'];

/** 다시 돌릴 수 있는 상태. */
export const REPROCESSABLE_STATUSES: readonly DraftStatus[] = ['FAILED', 'REJECTED'];
