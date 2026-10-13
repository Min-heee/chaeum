// 실제 자료 묶음의 정답이 어디서 왔는지 센다. 순수 함수만 둔다(브라우저에서도 돈다).
//
// 이 묶음의 정답은 얼린 파이프라인이 채운 초안을 사람이 고쳐서 만든다. 사람이 놓친 틀림은 맞은 것으로 세어진다.
// 그래서 이 묶음에서 내세우는 숫자는 정확도가 아니라 "사람이 얼마나 손댔는가"다:
//   모델이 채운 칸 가운데 사람이 고친 칸 ○/○ · 사람이 새로 넣은 칸 ○ · 사람이 지운(지어낸) 칸 ○ · 고친 것이 하나도 없는 문서 ○/○
import type { DraftEvaluation } from '@/contract/core-api';
import type { GoldDoc, GoldTrap, GoldTruth } from '@/contract/eval-types';
import { FIELDS_BY_TYPE, isFieldKey, type DocType, type FieldKey, type FieldValue } from '@/contract/fields';
import { hasBlocking } from '@/contract/reasons';
import { canon } from './canon';

/** 모델(얼린 파이프라인)이 낸 칸 하나 */
export interface ModelField {
  /** 초안에 실린 값(코드가 맞춘 값, 없으면 모델이 읽은 값). 없으면 null */
  value: FieldValue | null;
  /** 원문 표현 그대로 */
  raw: string | null;
  /** 근거가 된 원문 구절 */
  evidence: string | null;
  /** 막는 사유(표시)가 붙었는가 */
  flagged: boolean;
}

/** 모델이 낸 초안. gold_real_intake.model 에 이 꼴로 남는다. */
export interface ModelDraft {
  type: DocType;
  subtype: string | null;
  fields: Partial<Record<FieldKey, ModelField>>;
  /** 문서가 "확인 필요"로 갔는가(칸이든 초안이든 막는 사유가 하나라도 있었는가) */
  docFlagged: boolean;
}

/**
 * "없음"인가. 값이 없거나(null), 빈 목록이거나, 빈 글이다. 정답을 만들 때(real.ts 의 buildTruth)와 같은 규칙이다.
 * 모델 쪽과 사람 쪽을 같은 규칙으로 봐야 "모델이 빈 목록을 냈고 사람이 그대로 둔 칸"이 지운 칸으로 세어지지 않는다.
 */
export function isNone(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0) || (typeof value === 'string' && value.trim() === '');
}

/** 없음이면 null 로. */
export const orNull = <T>(value: T | null | undefined): T | null => (isNone(value) ? null : (value as T));

/** 따지고 난 결과에서 남길 것만 고른다. 빈 목록·빈 글은 값이 아니라 없음(null)으로 남긴다. */
export function draftFromEvaluation(ev: DraftEvaluation): ModelDraft {
  const fields: ModelDraft['fields'] = {};
  for (const f of ev.fields) {
    fields[f.field] = { value: orNull(f.finalValue), raw: f.raw, evidence: f.evidence, flagged: hasBlocking(f.reasons) };
  }
  return {
    type: ev.type,
    subtype: ev.subtype,
    fields,
    docFlagged: hasBlocking(ev.draftReasons) || ev.fields.some((f) => hasBlocking(f.reasons)),
  };
}

/** 모델 초안을 정답 꼴로(그 종류의 칸 전부, 없는 칸은 null). 사람이 손대기 전의 출발점이다. */
export function truthFromDraft(draft: ModelDraft): GoldTruth {
  const fields: GoldTruth['fields'] = {};
  for (const k of FIELDS_BY_TYPE[draft.type]) fields[k] = orNull(draft.fields[k]?.value);
  return { type: draft.type, subtype: draft.subtype, fields };
}

/** 그 종류의 빈 정답(칸 전부 null). 사람이 종류를 바꿨을 때의 출발점이다. */
export function emptyTruth(type: DocType, subtype: string | null): GoldTruth {
  return { type, subtype, fields: Object.fromEntries(FIELDS_BY_TYPE[type].map((k) => [k, null])) };
}

export interface EvidenceHint {
  field: FieldKey;
  tokens: string[];
}

/**
 * 확인 화면이 원문에서 강조할 구절. 모델이 준 근거 구절을 쓴다. 근거가 원문에 글자 그대로 없으면 원문 표현(raw)으로 대신한다.
 * 둘 다 원문에 없으면 근거를 그대로 넘긴다(화면이 "원문에서 못 찾음"이라고 알린다).
 */
export function hintsFromDraft(content: string, draft: ModelDraft): EvidenceHint[] {
  const out: EvidenceHint[] = [];
  for (const [key, f] of Object.entries(draft.fields)) {
    if (!isFieldKey(key) || !f) continue;
    const candidates = [f.evidence, f.raw].filter((t): t is string => typeof t === 'string' && t.trim() !== '');
    if (candidates.length === 0) continue;
    const found = candidates.find((t) => content.includes(t));
    out.push({ field: key, tokens: [found ?? (candidates[0] as string)] });
  }
  return out;
}

// ── 사람이 무엇을 바꿨는가 ─────────────────────────────────

/**
 * 칸 하나에서 사람이 한 일.
 * - kept: 모델 값이 있고 그대로 둠        - fixed: 모델 값이 있고 다른 값으로 고침
 * - removed: 모델 값이 있는데 없음으로 함(지어낸 값)   - added: 모델은 비웠는데 사람이 값을 넣음(놓친 값)
 * - kept_none: 모델도 사람도 없음
 */
export const ORIGIN_ACTIONS = ['kept', 'fixed', 'removed', 'added', 'kept_none'] as const;
export type OriginAction = (typeof ORIGIN_ACTIONS)[number];

export const ACTION_LABELS: Record<OriginAction, string> = {
  kept: '그대로',
  fixed: '고침',
  removed: '지움',
  added: '넣음',
  kept_none: '없음 그대로',
};

const sameValue = (a: unknown, b: unknown) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));

export function actionOf(modelValue: unknown, humanValue: unknown): OriginAction {
  // 빈 목록·빈 글은 양쪽 모두 없음으로 본다(이미 남아 있는 초안에 빈 목록이 있어도 같은 셈이 나온다).
  const m = orNull(modelValue);
  const h = orNull(humanValue);
  if (m === null) return h === null ? 'kept_none' : 'added';
  if (h === null) return 'removed';
  return sameValue(m, h) ? 'kept' : 'fixed';
}

export interface FieldOrigin {
  field: FieldKey;
  modelValue: FieldValue | null;
  humanValue: FieldValue | null;
  action: OriginAction;
  /** 모델 쪽에서 표시가 붙어 있던 칸인가 */
  flagged: boolean;
}

export interface DocOrigin {
  typeChanged: boolean;
  subtypeChanged: boolean;
  fields: FieldOrigin[];
  /** 종류·갈래·칸 가운데 사람이 바꾼 것이 하나도 없는가 */
  untouched: boolean;
}

/**
 * 문서 하나: 모델 초안과 사람이 확정한 정답을 칸마다 견준다.
 * 칸은 확정한 종류의 칸 전부에, 모델이 값을 냈지만 그 종류에 없는 칸(사람이 종류를 바꿨을 때)을 더한다. 뒤의 것은 "지움"으로 센다.
 * 두 종류에 함께 있는 칸(이름, 판매가 등)은 종류를 바꿔도 값을 견준다(그대로·고침).
 */
export function docOrigin(draft: ModelDraft, truth: GoldTruth): DocOrigin {
  const keys: FieldKey[] = [...FIELDS_BY_TYPE[truth.type]];
  for (const [k, f] of Object.entries(draft.fields)) {
    if (isFieldKey(k) && !keys.includes(k) && !isNone(f?.value)) keys.push(k);
  }
  const fields = keys.map((field): FieldOrigin => {
    const modelValue = orNull(draft.fields[field]?.value);
    const humanValue = orNull(truth.fields[field]);
    return { field, modelValue, humanValue, action: actionOf(modelValue, humanValue), flagged: draft.fields[field]?.flagged ?? false };
  });
  const typeChanged = draft.type !== truth.type;
  const subtypeChanged = (draft.subtype ?? null) !== (truth.subtype ?? null);
  const untouched = !typeChanged && !subtypeChanged && fields.every((f) => f.action === 'kept' || f.action === 'kept_none');
  return { typeChanged, subtypeChanged, fields, untouched };
}

/**
 * 사람이 바꾼 것의 수: 바꾼 칸(고침·지움·넣음) + 종류나 갈래를 바꿨으면 1.
 * 종류를 바꾸면 갈래는 따라 바뀌므로 둘을 따로 세지 않는다. 확인 기록의 "고친 수"와 화면의 알림이 이 수를 쓴다.
 */
export function changedCount(origin: DocOrigin): number {
  const fields = origin.fields.filter((f) => f.action === 'fixed' || f.action === 'removed' || f.action === 'added').length;
  return fields + (origin.typeChanged || origin.subtypeChanged ? 1 : 0);
}

/** 묶음 전체의 셈. 이 묶음에서 내세우는 숫자다. */
export interface OriginTally {
  docs: number;
  /** 모델이 값을 낸 칸(그대로 + 고침 + 지움) */
  modelFilled: number;
  kept: number;
  /** 모델이 채운 칸 가운데 사람이 다른 값으로 고친 칸 */
  fixed: number;
  /** 사람이 지운 칸(모델이 지어낸 값) */
  removed: number;
  /** 사람이 새로 넣은 칸(모델이 놓친 값) */
  added: number;
  keptNone: number;
  typeChanged: number;
  subtypeChanged: number;
  /** 고친 것이 하나도 없는 문서 */
  untouchedDocs: number;
  /** 사람이 바꾼 칸(고침·지움·넣음) 가운데 모델 쪽 표시가 붙어 있던 칸 */
  changedFlagged: number;
}

export function tallyOrigins(origins: readonly DocOrigin[]): OriginTally {
  const t: OriginTally = { docs: origins.length, modelFilled: 0, kept: 0, fixed: 0, removed: 0, added: 0, keptNone: 0, typeChanged: 0, subtypeChanged: 0, untouchedDocs: 0, changedFlagged: 0 };
  for (const o of origins) {
    if (o.typeChanged) t.typeChanged += 1;
    if (o.subtypeChanged) t.subtypeChanged += 1;
    if (o.untouched) t.untouchedDocs += 1;
    for (const f of o.fields) {
      if (f.action === 'kept') t.kept += 1;
      else if (f.action === 'fixed') t.fixed += 1;
      else if (f.action === 'removed') t.removed += 1;
      else if (f.action === 'added') t.added += 1;
      else t.keptNone += 1;
      if (f.flagged && (f.action === 'fixed' || f.action === 'removed' || f.action === 'added')) t.changedFlagged += 1;
    }
  }
  t.modelFilled = t.kept + t.fixed + t.removed;
  return t;
}

/** 화면과 보고에 적는 한 줄. 정확도라는 말을 쓰지 않는다. */
export function tallyLine(t: OriginTally): string {
  return `모델이 채운 칸 가운데 사람이 고친 칸 ${t.fixed}/${t.modelFilled} · 사람이 새로 넣은 칸 ${t.added} · 사람이 지운(지어낸) 칸 ${t.removed} · 고친 것이 하나도 없는 문서 ${t.untouchedDocs}/${t.docs}`;
}

// ── 저장 꼴 ────────────────────────────────────────────────

export const REAL_SOURCE_KINDS = ['page', 'price_table', 'pdf_text', 'image_text', 'other'] as const;
export type RealSourceKind = (typeof REAL_SOURCE_KINDS)[number];

export const SOURCE_KIND_LABELS: Record<RealSourceKind, string> = {
  page: '소개 글(웹 페이지)',
  price_table: '단가표',
  pdf_text: 'PDF 를 글로 옮김',
  image_text: '그림을 글로 옮김',
  other: '그 밖',
};

/** 'real-007' 같은 번호. 묶음 안에서 가장 큰 번호 다음이다. 비어 있으면 001. */
export function nextDocId(split: 'real' | 'hand', existing: readonly string[]): string {
  const top = existing.reduce((max, id) => {
    const m = new RegExp(`^${split}-(\\d{3})$`).exec(id);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  if (top >= 999) throw new Error('번호가 다 찼다');
  return `${split}-${String(top + 1).padStart(3, '0')}`;
}

/** 정답 문서 한 건의 저장 꼴. 실제 자료와 손글 모두 사람이 쓴 글이다(author = human). 정답 버전은 1 에서 시작한다. */
export function makeGoldDoc(input: { id: string; split: 'real' | 'hand'; content: string; truth: GoldTruth; traps?: readonly GoldTrap[]; goldVersion?: number }): GoldDoc {
  const fields: GoldTruth['fields'] = {};
  for (const k of FIELDS_BY_TYPE[input.truth.type]) fields[k] = input.truth.fields[k] ?? null;
  return {
    id: input.id,
    split: input.split,
    goldVersion: input.goldVersion ?? 1,
    content: input.content,
    truth: { type: input.truth.type, subtype: input.truth.type === 'not_product' ? null : input.truth.subtype, fields },
    author: 'human',
    traps: [...(input.traps ?? [])],
  };
}

/** 저장소에 남기는 출처 한 줄. 원문도 값도 없다. */
export interface RealSourceEntry {
  /** 정답 문서가 된 건은 그 번호. 넘긴 건은 null */
  id: string | null;
  sourceUrl: string;
  /** 받은 날(YYYY-MM-DD) */
  fetchedOn: string;
  kind: RealSourceKind;
  status: 'saved' | 'skipped';
  /** 넘긴 까닭(넘긴 건에만) */
  note?: string;
}

/** 출처 주소가 쓸 만한가. http(s) 주소만 받는다. */
export function isSourceUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export const isDate = (raw: string) => /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`));
