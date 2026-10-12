'use client';

// 초안 한 건: 원문과 칸(넓은 화면은 좌우, 좁은 화면은 위아래). 값을 누르거나 마우스를 올리면 원문의 근거 구절이 강조된다.
// 칸 고치기·승인·반려·다시 돌리기도 여기서 한다. 판단(규칙)은 서버가 다시 돌린다.
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DecisionResponse, DraftDetailResponse, DraftEventBody, DraftFieldBody } from '@/contract/api';
import { SYSTEM_EVENT_REASONS } from '@/contract/api';
import { DOC_TYPES, SUBTYPES, TYPE_LABELS, isFieldKey, type DocType, type FieldKey } from '@/contract/fields';
import { REASONS, REJECT_CODES, REJECT_LABELS, hasBlocking, type RejectCode } from '@/contract/reasons';
import { REPROCESSABLE_STATUSES, REVIEWABLE_STATUSES, STATUS_LABELS } from '@/contract/transitions';
import { Notice, ReasonList, RouteBanner, StatusBadge } from './bits';
import { ApiFailure, ROLE_LABELS, call, failureMessage, setRole, useRole, waitForDraft } from './client';
import { FieldEditor } from './FieldEditor';
import { fieldLabel, formatTime, formatValue, sameValue } from './format';

interface Span {
  start: number;
  end: number;
}

/** 근거 구절이 원문의 어디에 있는지. 근거가 없으면 원문 표현(raw)으로 찾는다. */
function locate(text: string, field: DraftFieldBody | undefined): Span | null {
  if (!field) return null;
  for (const needle of [field.evidence, field.raw]) {
    const clean = needle?.trim();
    if (!clean) continue;
    const start = text.indexOf(clean);
    if (start >= 0) return { start, end: start + clean.length };
  }
  return null;
}

/** 원문. 글자로만 그린다(HTML 로 넣지 않는다). 강조할 구간만 mark 로 감싼다. */
function SourceText({ text, span, scrollKey }: { text: string; span: Span | null; scrollKey: string | null }) {
  const markRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // 좁은 화면에서는 원문이 위에 쌓여 있다. 거기까지 끌어 올리면 보던 칸을 놓치므로 칸 아래에 근거를 적는 것으로 대신한다.
    if (scrollKey && window.matchMedia('(min-width: 861px)').matches) markRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [scrollKey]);
  return (
    <pre className="source" tabIndex={0} aria-label="원문">
      {span ? (
        <>
          {text.slice(0, span.start)}
          <mark ref={markRef}>{text.slice(span.start, span.end)}</mark>
          {text.slice(span.end)}
        </>
      ) : (
        text
      )}
    </pre>
  );
}

function eventLine(e: DraftEventBody): string {
  const who = e.actor === 'system' ? '시스템' : ROLE_LABELS[e.actor];
  if (e.action === 'edit') {
    const field = e.field ?? '';
    return `${who}가 ${fieldLabel(field)} 칸을 고침: ${formatValue(field, e.before)} → ${formatValue(field, e.after)}`;
  }
  const from = e.from ? STATUS_LABELS[e.from] : '접수';
  const to = e.to ? STATUS_LABELS[e.to] : '';
  let why = '';
  if (e.reasonCode) {
    if (e.reasonCode in SYSTEM_EVENT_REASONS) why = ` (${SYSTEM_EVENT_REASONS[e.reasonCode as keyof typeof SYSTEM_EVENT_REASONS]})`;
    else if ((REJECT_CODES as readonly string[]).includes(e.reasonCode)) why = ` (사유: ${REJECT_LABELS[e.reasonCode as RejectCode]})`;
    else why = ` (${e.reasonCode})`;
  }
  return `${who}: ${from} → ${to}${why}`;
}

export function DraftPanel({
  draft,
  onDraft,
  publicSpace = false,
  mode,
  sourceTop,
  onCopyToMine,
}: {
  draft: DraftDetailResponse;
  onDraft: (draft: DraftDetailResponse) => void;
  /** 읽기 전용 본보기 공간의 초안인가 */
  publicSpace?: boolean;
  /** workbench: 작업 화면에 끼운 꼴(결정 버튼 없이 검수 화면으로 가는 길만). detail: 검수 화면. */
  mode: 'workbench' | 'detail';
  /** 원문 위에 놓을 것(작업 화면의 입력 고르기) */
  sourceTop?: ReactNode;
  /** 본보기 초안을 내 공간으로 가져오는 버튼을 눌렀을 때 */
  onCopyToMine?: () => void;
}) {
  const role = useRole();
  const [hover, setHover] = useState<FieldKey | null>(null);
  const [pinned, setPinned] = useState<FieldKey | null>(null);
  const [editing, setEditing] = useState<FieldKey | 'type' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ status: string; version: number } | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectCode, setRejectCode] = useState<RejectCode>(draft.type === 'not_product' ? 'NOT_A_PRODUCT' : 'NOT_ENOUGH_INFO');
  const [rejectMemo, setRejectMemo] = useState('');
  const [typeChoice, setTypeChoice] = useState<DocType>(draft.type ?? 'ad');
  const [subtypeChoice, setSubtypeChoice] = useState<string>(draft.subtype ?? '');

  const active = hover ?? pinned;
  const activeField = draft.fields.find((f) => f.field === active);
  const span = locate(draft.source.text, activeField);
  const editable = !publicSpace && REVIEWABLE_STATUSES.includes(draft.status);
  const humanEdited = draft.fields.some((f) => f.editedByHuman);
  const flagged = hasBlocking(draft.reasons) || draft.fields.some((f) => hasBlocking(f.reasons));
  const base = `/api/drafts/${draft.id}`;

  const reload = async () => {
    setConflict(null);
    setError(null);
    try {
      onDraft(await call<DraftDetailResponse>('GET', base, { publicSpace }));
    } catch (err) {
      setError(failureMessage(err));
    }
  };

  /** 쓰기 하나를 하고, 낡은 판(409)이면 알림을 띄운다. */
  const run = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    setConflict(null);
    try {
      await work();
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'VERSION_CONFLICT') setConflict(err.current ?? { status: '', version: 0 });
      else {
        setError(failureMessage(err));
        // 등록하지 못해 확인 필요로 돌아간 경우처럼 서버 쪽 상태가 바뀌었을 수 있다.
        if (err instanceof ApiFailure && err.current) await reload().catch(() => undefined);
      }
    } finally {
      setBusy(null);
    }
  };

  const saveField = (field: FieldKey, value: unknown) =>
    run(`edit:${field}`, async () => {
      const next = await call<DraftDetailResponse>('PATCH', `${base}/fields`, {
        body: { version: draft.version, edits: { [field]: value }, actor: role },
        label: `칸 고치기 (${fieldLabel(field)})`,
      });
      onDraft(next);
      setEditing(null);
    });

  const saveType = () =>
    run('edit:type', async () => {
      const subtype = typeChoice === 'not_product' ? null : subtypeChoice || null;
      const next = await call<DraftDetailResponse>('PATCH', `${base}/fields`, {
        body: { version: draft.version, edits: {}, type: typeChoice, subtype, actor: role },
        label: '종류·갈래 고치기',
      });
      onDraft(next);
      setEditing(null);
    });

  const decide = (name: 'approve' | 'reject' | 'reprocess', label: string, extra: Record<string, unknown> = {}) =>
    run(name, async () => {
      const done = await call<DecisionResponse>('POST', `${base}/${name}`, { body: { version: draft.version, actor: role, ...extra }, label });
      setRejecting(false);
      onDraft(done.status === 'PROCESSING' ? await waitForDraft(draft.id) : await call<DraftDetailResponse>('GET', base));
    });

  const typeLabel = draft.type ? TYPE_LABELS[draft.type] : '정해지지 않음';

  return (
    <div className="split">
      <section className="pane" aria-label="원문">
        {sourceTop}
        <h2 className="pane-title">
          원문
          {draft.source.kind !== 'text' ? (
            <span className="muted"> · {draft.source.kind === 'pdf' ? 'PDF' : '그림'}에서 옮긴 글{draft.source.originName ? ` (${draft.source.originName})` : ''}</span>
          ) : null}
        </h2>
        <SourceText text={draft.source.text} span={span} scrollKey={pinned} />
        <p className="muted small" aria-live="polite">
          {active
            ? span
              ? `“${fieldLabel(active)}”의 근거 구절을 강조했습니다.`
              : `“${fieldLabel(active)}”은 원문에서 근거 구절을 찾지 못했습니다.`
            : '양식의 값을 누르면(마우스를 올려도 됩니다) 원문에서 근거 구절이 강조됩니다.'}
        </p>
      </section>

      <section className="pane" aria-label="채워진 칸">
        <RouteBanner llm={draft.llm} sourceKind={draft.source.kind} status={draft.status} extractedBy={draft.extractedBy} />

        <h2 className="pane-title">
          초안 #{draft.id} <StatusBadge status={draft.status} />
          {publicSpace ? <span className="muted"> · 읽기 전용 본보기</span> : null}
        </h2>

        {draft.status === 'PROCESSING' ? <Notice>아직 처리 중입니다. 잠시 뒤 새로 고침을 눌러 주세요.</Notice> : null}
        {draft.status === 'FAILED' ? <Notice kind="warn">처리를 세 번 해 보고도 끝내지 못했습니다. 다시 돌려 볼 수 있습니다.</Notice> : null}
        {draft.status === 'READY' ? <p className="ok-line">표시가 하나도 없습니다. 바로 승인할 수 있습니다.</p> : null}
        {draft.status === 'NEEDS_REVIEW' && flagged ? <p className="flag-line">노란 표시가 붙은 곳을 확인해 주세요.</p> : null}

        <div className="field">
          <div className="field-name">종류 · 갈래</div>
          <div className="field-body">
            <div className="field-value-static">
              {typeLabel}
              {draft.subtype ? ` · ${draft.subtype}` : ''}
            </div>
            <ReasonList codes={draft.reasons} />
            {editing === 'type' ? (
              <div className="editor">
                <span className="pair">
                  <label>
                    종류{' '}
                    <select
                      value={typeChoice}
                      onChange={(e) => {
                        const next = e.target.value as DocType;
                        setTypeChoice(next);
                        setSubtypeChoice(SUBTYPES[next][0] ?? '');
                      }}
                    >
                      {DOC_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {TYPE_LABELS[t]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {typeChoice !== 'not_product' ? (
                    <label>
                      갈래{' '}
                      <select value={subtypeChoice} onChange={(e) => setSubtypeChoice(e.target.value)}>
                        {SUBTYPES[typeChoice].map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </span>
                <span className="actions">
                  <button type="button" className="btn primary small" onClick={saveType} disabled={busy !== null}>
                    {busy === 'edit:type' ? '저장 중…' : '저장'}
                  </button>
                  <button type="button" className="btn small" onClick={() => setEditing(null)} disabled={busy !== null}>
                    그만두기
                  </button>
                </span>
              </div>
            ) : editable ? (
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  const t = draft.type ?? 'ad';
                  setTypeChoice(t);
                  setSubtypeChoice(draft.subtype && (SUBTYPES[t] as readonly string[]).includes(draft.subtype) ? draft.subtype : (SUBTYPES[t][0] ?? ''));
                  setEditing('type');
                }}
              >
                종류·갈래 고치기
              </button>
            ) : null}
          </div>
        </div>

        {draft.fields.length === 0 && draft.status !== 'PROCESSING' ? (
          <p className="muted">{draft.type === 'not_product' ? '등록 대상이 아닌 글이라 채울 칸이 없습니다.' : '채워진 칸이 없습니다.'}</p>
        ) : null}

        {draft.fields.map((f) => {
          const key = f.field;
          const marked = hasBlocking(f.reasons);
          const differs = f.codeValue !== null && f.modelValue !== null && !sameValue(f.codeValue, f.modelValue);
          const showBoth = differs || f.reasons.includes('VALUE_MISMATCH');
          return (
            <div
              key={key}
              className={`field${marked ? ' field-flag' : ''}${active === key ? ' field-active' : ''}`}
              onMouseEnter={() => setHover(key)}
              onMouseLeave={() => setHover(null)}
            >
              <div className="field-name">
                {fieldLabel(key)}
                {f.editedByHuman ? <span className="edited"> 사람이 고침</span> : null}
              </div>
              <div className="field-body">
                <div className="field-top">
                  <button
                    type="button"
                    className={`field-value${f.finalValue === null ? ' none' : ''}`}
                    aria-pressed={pinned === key}
                    aria-label={`${fieldLabel(key)}: ${formatValue(key, f.finalValue)}. 누르면 원문의 근거를 강조합니다.`}
                    onClick={() => setPinned(pinned === key ? null : key)}
                    onFocus={() => setHover(key)}
                    onBlur={() => setHover(null)}
                  >
                    {formatValue(key, f.finalValue)}
                  </button>
                  {editable && editing !== key ? (
                    <button type="button" className="btn small" onClick={() => setEditing(key)} aria-label={`${fieldLabel(key)} 고치기`}>
                      고치기
                    </button>
                  ) : null}
                </div>
                {f.raw ? <div className="muted small">원문 표현: “{f.raw}”</div> : null}
                {pinned === key ? (
                  <div className="small evidence">{f.evidence ? `근거 구절: “${f.evidence}”` : '근거 구절이 없습니다.'}</div>
                ) : null}
                {showBoth ? (
                  <dl className="both">
                    <div>
                      <dt>코드가 읽은 값</dt>
                      <dd>
                        {formatValue(key, f.codeValue)}{' '}
                        {editable && f.codeValue !== null && !sameValue(f.codeValue, f.finalValue) ? (
                          <button type="button" className="btn small" disabled={busy !== null} onClick={() => saveField(key, f.codeValue)}>
                            이 값 쓰기
                          </button>
                        ) : null}
                      </dd>
                    </div>
                    <div>
                      <dt>모델이 읽은 값</dt>
                      <dd>
                        {formatValue(key, f.modelValue)}{' '}
                        {editable && f.modelValue !== null && !sameValue(f.modelValue, f.finalValue) ? (
                          <button type="button" className="btn small" disabled={busy !== null} onClick={() => saveField(key, f.modelValue)}>
                            이 값 쓰기
                          </button>
                        ) : null}
                      </dd>
                    </div>
                  </dl>
                ) : null}
                <ReasonList codes={f.reasons} />
                {editing === key && isFieldKey(key) ? (
                  <FieldEditor
                    field={key}
                    value={f.finalValue}
                    busy={busy === `edit:${key}`}
                    onSave={(value) => saveField(key, value)}
                    onCancel={() => setEditing(null)}
                  />
                ) : null}
              </div>
            </div>
          );
        })}

        {conflict ? (
          <Notice kind="error">
            <strong>다른 사람이 먼저 바꿨습니다.</strong>{' '}
            {conflict.status && conflict.status in STATUS_LABELS
              ? `지금 상태는 “${STATUS_LABELS[conflict.status as keyof typeof STATUS_LABELS]}”입니다. `
              : ''}
            방금 누른 것은 적용되지 않았습니다. 새로 읽어 온 뒤 다시 해 주세요.{' '}
            <button type="button" className="btn small" onClick={reload}>
              새로 고침
            </button>
          </Notice>
        ) : null}
        {error ? <Notice kind="error">{error}</Notice> : null}

        {publicSpace ? (
          <Notice>
            본보기 공간의 초안은 읽기만 됩니다.{' '}
            {onCopyToMine ? (
              <button type="button" className="btn small" onClick={onCopyToMine}>
                내 공간으로 가져와 고치기
              </button>
            ) : null}
          </Notice>
        ) : mode === 'workbench' ? (
          draft.status !== 'PROCESSING' ? (
            <p className="next">
              <Link className="btn primary" href={`/drafts/${draft.id}`}>
                검수 화면에서 열기 (승인·반려)
              </Link>{' '}
              <Link className="btn" href="/inbox">
                검수함 보기
              </Link>
            </p>
          ) : null
        ) : (
          <div className="decide">
            {draft.status === 'APPROVED' ? (
              <p className="ok-line">
                승인되어 상품이 됐습니다.{' '}
                {draft.productId ? (
                  <Link className="btn primary small" href={`/products/${draft.productId}`}>
                    상품 보기
                  </Link>
                ) : null}
              </p>
            ) : null}
            {draft.status === 'REJECTED' && draft.reject ? (
              <p>
                반려 사유: {REJECT_LABELS[draft.reject.code]}
                {draft.reject.memo ? ` — ${draft.reject.memo}` : ''}
              </p>
            ) : null}

            {REVIEWABLE_STATUSES.includes(draft.status) ? (
              role === 'seller' ? (
                <Notice>
                  셀러로 보는 중입니다. 칸을 고칠 수 있고, 승인·반려는 운영자가 합니다.{' '}
                  <button type="button" className="btn small" onClick={() => setRole('admin')}>
                    운영자로 보기
                  </button>
                </Notice>
              ) : rejecting ? (
                <form
                  className="editor"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void decide('reject', '반려', { reasonCode: rejectCode, memo: rejectMemo.trim() || null });
                  }}
                >
                  <label>
                    반려 사유(꼭 골라야 합니다){' '}
                    <select value={rejectCode} onChange={(e) => setRejectCode(e.target.value as RejectCode)}>
                      {REJECT_CODES.map((code) => (
                        <option key={code} value={code}>
                          {REJECT_LABELS[code]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    메모(선택) <input className="wide" maxLength={500} value={rejectMemo} onChange={(e) => setRejectMemo(e.target.value)} />
                  </label>
                  <span className="actions">
                    <button type="submit" className="btn danger" disabled={busy !== null}>
                      {busy === 'reject' ? '반려 중…' : '반려하기'}
                    </button>
                    <button type="button" className="btn" onClick={() => setRejecting(false)} disabled={busy !== null}>
                      그만두기
                    </button>
                  </span>
                </form>
              ) : (
                <div className="actions">
                  <button type="button" className="btn primary" disabled={busy !== null} onClick={() => decide('approve', humanEdited ? '고쳐서 승인' : '승인')}>
                    {busy === 'approve' ? '승인 중…' : humanEdited ? '고친 값으로 승인' : '승인'}
                  </button>
                  <button type="button" className="btn" disabled={busy !== null} onClick={() => setRejecting(true)}>
                    반려
                  </button>
                  {flagged ? <span className="muted small">표시가 남아 있어도 사람이 보고 승인할 수 있습니다. 필수 값이 비면 등록되지 않습니다.</span> : null}
                </div>
              )
            ) : null}

            {REPROCESSABLE_STATUSES.includes(draft.status) ? (
              <div className="actions">
                <button type="button" className="btn" disabled={busy !== null} onClick={() => decide('reprocess', '다시 돌리기')}>
                  {busy === 'reprocess' ? '다시 돌리는 중…' : '다시 돌리기'}
                </button>
              </div>
            ) : null}
            {draft.status === 'PROCESSING' ? (
              <div className="actions">
                <button type="button" className="btn" disabled={busy !== null} onClick={() => run('wait', async () => onDraft(await waitForDraft(draft.id)))}>
                  {busy === 'wait' ? '기다리는 중…' : '새로 고침'}
                </button>
              </div>
            ) : null}
          </div>
        )}

        {mode === 'detail' ? (
          <section className="events" aria-label="변경 기록">
            <h3>변경 기록</h3>
            {draft.events.length === 0 ? (
              <p className="muted">아직 기록이 없습니다.</p>
            ) : (
              <ol>
                {draft.events.map((e) => (
                  <li key={e.id}>
                    <span className="muted small">{formatTime(e.at)}</span> {eventLine(e)}
                  </li>
                ))}
              </ol>
            )}
            <p className="muted small">사람이 고친 값은 “정답 후보”로 쌓여 성적표의 “가장 자주 고친 칸”에 보입니다.</p>
          </section>
        ) : null}

        {draft.fields.some((f) => f.reasons.length > 0) || draft.reasons.length > 0 ? (
          <p className="muted small">
            표시는 점수가 아니라 “왜 사람이 봐야 하는지”입니다. 사유는 {Object.keys(REASONS).length}가지입니다.
          </p>
        ) : null}
      </section>
    </div>
  );
}
