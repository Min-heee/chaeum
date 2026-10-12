// 코드가 읽은 값과 모델이 읽은 값을 견준다.
import { fieldDef, type FieldKey, type FieldKind, type FieldValue } from '@/contract/fields';
import type { ReasonCode } from '@/contract/reasons';

type Pair = { width: number; height: number };
type Rec = Record<string, unknown>;

/** 글자 정리: 글자 꼴 통일, 소문자, 괄호 글자 지움, 공백 지움. 일치 기준 문서의 정리와 같다. */
function cleanText(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[()[\]{}<>「」『』【】]/g, '').replace(/\s+/g, '');
}

/** 목록을 순서 없이 견준다. */
function sameSet(a: unknown, b: unknown, key: (item: unknown) => string): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const sa = new Set(a.map(key));
  const sb = new Set(b.map(key));
  return sa.size === sb.size && [...sa].every((k) => sb.has(k));
}

const pairKey = (item: unknown) => Object.entries(item as Rec).sort().join('|');

/** 값의 갈래별로 "같다"를 정한다. 반올림 차이(크기 0.005m, 유동인구 1명)만 봐준다. */
const SAME: Record<FieldKind, (a: unknown, b: unknown) => boolean> = {
  text: (a, b) => typeof a === 'string' && typeof b === 'string' && cleanText(a) === cleanText(b),
  money: (a, b) => a === b,
  bool: (a, b) => a === b,
  count: (a, b) => a === b,
  days: (a, b) => a === b,
  footfall: (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1,
  size_m: (a, b) => near(a, b, 0.005 + 1e-9),
  size_mm: (a, b) => near(a, b, 0.5),
  resolution: (a, b) => near(a, b, 0),
  hours: (a, b) => {
    const [x, y] = [a as Rec, b as Rec];
    return x.open === y.open && x.close === y.close && x.nextDay === y.nextDay;
  },
  period_options: (a, b) => sameSet(a, b, pairKey),
  quantity_options: (a, b) => sameSet(a, b, pairKey),
  formats: (a, b) => sameSet(a, b, (s) => String(s).toLowerCase().replace(/^\./, '')),
};

function near(a: unknown, b: unknown, tolerance: number): boolean {
  const [x, y] = [a as Pair, b as Pair];
  return Math.abs(x.width - y.width) <= tolerance && Math.abs(x.height - y.height) <= tolerance;
}

/** 두 값이 같은가. 꼴이 달라 견줄 수 없으면 다른 것으로 친다. */
export function sameValue(field: FieldKey, a: FieldValue, b: FieldValue): boolean {
  try {
    return SAME[fieldDef(field).kind](a, b);
  } catch {
    return false;
  }
}

/** 모델 값과 코드 값이 둘 다 있고 다르면 VALUE_MISMATCH. 한쪽이 null 이면 따지지 않는다. */
export function checkMismatch(field: FieldKey, modelValue: FieldValue | null, codeValue: FieldValue | null): ReasonCode[] {
  if (modelValue === null || codeValue === null) return [];
  return sameValue(field, modelValue, codeValue) ? [] : ['VALUE_MISMATCH'];
}
