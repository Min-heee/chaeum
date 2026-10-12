// 칸 고치기. 사람이 값을 고치면 맞추기·따지기가 다시 돌고, 갈래(확인 필요 ↔ 바로 승인 가능)가 바뀔 수 있다.
// 고친 값마다 변경 기록에 edit 줄이 남는다. 그 줄이 곧 "사람이 고친 값 = 정답 후보"다.
// 상태·칸·기록이 한 트랜잭션이다. 낡은 version 이면 409.
import type { EventActor } from '@/contract/api';
import { cleanShortText, EDIT_LIMITS, FIELDS_BY_TYPE, isFieldKey, isSubtypeOf, parseEditValue, type DocType, type FieldKey, type FieldValue } from '@/contract/fields';
import { REASONS, type ReasonCode } from '@/contract/reasons';
import { REVIEWABLE_STATUSES, STATUS_LABELS } from '@/contract/transitions';
import { recheckDraft, routeDraft } from '@/core';
import { withTx } from './db';
import { AppError } from './errors';
import { assertEventRoom } from './limits';
import { addEditEvent } from './repos/draft-events';
import { getDraft, listFields, reviseDraft, saveFields, transitionDraft, type Draft } from './repos/drafts';
import { getSourceText } from './repos/source-docs';
import { touchWorkspaceForWrite } from './workspace';

export interface EditFieldsInput {
  workspaceId: string;
  draftId: number;
  /** 화면이 보고 있던 version */
  version: number;
  /** 칸 이름 → 새 값(표준 꼴). null 은 "없음"으로 비운다. */
  edits?: Record<string, unknown>;
  /** 종류를 고친다. 바뀌면 칸 목록이 달라진다. */
  type?: DocType;
  /** 갈래를 고친다. */
  subtype?: string | null;
  actor?: Extract<EventActor, 'seller' | 'admin'>;
  now: Date;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** 고칠 값의 꼴과 크기를 본다. 그 종류에 없는 칸, 꼴이 다른 값, 너무 긴 값이면 BAD_INPUT. */
function checkEdits(type: DocType, edits: Record<string, unknown>): Partial<Record<FieldKey, FieldValue | null>> {
  const allowed = FIELDS_BY_TYPE[type];
  const out: Partial<Record<FieldKey, FieldValue | null>> = {};
  for (const [key, value] of Object.entries(edits)) {
    if (!isFieldKey(key) || !allowed.includes(key)) throw new AppError('BAD_INPUT', `이 종류에 없는 칸입니다: ${key}`);
    const parsed = parseEditValue(key, value);
    if (!parsed.ok) {
      throw new AppError('BAD_INPUT', parsed.problem === 'too_long' ? `값이 너무 깁니다: ${key}` : `값의 꼴이 틀렸습니다: ${key}`);
    }
    out[key] = parsed.value;
  }
  return out;
}

/** 갈래를 정리한다. 비면 null, 길면 BAD_INPUT. */
function cleanSubtype(subtype: string | null): string | null {
  const clean = subtype === null ? '' : cleanShortText(subtype);
  if ([...clean].length > EDIT_LIMITS.subtypeMaxChars) throw new AppError('BAD_INPUT', '값이 너무 깁니다: subtype');
  return clean || null;
}

/**
 * 칸(과 종류·갈래)을 고친다. 고친 뒤의 초안을 돌려준다.
 * - 공간이 다르거나 없는 초안 NOT_FOUND · 본보기 공간 READ_ONLY_WORKSPACE · 낡은 version VERSION_CONFLICT
 * - 확인 필요·바로 승인 가능이 아닌 상태 BAD_TRANSITION · 모르는 칸이나 꼴이 다른 값, 너무 긴 값 BAD_INPUT
 * - 변경 기록이 상한에 닿은 초안 LIMIT_EXCEEDED
 */
export async function editFields(input: EditFieldsInput): Promise<Draft> {
  const { workspaceId, draftId, version, now } = input;
  const actor = input.actor ?? 'admin';
  const rawEdits = input.edits ?? {};
  if (Object.keys(rawEdits).length === 0 && input.type === undefined && input.subtype === undefined) {
    throw new AppError('BAD_INPUT', '고칠 것이 없습니다.');
  }

  return withTx(async (client) => {
    // 본보기 공간이면 여기서 막힌다. 공간 줄이 잠겨 같은 공간의 쓰기가 한 줄로 선다.
    await touchWorkspaceForWrite(client, workspaceId, now);
    // 남의 공간의 초안은 없는 것으로 본다. 이 뒤의 번호만 받는 함수들은 여기서 확인한 초안에만 쓴다.
    const draft = await getDraft(client, workspaceId, draftId);
    if (!draft) throw new AppError('NOT_FOUND', '초안이 없습니다.');
    if (draft.version !== version) {
      throw new AppError('VERSION_CONFLICT', '다른 사람이 먼저 바꿨습니다.', { status: draft.status, version: draft.version });
    }
    if (!REVIEWABLE_STATUSES.includes(draft.status)) {
      throw new AppError('BAD_TRANSITION', `'${STATUS_LABELS[draft.status]}' 상태에서는 고칠 수 없습니다.`);
    }

    await assertEventRoom(client, draftId);

    const type = input.type ?? draft.type;
    if (type === null) throw new AppError('BAD_INPUT', '종류가 정해지지 않은 초안입니다.');
    // 종류가 바뀌었는데 갈래를 따로 주지 않았으면, 옛 갈래가 새 종류에 맞을 때만 남긴다.
    const subtype =
      input.subtype !== undefined ? cleanSubtype(input.subtype) : type === draft.type || isSubtypeOf(type, draft.subtype) ? draft.subtype : null;
    const edits = checkEdits(type, rawEdits);

    const before = await listFields(client, draftId);
    const sourceText = (await getSourceText(client, draft.sourceDocId)) ?? '';
    const evaluation = recheckDraft({
      sourceText,
      type,
      subtype,
      extractedBy: draft.extractedBy ?? 'rules',
      // 새 종류에 없는 칸은 버린다(다시 따지기가 그 종류의 칸만 돌려준다).
      fields: before.filter((f) => FIELDS_BY_TYPE[type].includes(f.field)),
      edits,
    });

    // 파이프라인이 붙인 사유(규칙만으로 뽑음, 원본과 대조 필요)는 값을 고쳐도 남는다. 나머지는 방금 다시 따진 것으로 바꾼다.
    const kept = draft.reasons.filter((code) => REASONS[code]?.source === 'pipeline');
    const draftReasons: ReasonCode[] = [...evaluation.draftReasons, ...kept.filter((code) => !evaluation.draftReasons.includes(code))];
    const route = routeDraft(evaluation.fields.map((f) => f.reasons), draftReasons);

    await saveFields(client, draftId, evaluation.fields);
    const oldValue = new Map(before.map((f) => [f.field, f.finalValue]));
    for (const key of Object.keys(edits) as FieldKey[]) {
      const prev = oldValue.get(key) ?? null;
      const next = edits[key] ?? null;
      if (!sameValue(prev, next)) await addEditEvent(client, { draftId, actor, field: key, before: prev, after: next, now });
    }
    if (type !== draft.type) await addEditEvent(client, { draftId, actor, field: 'type', before: draft.type, after: type, now });
    if (subtype !== draft.subtype) await addEditEvent(client, { draftId, actor, field: 'subtype', before: draft.subtype, after: subtype, now });

    const patch = { type, subtype, reasons: draftReasons };
    if (route !== draft.status) {
      return transitionDraft(client, { workspaceId, draftId, to: route, expectedVersion: version, actor, patch, now });
    }
    return reviseDraft(client, { workspaceId, draftId, expectedVersion: version, allowed: REVIEWABLE_STATUSES, patch, now });
  });
}
