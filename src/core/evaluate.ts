// 한 번에 돌기: 뽑기 결과를 맞추고 따져 칸별 결과와 갈래를 낸다.
import type { DraftEvaluation, EvaluatedField, EvaluateInput, RecheckInput } from '@/contract/core-api';
import {
  FIELDS_BY_TYPE,
  parseFieldValue,
  type DocType,
  type FieldKey,
  type FieldValue,
  type FieldValues,
} from '@/contract/fields';
import type { ReasonCode } from '@/contract/reasons';
import { checkEvidence, rawInSource } from './checks/evidence';
import { checkMismatch } from './checks/mismatch';
import { checkRange } from './checks/range';
import { checkRequired } from './checks/required';
import { checkStructure, isPlaceholder } from './checks/structure';
import { normalizeField } from './normalize/field';
import { routeDraft } from './route';
import { sortReasons } from './text';

/** 칸 하나의 재료. 뽑기 결과에서 오거나 저장된 칸에서 온다. */
interface Material {
  field: FieldKey;
  raw: string | null;
  modelValue: FieldValue | null;
  evidence: string | null;
  /** 사람이 고친 칸이면 그 값(null 은 "없음"으로 비움) */
  edited?: { value: FieldValue | null };
}

/** 사람이 고치지 않은 칸: 원문 표현을 맞추고, 근거와 불일치를 본다. */
function fromSource(sourceText: string, m: Material): EvaluatedField {
  const reasons: ReasonCode[] = [];
  const raw = m.raw !== null && m.raw.trim() !== '' ? m.raw : null;

  let codeValue: FieldValue | null = null;
  // 자리 채움 글자("-", "추후 안내")는 읽을 값이 아니다. 사유는 구조 검사가 붙인다.
  if (raw !== null && !isPlaceholder(raw)) {
    const normalized = normalizeField(m.field, raw);
    codeValue = normalized.value;
    reasons.push(...normalized.reasons);
  }
  const finalValue = codeValue ?? m.modelValue;

  if (finalValue !== null) {
    reasons.push(...checkEvidence(sourceText, m.evidence, true));
    // 원문 표현이 원문에 없으면 지어낸 표현이다. 그것을 맞춘 값도 믿을 수 없다.
    if (raw !== null && !rawInSource(sourceText, raw)) reasons.push('NO_EVIDENCE');
    // 원문 표현 없이 값만 온 칸은 코드가 다시 읽어 볼 것이 없다.
    if (raw === null) reasons.push('PARSE_FAILED');
  }
  reasons.push(...checkMismatch(m.field, m.modelValue, codeValue));

  return {
    field: m.field,
    raw,
    modelValue: m.modelValue,
    codeValue,
    finalValue,
    evidence: m.evidence,
    reasons,
    editedByHuman: false,
  };
}

/** 칸을 하나씩 보고, 이어서 칸끼리·초안 전체를 본다(범위·필수·구조). */
function assemble(sourceText: string, type: DocType, subtype: string | null, materials: Material[]): DraftEvaluation {
  const byField = new Map(materials.map((m) => [m.field, m]));
  const fields: EvaluatedField[] = FIELDS_BY_TYPE[type].map((field) => {
    const m = byField.get(field) ?? { field, raw: null, modelValue: null, evidence: null };
    if (!m.edited) return fromSource(sourceText, m);
    const codeValue = m.raw !== null && !isPlaceholder(m.raw) ? normalizeField(field, m.raw).value : null;
    return {
      field,
      raw: m.raw,
      modelValue: m.modelValue,
      codeValue,
      finalValue: m.edited.value,
      evidence: m.evidence,
      reasons: [],
      editedByHuman: true,
    };
  });

  const values: FieldValues = {};
  const raws: Partial<Record<FieldKey, string | null>> = {};
  for (const f of fields) {
    values[f.field] = f.finalValue;
    // 사람이 고친 칸은 원문 표현이 아니라 고친 값을 본다.
    raws[f.field] = f.editedByHuman ? null : f.raw;
  }

  const structure = checkStructure({ sourceText, type, subtype, raws, values });
  const range = checkRange(type, values);
  const required = checkRequired(type, values);
  for (const f of fields) {
    f.reasons = sortReasons([
      ...f.reasons,
      ...(range[f.field] ?? []),
      ...(required[f.field] ?? []),
      ...(structure.fieldReasons[f.field] ?? []),
    ]);
  }

  const draftReasons = sortReasons([...(type === 'not_product' ? (['NOT_A_PRODUCT'] as const) : []), ...structure.draftReasons]);
  return { type, subtype, fields, draftReasons, route: routeDraft(fields.map((f) => f.reasons), draftReasons) };
}

/**
 * 뽑기 결과를 맞추고 따진다. 실패하지 않는다(걸린 것이 결과다).
 * - 그 종류에 없는 칸은 버린다. 뽑히지 않은 칸은 값이 null 인 채로 들어간다.
 * - 규칙만으로 뽑았으면 모델 값은 없는 것으로 친다.
 */
export function evaluateDraft(input: EvaluateInput): DraftEvaluation {
  const { sourceText, extraction, extractedBy } = input;
  const materials: Material[] = extraction.fields.map((f) => {
    const parsed = extractedBy === 'llm' ? parseFieldValue(f.field, f.value) : null;
    return {
      field: f.field,
      raw: f.raw,
      modelValue: parsed?.ok ? parsed.value : null,
      evidence: f.evidence,
    };
  });
  return assemble(sourceText, extraction.type, extraction.subtype, materials);
}

/**
 * 사람이 칸을 고친 뒤 다시 따진다.
 * 고친 칸(이번에 고친 것과 전에 고친 것)은 고친 값이 실리고 근거·불일치·읽기 실패·단위 사유를 붙이지 않는다.
 * 범위·필수·구조는 전부 다시 본다.
 */
export function recheckDraft(input: RecheckInput): DraftEvaluation {
  const materials: Material[] = input.fields.map((f) => {
    const base: Material = {
      field: f.field,
      raw: f.raw,
      modelValue: input.extractedBy === 'llm' ? f.modelValue : null,
      evidence: f.evidence,
    };
    if (Object.hasOwn(input.edits, f.field)) base.edited = { value: input.edits[f.field] ?? null };
    else if (f.editedByHuman) base.edited = { value: f.finalValue };
    return base;
  });
  // 저장된 칸에 없던 칸을 고쳤을 수도 있다(종류를 바꾼 뒤 등).
  for (const key of Object.keys(input.edits) as FieldKey[]) {
    if (!materials.some((m) => m.field === key)) {
      materials.push({ field: key, raw: null, modelValue: null, evidence: null, edited: { value: input.edits[key] ?? null } });
    }
  }
  return assemble(input.sourceText, input.type, input.subtype, materials);
}
