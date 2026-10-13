'use client';

// 초안 한 건: 원문과 칸(넓은 화면은 좌우, 좁은 화면은 위아래). 값을 누르거나 마우스를 올리면 원문의 근거 구절이 강조된다.
// 칸 고치기·승인·반려·다시 돌리기도 여기서 한다. 판단(규칙)은 서버가 다시 돌린다.
// 꼴: 양식 머리(번호·상태) → 요약 한 줄 + 보기 전환 → 어떤 길로 뽑혔는지 → 칸 목록 → 아래에 붙는 행동 막대.
// 막대에는 지금 할 일(승인·반려)과, 끝난 뒤의 다음 일(다음 초안 열기, 새 글 넣기)이 놓인다.
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { DecisionResponse, DraftDetailResponse, DraftEventBody, DraftFieldBody, DraftListResponse } from '@/contract/api';
import { SYSTEM_EVENT_REASONS } from '@/contract/api';
import { DOC_TYPES, SUBTYPES, TYPE_LABELS, isFieldKey, type DocType, type FieldKey } from '@/contract/fields';
import { REASONS, REJECT_CODES, REJECT_LABELS, hasBlocking, type RejectCode } from '@/contract/reasons';
import { REPROCESSABLE_STATUSES, REVIEWABLE_STATUSES, STATUS_LABELS } from '@/contract/transitions';
import { Badge, Loading, Notice, ReasonList, RouteBanner, StatusBadge } from './bits';
import { ApiFailure, ROLE_LABELS, call, failureMessage, productHref, setPref, setRole, usePref, useRole, waitForDraft } from './client';
import { FieldEditor } from './FieldEditor';
import { fieldLabel, formatTime, formatValue, sameValue } from './format';
import styles from './DraftPanel.module.css';

interface Span {
  start: number;
  end: number;
}

/** 원문과 양식이 좌우 두 칸으로 서는 너비(app/globals.css 의 .split 경계와 같다). */
export const TWO_PANES = '(min-width: 900px)';

/** 이 둘이 비면 승인해도 상품으로 등록되지 않는다. 승인 버튼 옆에 미리 알린다. */
const CORE_FIELDS: readonly FieldKey[] = ['name', 'price_krw'];

/** 고친 뒤·그만둔 뒤·결정한 뒤에 초점을 어디로 보낼지. 화면이 다시 그려진 다음에 옮긴다. */
type FocusWant = { to: 'next-flagged'; from: FieldKey; after: readonly string[] } | { to: 'row'; key: FieldKey | 'type' } | { to: 'dock' };

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
export function SourceText({ text, span = null, scrollKey = null }: { text: string; span?: Span | null; scrollKey?: string | null }) {
  const markRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // 두 칸이 위아래로 서는 너비에서는 원문이 위에 쌓여 있다. 거기까지 끌어 올리면 보던 칸을 놓치므로 칸 아래에 근거를 적는 것으로 대신한다.
    if (scrollKey && window.matchMedia(TWO_PANES).matches) markRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [scrollKey]);
  return (
    <pre className={`source ${styles.source}`} tabIndex={0} aria-label="원문">
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

/** 지금 하는 일을 막대에 한 줄로 적는다(화면 읽기 도구도 읽는다). */
function busyLine(busy: string | null): string | null {
  if (busy === null) return null;
  if (busy === 'approve') return '승인하는 중입니다…';
  if (busy === 'reject') return '반려하는 중입니다…';
  if (busy === 'reprocess') return '다시 돌리는 중입니다…';
  if (busy === 'wait') return '처리가 끝나기를 기다리는 중입니다…';
  return '고친 값을 저장하는 중입니다…';
}

export function DraftPanel({
  draft,
  onDraft,
  publicSpace = false,
  mode,
  sourceTop,
  onCopyToMine,
  copying = false,
  onNew,
}: {
  draft: DraftDetailResponse;
  onDraft: (draft: DraftDetailResponse) => void;
  /** 읽기 전용 본보기 공간의 초안인가 */
  publicSpace?: boolean;
  /** workbench: 작업 화면에 끼운 꼴(끝난 뒤의 다음 일은 "새 글 넣기"). detail: 검수 화면(다음 일은 "다음 초안 열기", 변경 기록도 보인다). */
  mode: 'workbench' | 'detail';
  /** 원문 위에 놓을 것(작업 화면의 입력 고르기) */
  sourceTop?: ReactNode;
  /** 본보기 초안을 내 공간으로 가져오는 버튼을 눌렀을 때 */
  onCopyToMine?: () => void;
  /** 가져오는 중인가(버튼을 잠근다) */
  copying?: boolean;
  /** 작업 화면에서 "새 글 넣기"를 눌렀을 때(글 칸을 비우고 다음 글을 받는다) */
  onNew?: () => void;
}) {
  const role = useRole();
  const dockId = useId();
  const [hover, setHover] = useState<FieldKey | null>(null);
  const [pinned, setPinned] = useState<FieldKey | null>(null);
  const [editing, setEditing] = useState<FieldKey | 'type' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ status: string; version: number } | null>(null);
  const [rejecting, setRejecting] = useState(false);
  // 반려 사유는 사람이 골라야 한다. 등록 대상이 아닌 글로 걸린 초안만 그 사유를 미리 골라 둔다.
  const [rejectCode, setRejectCode] = useState<RejectCode | ''>(draft.type === 'not_product' ? 'NOT_A_PRODUCT' : '');
  const [rejectMemo, setRejectMemo] = useState('');
  const [typeChoice, setTypeChoice] = useState<DocType>(draft.type ?? 'ad');
  const [subtypeChoice, setSubtypeChoice] = useState<string>(draft.subtype ?? '');
  /** 방금 저장한 것을 한 줄로 알린다(확인할 칸만 볼 때는 저장한 줄이 목록에서 빠지므로). */
  const [saved, setSaved] = useState<string | null>(null);
  /** 결정이 끝난 초안에서 다음에 열 초안. 검수 화면에서만 찾는다. */
  const [nextUp, setNextUp] = useState<{ forId: number; forStatus: string; id: number | null; waiting: number } | null>(null);
  /** 확인할 칸만 보기. 화면에서만 거른다(서버를 부르지 않는다). 다음 초안으로 옮겨도 남는다. */
  const onlyFlagged = usePref('onlyFlagged') === '1';
  const setOnlyFlagged = (on: boolean) => setPref('onlyFlagged', on ? '1' : null);
  const rejectFormRef = useRef<HTMLFormElement | null>(null);
  const paneRef = useRef<HTMLElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const focusWant = useRef<FocusWant | null>(null);

  // 반려 양식은 아래 막대 안에서 열린다. 막대가 화면 밖으로 밀려 있으면 버튼까지 보이게 끌어 온다.
  useEffect(() => {
    if (rejecting) rejectFormRef.current?.scrollIntoView({ block: 'nearest' });
  }, [rejecting]);

  // 고친 뒤에는 다음 확인할 칸의 "고치기"로(없으면 승인 버튼으로), 그만둔 뒤에는 그 줄의 "고치기"로, 결정한 뒤에는 막대로 초점을 보낸다.
  // 그대로 두면 입력이 사라지면서 초점이 문서 맨 위로 빠진다.
  useEffect(() => {
    const want = focusWant.current;
    const pane = paneRef.current;
    if (!want || !pane || editing !== null || busy !== null) return;
    focusWant.current = null;
    if (want.to === 'dock') {
      // 막대는 이미 화면 아래에 붙어 보인다. 초점만 옮기고 화면은 그대로 둔다.
      dockRef.current?.focus({ preventScroll: true });
      return;
    }
    const rows = [...pane.querySelectorAll<HTMLElement>('[data-row]')];
    const editButton = (row: HTMLElement | undefined) => row?.querySelector<HTMLElement>('[data-edit]') ?? null;
    if (want.to === 'row') {
      editButton(rows.find((row) => row.dataset.row === want.key))?.focus();
      return;
    }
    // 저장한 칸 다음에 오는 확인할 칸(없으면 맨 앞의 확인할 칸). 확인할 칸만 볼 때는 저장한 줄이 목록에서 빠지므로 차례는 저장 전에 적어 둔다.
    const flaggedRows = rows.filter((row) => row.dataset.flagged === 'true' && row.dataset.row !== want.from);
    const nextRow = want.after.map((key) => flaggedRows.find((row) => row.dataset.row === key)).find((row) => row !== undefined) ?? flaggedRows[0];
    const target =
      editButton(nextRow) ??
      pane.querySelector<HTMLElement>('[data-approve]') ??
      editButton(rows.find((row) => row.dataset.row === want.from)) ??
      dockRef.current;
    target?.focus();
  });

  const active = hover ?? pinned;
  const activeField = draft.fields.find((f) => f.field === active);
  const span = locate(draft.source.text, activeField);
  const reviewable = REVIEWABLE_STATUSES.includes(draft.status);
  const editable = !publicSpace && reviewable;
  const canDecide = !publicSpace && reviewable && role !== 'seller';
  const humanEdited = draft.fields.some((f) => f.editedByHuman);
  const draftFlagged = hasBlocking(draft.reasons);
  const flagged = draftFlagged || draft.fields.some((f) => hasBlocking(f.reasons));
  const base = `/api/drafts/${draft.id}`;

  // 요약 숫자. 종류·갈래 줄도 초안 전체 사유가 붙으면 확인할 줄로 센다.
  const total = draft.fields.length;
  const flaggedRows = draft.fields.filter((f) => hasBlocking(f.reasons)).length + (draftFlagged ? 1 : 0);
  const filledCount = draft.fields.filter((f) => f.finalValue !== null).length;
  const editedCount = draft.fields.filter((f) => f.editedByHuman).length;
  // 결정이 끝난 초안에서는 "확인할"이 아니라 "표시가 붙은"이라고 적는다.
  const flagWord = reviewable ? '확인할 칸' : '표시가 붙은 칸';
  // 확인할 칸이 하나도 없는 초안에서는 거르지 않는다(앞의 초안에서 켜 둔 보기가 남아 있어도 칸이 다 보인다).
  const filtering = onlyFlagged && flaggedRows > 0;
  const visibleFields = filtering ? draft.fields.filter((f) => hasBlocking(f.reasons) || editing === f.field) : draft.fields;
  const showTypeRow = !filtering || draftFlagged || editing === 'type';
  // 이름이나 판매가가 비면 승인해도 등록되지 않는다. 누르기 전에 알린다.
  const missingCore = canDecide ? CORE_FIELDS.filter((key) => draft.fields.some((f) => f.field === key && f.finalValue === null)) : [];

  // 결정이 끝났으면 다음에 볼 초안을 찾아 둔다(검수함의 목록과 같은 API). 한 건 끝내고 바로 다음 건으로 넘어가게 하려는 것이다.
  const wantNext = !publicSpace && mode === 'detail' && !reviewable && draft.status !== 'PROCESSING';
  useEffect(() => {
    if (!wantNext) return undefined;
    let alive = true;
    Promise.all([call<DraftListResponse>('GET', '/api/drafts?status=NEEDS_REVIEW'), call<DraftListResponse>('GET', '/api/drafts?status=READY')])
      .then(([review, ready]) => {
        if (!alive) return;
        const first = [...review.items, ...ready.items].find((item) => item.id !== draft.id) ?? null;
        setNextUp({ forId: draft.id, forStatus: draft.status, id: first?.id ?? null, waiting: (review.counts.NEEDS_REVIEW ?? 0) + (review.counts.READY ?? 0) });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [wantNext, draft.id, draft.status]);
  const next = wantNext && nextUp && nextUp.forId === draft.id && nextUp.forStatus === draft.status ? nextUp : null;

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
    setSaved(null);
    try {
      await work();
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'VERSION_CONFLICT') setConflict(err.current ?? { status: '', version: 0 });
      else {
        // 등록하지 못해 확인 필요로 돌아간 경우처럼 서버 쪽 상태가 바뀌었을 수 있다. 먼저 새로 읽고, 그 다음에 오류 글을 적는다
        // (새로 읽기가 앞의 오류 글을 지우므로 차례를 지킨다. 거꾸로 하면 실패했는데 화면이 아무 말도 하지 않는다).
        const message = failureMessage(err);
        if (err instanceof ApiFailure && err.current) await reload().catch(() => undefined);
        setError(message);
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
      const order = draft.fields.map((f) => f.field as string);
      focusWant.current = { to: 'next-flagged', from: field, after: order.slice(order.indexOf(field) + 1) };
      onDraft(next);
      setEditing(null);
      setSaved(`“${fieldLabel(field)}” 칸을 저장했습니다: ${formatValue(field, value)}`);
    });

  const saveType = () =>
    run('edit:type', async () => {
      const subtype = typeChoice === 'not_product' ? null : subtypeChoice || null;
      const next = await call<DraftDetailResponse>('PATCH', `${base}/fields`, {
        body: { version: draft.version, edits: {}, type: typeChoice, subtype, actor: role },
        label: '종류·갈래 고치기',
      });
      focusWant.current = { to: 'row', key: 'type' };
      onDraft(next);
      setEditing(null);
      setSaved('종류·갈래를 저장했습니다.');
    });

  const decide = (name: 'approve' | 'reject' | 'reprocess', label: string, extra: Record<string, unknown> = {}) =>
    run(name, async () => {
      const done = await call<DecisionResponse>('POST', `${base}/${name}`, { body: { version: draft.version, actor: role, ...extra }, label });
      setRejecting(false);
      focusWant.current = { to: 'dock' };
      onDraft(done.status === 'PROCESSING' ? await waitForDraft(draft.id) : await call<DraftDetailResponse>('GET', base));
    });

  const openEditor = (key: FieldKey) => {
    setSaved(null);
    setEditing(key);
  };
  const cancelEdit = (key: FieldKey | 'type') => {
    focusWant.current = { to: 'row', key };
    setEditing(null);
  };

  const typeLabel = draft.type ? TYPE_LABELS[draft.type] : '정해지지 않음';
  // 지금 할 일 한 줄. 칸 목록 바로 위에 둔다.
  const todoLine =
    draft.status === 'READY' ? (
      <p className="ok-line">표시가 하나도 없습니다. 바로 승인할 수 있습니다.</p>
    ) : draft.status === 'NEEDS_REVIEW' && flagged ? (
      <p>
        <span className="flag-line">노란 표시가 붙은 곳을 확인해 주세요.</span>{' '}
        {publicSpace ? null : <span className="muted small">표시가 남아 있어도 사람이 보고 승인할 수 있습니다.</span>}
      </p>
    ) : null;
  const working = busyLine(busy);

  const waitButton = (
    <button type="button" className="btn" disabled={busy !== null} onClick={() => run('wait', async () => onDraft(await waitForDraft(draft.id)))}>
      {busy === 'wait' ? '기다리는 중…' : '새로 고침'}
    </button>
  );

  // 아래 막대에 놓을 것. 본보기는 읽기만. 내 초안이면 지금 할 일(승인·반려), 끝난 뒤에는 다음 일.
  const showRejectForm = canDecide && rejecting;
  const detailLink = (
    <Link className="btn ghost" href={`/drafts/${draft.id}`}>
      검수 화면에서 열기 (승인·반려)
    </Link>
  );
  const productLink =
    draft.status === 'APPROVED' && draft.productId ? (
      <Link className="btn" href={productHref(draft.productId, publicSpace)}>
        상품 보기
      </Link>
    ) : null;
  let barMain: ReactNode;
  if (publicSpace) {
    barMain = (
      <>
        <p>본보기 공간의 초안은 읽기만 됩니다.</p>
        {onCopyToMine ? (
          <button type="button" className="btn primary" disabled={copying} onClick={onCopyToMine}>
            내 작업 공간으로 가져와 고치기
          </button>
        ) : null}
      </>
    );
  } else if (draft.status === 'PROCESSING') {
    barMain = waitButton;
  } else {
    barMain = (
      <>
        {draft.status === 'APPROVED' ? <p className="ok-line">승인되어 상품이 됐습니다.</p> : null}
        {draft.status === 'REJECTED' && draft.reject ? (
          <p>
            반려 사유: {REJECT_LABELS[draft.reject.code]}
            {draft.reject.memo ? ` — ${draft.reject.memo}` : ''}
          </p>
        ) : null}

        {reviewable ? (
          role === 'seller' ? (
            <>
              <p>셀러로 보는 중입니다. 칸을 고칠 수 있고, 승인·반려는 운영자가 합니다.</p>
              <button type="button" className="btn" onClick={() => setRole('admin')}>
                운영자로 보기
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn primary" data-approve disabled={busy !== null} onClick={() => decide('approve', humanEdited ? '고쳐서 승인' : '승인')}>
                {busy === 'approve' ? '승인 중…' : humanEdited ? '고친 값으로 승인' : '승인'}
              </button>
              <button type="button" className="btn" disabled={busy !== null} onClick={() => setRejecting(true)}>
                반려
              </button>
            </>
          )
        ) : null}

        {/* 끝난 뒤의 다음 일: 검수 화면에서는 다음 초안, 작업 화면에서는 새 글. */}
        {!reviewable && mode === 'detail' && next ? (
          next.id !== null ? (
            <Link className="btn primary" href={`/drafts/${next.id}`}>
              다음 초안 열기 <span className={styles.btnNote}>대기 {next.waiting}건</span>
            </Link>
          ) : (
            <p className="muted">대기 중인 초안이 없습니다.</p>
          )
        ) : null}
        {!reviewable && mode === 'workbench' && onNew ? (
          <button type="button" className="btn primary" onClick={onNew}>
            새 글 넣기
          </button>
        ) : null}

        {REPROCESSABLE_STATUSES.includes(draft.status) ? (
          <button type="button" className="btn" disabled={busy !== null} onClick={() => decide('reprocess', '다시 돌리기')}>
            {busy === 'reprocess' ? '다시 돌리는 중…' : '다시 돌리기'}
          </button>
        ) : null}

        {productLink}
        {mode === 'detail' ? (
          reviewable ? null : (
            <Link className="btn" href="/inbox">
              검수함으로
            </Link>
          )
        ) : (
          <>
            <Link className={reviewable ? 'btn ghost' : 'btn'} href="/inbox">
              검수함 보기
            </Link>
            {detailLink}
          </>
        )}
      </>
    );
  }

  return (
    <div className="split">
      <section className="pane" aria-label="원문">
        {sourceTop}
        <h2 className="pane-title">
          원문
          {draft.source.kind === 'image' || draft.source.kind === 'pdf' ? (
            <span className={`muted ${styles.sourceNote}`}>
              {' '}
              · {draft.source.kind === 'pdf' ? 'PDF' : '그림'}에서 옮긴 글{draft.source.originName ? ` (${draft.source.originName})` : ''}
            </span>
          ) : draft.source.kind === 'import' ? (
            <span className={`muted ${styles.sourceNote}`}> · 모으기 도구가 가져온 줄을 글로 적은 것</span>
          ) : null}
        </h2>
        <SourceText text={draft.source.text} span={span} scrollKey={pinned} />
        <p className={`muted small ${styles.sourceHint}`} aria-live="polite">
          {active
            ? span
              ? `“${fieldLabel(active)}”의 근거 구절을 강조했습니다.`
              : `“${fieldLabel(active)}”은 원문에서 근거 구절을 찾지 못했습니다.`
            : '양식의 값을 누르면(마우스를 올려도 됩니다) 원문에서 근거 구절이 강조됩니다.'}
        </p>
      </section>

      <section ref={paneRef} className={`pane ${styles.formPane}`} aria-label="채워진 칸">
        {/* 검수 화면은 화면 머리에 초안 번호와 상태가 있으므로 여기서는 되풀이하지 않는다. */}
        <div className={styles.formHead}>
          <h2 className={`pane-title ${styles.title}`} tabIndex={-1} data-draft-title>
            {mode === 'detail' ? '등록 양식' : `초안 #${draft.id}`}
          </h2>
          {mode === 'detail' ? null : <StatusBadge status={draft.status} />}
          {publicSpace ? <Badge>읽기 전용 본보기</Badge> : null}
          {/* 막대는 눈에는 늘 화면 아래에 있지만 키보드 차례로는 칸 목록 뒤다. 초점을 받을 때만 보이는 지름길을 둔다. */}
          {canDecide ? (
            <a
              className={styles.skipToDock}
              href={`#${dockId}`}
              onClick={(event) => {
                event.preventDefault();
                (dockRef.current?.querySelector<HTMLElement>('[data-approve]') ?? dockRef.current)?.focus();
              }}
            >
              승인·반려로 건너뛰기
            </a>
          ) : null}
        </div>

        {total > 0 ? (
          <div className={styles.listBar}>
            <dl className={styles.summary}>
              <div data-tone={flaggedRows > 0 ? 'warn' : 'ok'}>
                <dt>{flagWord}</dt>
                <dd>{flaggedRows}개</dd>
              </div>
              <div>
                <dt>채워진 칸</dt>
                <dd>
                  {filledCount} / {total}
                  {total > filledCount ? <span className={styles.summaryNote}> (값 없음 {total - filledCount}개)</span> : null}
                </dd>
              </div>
              <div>
                <dt>사람이 고친 칸</dt>
                <dd>{editedCount}개</dd>
              </div>
            </dl>
            <div className={`segmented ${styles.view}`} role="group" aria-label="칸 보기">
              <button type="button" className="seg" aria-pressed={!filtering} onClick={() => setOnlyFlagged(false)}>
                모든 칸
              </button>
              <button type="button" className="seg" aria-pressed={filtering} disabled={flaggedRows === 0} onClick={() => setOnlyFlagged(true)}>
                {flagWord}만 <span className={styles.segCount}>{flaggedRows}</span>
              </button>
            </div>
          </div>
        ) : null}

        <RouteBanner llm={draft.llm} sourceKind={draft.source.kind} status={draft.status} extractedBy={draft.extractedBy} />

        {draft.status === 'PROCESSING' ? <Notice>아직 처리 중입니다. 잠시 뒤 새로 고침을 눌러 주세요.</Notice> : null}
        {draft.status === 'FAILED' ? <Notice kind="warn">처리를 세 번 해 보고도 끝내지 못했습니다. 다시 돌려 볼 수 있습니다.</Notice> : null}

        <div className={styles.todo}>
          {todoLine}
          <p className={styles.saved} role="status">
            {saved}
          </p>
        </div>

        <div className={styles.list}>
          <div className={styles.listHead} aria-hidden="true">
            <span>칸</span>
            <span>값 · 원문 표현 · 확인할 까닭</span>
          </div>

          <div className={styles.rows} role="list" aria-label="등록 양식의 칸">
            {showTypeRow ? (
              <div role="listitem" className={`field ${styles.row}${draftFlagged ? ' field-flag' : ''}`} data-row="type" data-flagged={draftFlagged ? 'true' : undefined}>
                <div className="field-name">종류 · 갈래</div>
                <div className="field-body">
                  <div className="field-top">
                    <div className="field-value-static">
                      {typeLabel}
                      {draft.subtype ? ` · ${draft.subtype}` : ''}
                    </div>
                    {editable && editing !== 'type' ? (
                      <button
                        type="button"
                        className="btn small"
                        data-edit
                        onClick={() => {
                          const t = draft.type ?? 'ad';
                          setTypeChoice(t);
                          setSubtypeChoice(draft.subtype && (SUBTYPES[t] as readonly string[]).includes(draft.subtype) ? draft.subtype : (SUBTYPES[t][0] ?? ''));
                          setSaved(null);
                          setEditing('type');
                        }}
                      >
                        종류·갈래 고치기
                      </button>
                    ) : null}
                  </div>
                  <ReasonList codes={draft.reasons} />
                  {editing === 'type' ? (
                    <div
                      className={`editor ${styles.inlineForm}`}
                      onKeyDown={(event) => {
                        // 고치는 중에 Esc 를 누르면 그만둔다.
                        if (event.key !== 'Escape' || busy !== null) return;
                        event.stopPropagation();
                        cancelEdit('type');
                      }}
                    >
                      <span className="pair">
                        <label className="stack">
                          종류
                          <select
                            autoFocus
                            value={typeChoice}
                            onChange={(e) => {
                              const picked = e.target.value as DocType;
                              setTypeChoice(picked);
                              setSubtypeChoice(SUBTYPES[picked][0] ?? '');
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
                          <label className="stack">
                            갈래
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
                        <button type="button" className="btn small" onClick={() => cancelEdit('type')} disabled={busy !== null}>
                          그만두기
                        </button>
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {visibleFields.map((f) => {
              const key = f.field;
              const marked = hasBlocking(f.reasons);
              const differs = f.codeValue !== null && f.modelValue !== null && !sameValue(f.codeValue, f.modelValue);
              const showBoth = differs || f.reasons.includes('VALUE_MISMATCH');
              const raw = f.raw?.trim() ? f.raw : null;
              const evidence = f.evidence?.trim() ? f.evidence : null;
              // 근거 구절은 값을 눌렀을 때 적는다. 확인할 칸은 누르지 않아도 적는다(원문 표현과 같으면 한 번만 적는다).
              const showEvidence = evidence !== null && (pinned === key || (marked && evidence.trim() !== (raw ?? '').trim()));
              return (
                <div
                  key={key}
                  role="listitem"
                  className={`field ${styles.row}${marked ? ' field-flag' : ''}${active === key ? ' field-active' : ''}`}
                  data-row={key}
                  data-flagged={marked ? 'true' : undefined}
                  onMouseEnter={() => setHover(key)}
                  onMouseLeave={() => setHover(null)}
                >
                  <div className="field-name">
                    {fieldLabel(key)}
                    {f.editedByHuman ? (
                      <span className={styles.editedTag}>
                        {' '}
                        <Badge tone="info">사람이 고침</Badge>
                      </span>
                    ) : null}
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
                        <button type="button" className="btn small" data-edit onClick={() => openEditor(key)} aria-label={`${fieldLabel(key)} 고치기`}>
                          고치기
                        </button>
                      ) : null}
                    </div>
                    {raw !== null || showEvidence ? (
                      <dl className={styles.meta}>
                        {raw !== null ? (
                          <div>
                            <dt>원문 표현</dt>
                            <dd>“{raw}”</dd>
                          </div>
                        ) : null}
                        {showEvidence ? (
                          <div className={styles.evidenceLine}>
                            <dt>근거 구절</dt>
                            <dd>“{evidence}”</dd>
                          </div>
                        ) : null}
                      </dl>
                    ) : null}
                    {pinned === key && evidence === null ? <div className="small evidence">근거 구절이 없습니다.</div> : null}
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
                      <FieldEditor field={key} value={f.finalValue} busy={busy === `edit:${key}`} onSave={(value) => saveField(key, value)} onCancel={() => cancelEdit(key)} />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          {total === 0 && draft.status !== 'PROCESSING' ? (
            <p className={`muted ${styles.noFields}`}>{draft.type === 'not_product' ? '등록 대상이 아닌 글이라 채울 칸이 없습니다.' : '채워진 칸이 없습니다.'}</p>
          ) : null}

        </div>

        {draft.fields.some((f) => f.reasons.length > 0) || draft.reasons.length > 0 ? (
          <p className={`muted small ${styles.listNote}`}>
            표시는 점수가 아니라 “왜 사람이 봐야 하는지”입니다. 사유는 {Object.keys(REASONS).length}가지입니다.
          </p>
        ) : null}

        {canDecide && !rejecting && flagged ? (
          <p className={`muted small ${styles.beforeDock}`}>
            이름과 판매가가 비면 등록되지 않습니다. 그 밖의 필수 칸은 빈 채로도 등록되고, 등록된 뒤 점검에 &ldquo;필수 칸 빔&rdquo;으로 잡힙니다.
          </p>
        ) : null}

        <div ref={dockRef} id={dockId} className={styles.dock} data-dock tabIndex={-1} role="group" aria-label="이 초안에 할 일">
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
          {missingCore.length > 0 && !rejecting ? (
            <p className={styles.dockWarn}>
              <span className="flag">등록 안 됨</span> {missingCore.map((key) => fieldLabel(key)).join('·')} 칸이 비어 있어 승인해도 등록되지 않습니다.{' '}
              {missingCore.map((key) => (
                <button key={key} type="button" className={styles.linkBtn} onClick={() => openEditor(key)}>
                  {fieldLabel(key)} 채우기
                </button>
              ))}
            </p>
          ) : null}

          <div className={styles.bar}>
            {showRejectForm ? (
              <form
                ref={rejectFormRef}
                className={styles.rejectForm}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (rejectCode !== '') void decide('reject', '반려', { reasonCode: rejectCode, memo: rejectMemo.trim() || null });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && busy === null) setRejecting(false);
                }}
              >
                <label className="stack">
                  반려 사유(꼭 골라야 합니다)
                  <select autoFocus required value={rejectCode} onChange={(e) => setRejectCode(e.target.value as RejectCode | '')}>
                    <option value="" disabled>
                      사유 고르기
                    </option>
                    {REJECT_CODES.map((code) => (
                      <option key={code} value={code}>
                        {REJECT_LABELS[code]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="stack">
                  메모(선택)
                  <input maxLength={500} value={rejectMemo} onChange={(e) => setRejectMemo(e.target.value)} />
                </label>
                <span className="actions">
                  <button type="submit" className="btn danger" disabled={busy !== null || rejectCode === ''}>
                    {busy === 'reject' ? '반려 중…' : '반려하기'}
                  </button>
                  <button type="button" className="btn" onClick={() => setRejecting(false)} disabled={busy !== null}>
                    그만두기
                  </button>
                </span>
              </form>
            ) : (
              <>
                <div className={styles.barMain}>{barMain}</div>
                <div className={styles.barSide}>
                  {working ? (
                    <Loading label={working} lines={0} />
                  ) : reviewable && total > 0 ? (
                    <span className={styles.barCount}>
                      {flaggedRows > 0 ? (
                        <Badge tone="warn">
                          {flagWord} {flaggedRows}개
                        </Badge>
                      ) : (
                        <Badge tone="ok">표시 없음</Badge>
                      )}
                    </span>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </div>

        {mode === 'detail' ? (
          <section className={`events ${styles.events}`} aria-label="변경 기록">
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
      </section>
    </div>
  );
}
