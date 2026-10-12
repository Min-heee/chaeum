// 종류별 필수 칸이 비었는지 본다.
import type { FieldReasons } from '@/contract/core-api';
import { REQUIRED_BY_TYPE, type DocType, type FieldValues } from '@/contract/fields';

/**
 * 필수 칸이 null 이거나 빈 글이면 REQUIRED_MISSING.
 * 빈 목록([])은 여기서 세지 않는다. 그것은 구조 검사가 EMPTY_REQUIRED_OPTIONS 로 잡는다.
 */
export function checkRequired(type: DocType, values: FieldValues): FieldReasons {
  const out: FieldReasons = {};
  for (const key of REQUIRED_BY_TYPE[type]) {
    const value = values[key];
    const empty = value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
    if (empty) out[key] = ['REQUIRED_MISSING'];
  }
  return out;
}
