// 정답 한 건의 설계도. 원문을 쓰는 쪽에 이것을 준다. 원문은 여기에 없다.
import type { DocType, FieldKey, FieldValue } from '@/contract/fields';
import type { GoldSplit, GoldStyle, GoldTrap } from '@/contract/eval-types';

/** 값이 있는 칸을 원문에 어떻게 적을지. */
export interface SurfaceHint {
  field: FieldKey;
  label: string;
  /** 원문에 적을 표기의 본보기. 예: "05시~25시", "월 250만 명" */
  show: string;
  /** 원문에 글자 그대로 들어가야 하는 조각들 */
  tokens: string[];
  /** 표기의 꼴 이름("묶음:꼴"). 꼴의 목록은 forms.ts 에 있다. 검산은 이 이름을 보지 않고 show 의 글자를 읽는다. */
  form: string;
  /** 수 옆에 단위를 붙이지 않는 꼴에서 그 수의 단위. 예: "만원", "mm". 검산이 이것으로 수를 읽는다. */
  unit?: string;
  /** unit 이 있을 때: 그 단위를 글 다른 곳(칸 이름·표 머리·문장)에 밝혀야 하는가. false 면 일부러 밝히지 않는 꼴이다. */
  declare_unit?: boolean;
  /** 보조 갈래. 값표에서 금액 꼴(money)과 기간·수량 낱말 꼴(words) */
  parts?: Record<string, string>;
  note?: string;
}

/** 값이 없는 칸. 원문에 그 정보를 쓰지 않는다. */
export interface AbsentHint {
  field: FieldKey;
  label: string;
  /** omit: 아예 쓰지 않음. placeholder: 칸 이름은 쓰고 값 자리에 "추후 안내" 같은 말만 씀. */
  how: 'omit' | 'placeholder';
  placeholder?: string;
  note: string;
}

export interface GoldSpec {
  id: string;
  split: Extract<GoldSplit, 'dev' | 'test'>;
  type: DocType;
  subtype: string | null;
  style: GoldStyle;
  traps: GoldTrap[];
  /** 함정의 세부. 예: "unit:hours_over24" */
  trap_detail: string[];
  /** 칸별 표준 값. 없으면 null. */
  truth: Partial<Record<FieldKey, FieldValue | null>>;
  surface_hints: SurfaceHint[];
  absent: AbsentHint[];
  /** 원문에 글자 그대로 넣을 문장(지시문 함정) */
  must_include: string[];
  /** 글 쓰는 이에게 주는 말 */
  notes: string[];
}

export const DEFAULT_SEED = 20261012;
