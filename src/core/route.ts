// 갈래: 사유를 보고 "바로 승인 가능"인지 "확인 필요"인지 정한다.
import { hasBlocking, type ReasonCode } from '@/contract/reasons';
import type { Route } from '@/contract/transitions';

/** 막는 사유가 칸에도 초안에도 하나도 없으면 READY, 아니면 NEEDS_REVIEW. */
export function routeDraft(fieldReasons: readonly ReasonCode[][], draftReasons: readonly ReasonCode[]): Route {
  const blocked = hasBlocking(draftReasons) || fieldReasons.some((reasons) => hasBlocking(reasons));
  return blocked ? 'NEEDS_REVIEW' : 'READY';
}
