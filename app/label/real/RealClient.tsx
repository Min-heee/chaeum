'use client';

// 실제 자료 넣기: 글과 출처를 넣는다 → 얼린 파이프라인이 초안을 채운다 → 칸마다 "맞음 / 고침 / 없음으로 / 값 넣기"로 정답을 확정한다.
// 확인 화면(ReviewClient)과 같은 손놀림을 쓴다: 칸을 고르면 그 칸의 근거 구절이 원문에서 진해진다. 강조는 모델이 준 근거 구절이다.
// 키보드: ↑↓(j/k) 칸 옮기기, o 맞음, e 고침·값 넣기, n 없음으로, a 남은 칸 모두 맞음, Enter 확정, x 두 번 넘김, Esc 선택 풀기, u 방금 한 일 되돌리기.
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { DOC_TYPES, FIELDS_BY_TYPE, SUBTYPES, TYPE_LABELS, fieldDef, type DocType, type FieldKey, type FieldValue } from '@/contract/fields';
import { guideFor, parseEntry, showEntry, toEntryText } from '@/gold/entry';
import { FIELD_RULES, explainField } from '@/gold/explain';
import { cutPieces, findSpans } from '@/gold/marks';
import {
  REAL_SOURCE_KINDS,
  SOURCE_KIND_LABELS,
  emptyTruth,
  tallyLine,
  truthFromDraft,
  type EvidenceHint,
  type ModelDraft,
  type OriginTally,
  type RealSourceKind,
} from '@/gold/origins';
import { tooFast } from '@/gold/pace';
import styles from '../label.module.css';

export interface ScreenIntake {
  id: string;
  content: string;
  sourceUrl: string;
  fetchedOn: string;
  kind: RealSourceKind;
  model: ModelDraft;
  hints: EvidenceHint[];
  called: boolean;
  status: 'open' | 'saved' | 'skipped';
  goldDocId: string | null;
}

export interface ScreenProgress {
  target: number;
  saved: number;
  skipped: number;
  open: number;
  calls: number;
  cap: number;
  costUsd: number;
  tally: OriginTally;
}

type Mark = { state: 'ok' } | { state: 'fixed'; value: FieldValue | null };
type Marks = Partial<Record<FieldKey, Mark>>;

/** 사람이 하던 일. 되돌렸을 때 다시 놓는다. */
export interface ReviewState {
  type: DocType;
  subtype: string | null;
  marks: Marks;
}

interface Confirmed {
  docId: string;
  reviewId: string;
  verdict: string;
  changed: number;
  progress: ScreenProgress;
}

const DROP_CONFIRM_MS = 2000;
const pointer = { x: -1, y: -1 };
const tagOf = (key: string) => fieldDef(key as FieldKey).label.replace(/\(.*\)$/, '');
const quote = (tokens: readonly string[]) => tokens.map((t) => `“${t.length > 60 ? `${t.slice(0, 60)}…` : t}”`).join(' · ');

/** 이 묶음의 숫자가 무엇을 뜻하는지. 화면 머리에 늘 보인다. */
export function HonestNote() {
  return (
    <p className={styles.honest}>
      이 묶음의 정답은 <strong>모델이 채운 초안을 사람이 고쳐서</strong> 만듭니다. 사람이 놓친 틀림은 맞은 것으로 세어집니다(모델에 유리하게 기웁니다). 그래서 이 묶음에서 내세우는 숫자는
      정확도가 아니라 “사람이 얼마나 손댔는가”입니다. 칸마다 모델이 낸 값과 사람이 확정한 값을 따로 남깁니다. 초안을 믿지 말고 칸마다 원문을 봐 주세요.
    </p>
  );
}

interface RealReviewProps {
  intake: ScreenIntake;
  /** 되돌린 건이면 하던 일을 다시 놓는다. */
  initial?: ReviewState | null;
  busyRef: RefObject<boolean>;
  onConfirmed: (done: Confirmed, state: ReviewState) => void;
  onSkipped: (progress: ScreenProgress) => void;
}

/** 초안 한 건을 확정하는 화면. 시험이 그려 볼 수 있게 내보낸다. */
export function RealReview({ intake, initial, busyRef, onConfirmed, onSkipped }: RealReviewProps) {
  const model = intake.model;
  const [type, setType] = useState<DocType>(initial?.type ?? model.type);
  const [subtype, setSubtype] = useState<string | null>(initial ? initial.subtype : model.subtype);
  const [marks, setMarks] = useState<Marks>(initial?.marks ?? {});

  // 출발점: 모델과 같은 종류면 모델의 초안, 사람이 종류를 바꿨으면 그 종류의 빈 칸들.
  const base = useMemo(() => (type === model.type ? truthFromDraft(model) : emptyTruth(type, null)), [type, model]);
  const { order, filled } = useMemo(() => {
    const all = FIELDS_BY_TYPE[type];
    const has = (k: FieldKey) => (base.fields[k] ?? null) !== null;
    const withValue = all.filter(has);
    return { order: [...withValue, ...all.filter((k) => !has(k))], filled: withValue.length };
  }, [type, base]);

  const [cursor, setCursor] = useState<number | null>(order.length > 0 ? 0 : null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipArmed, setSkipArmed] = useState(false);
  const [askedFast, setAskedFast] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const clock = useRef({ start: 0, hidden: 0, hiddenAt: null as number | null });
  const sourceRef = useRef<HTMLPreElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const followList = useRef(false);

  const lookedMs = () => {
    const c = clock.current;
    const now = performance.now();
    const hidden = c.hidden + (c.hiddenAt === null ? 0 : now - c.hiddenAt);
    return Math.max(0, now - c.start - hidden);
  };

  useEffect(() => {
    clock.current = { start: performance.now(), hidden: 0, hiddenAt: null };
    const onVisibility = () => {
      const c = clock.current;
      if (document.visibilityState === 'hidden') c.hiddenAt = performance.now();
      else if (c.hiddenAt !== null) {
        c.hidden += performance.now() - c.hiddenAt;
        c.hiddenAt = null;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    const tick = setInterval(() => setElapsed(Math.round(lookedMs() / 1000)), 1000);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(tick);
    };
  }, []);

  useEffect(() => {
    if (!skipArmed) return;
    const timer = setTimeout(() => setSkipArmed(false), DROP_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [skipArmed]);

  // 강조는 모델이 준 근거 구절이다. 사람이 종류를 바꿨으면 그 종류의 칸에 해당하는 것만 남긴다.
  const hints = useMemo(() => intake.hints.filter((h) => (FIELDS_BY_TYPE[type] as readonly string[]).includes(h.field)), [intake.hints, type]);
  const hintOf = useMemo(() => new Map(hints.map((h) => [h.field, h])), [hints]);
  const found = useMemo(() => findSpans(intake.content, hints), [intake.content, hints]);
  const pieces = useMemo(() => cutPieces(intake.content, found.spans), [intake.content, found]);

  const valueOf = (k: FieldKey): FieldValue | null => {
    const m = marks[k];
    return m?.state === 'fixed' ? m.value : (base.fields[k] ?? null);
  };
  const current = cursor === null ? undefined : order[cursor];
  const unseen = order.filter((k) => !marks[k]);

  useEffect(() => {
    const box = sourceRef.current;
    const first = current ? box?.querySelector<HTMLElement>('[data-on="1"]') : null;
    if (!box || !first) return;
    const b = box.getBoundingClientRect();
    const r = first.getBoundingClientRect();
    if (r.top < b.top + 4 || r.bottom > b.bottom - 4) box.scrollTo({ top: box.scrollTop + (r.top - b.top) - box.clientHeight / 3, behavior: 'smooth' });
  }, [current, pieces]);

  useEffect(() => {
    if (!followList.current || !current) return;
    followList.current = false;
    listRef.current?.querySelector<HTMLElement>(`[data-field="${current}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const go = (next: number | null) => {
    followList.current = true;
    setCursor(next);
  };
  const step = (by: 1 | -1) => go(cursor === null ? (by === 1 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, cursor + by)));
  const next = () => go(cursor === null ? 0 : Math.min(order.length - 1, cursor + 1));

  const changeType = (to: DocType) => {
    if (to === type) return;
    setType(to);
    setSubtype(to === model.type ? model.subtype : ((SUBTYPES[to] as readonly string[])[0] ?? null));
    setMarks({});
    setDraft(null);
    setError(null);
    setCursor(FIELDS_BY_TYPE[to].length > 0 ? 0 : null);
  };

  const markOk = (k: FieldKey) => {
    setMarks((m) => (m[k] ? m : { ...m, [k]: { state: 'ok' } }));
    next();
  };
  const setNone = (k: FieldKey) => {
    const original = base.fields[k] ?? null;
    setMarks((m) => ({ ...m, [k]: original === null ? { state: 'ok' } : { state: 'fixed', value: null } }));
    next();
  };
  const startEdit = (k: FieldKey) => {
    setError(null);
    setDraft(toEntryText(k, valueOf(k)));
  };
  const commitEdit = (k: FieldKey) => {
    const parsed = parseEntry(k, draft ?? '');
    if (!parsed.ok) {
      setError(parsed.why);
      return;
    }
    const original = base.fields[k] ?? null;
    const same = JSON.stringify(parsed.value) === JSON.stringify(original);
    setMarks((m) => ({ ...m, [k]: same ? { state: 'ok' } : { state: 'fixed', value: parsed.value } }));
    setDraft(null);
    setError(null);
    next();
  };

  const send = async (body: Record<string, unknown>) => {
    const res = await fetch('/label/api/real', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `저장 실패(${res.status})`);
    return json;
  };

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    busyRef.current = true;
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : '저장 실패. 서버가 떠 있는지 봐 주세요.');
      setBusy(false);
    } finally {
      busyRef.current = false;
    }
  };

  const confirm = () =>
    run(async () => {
      const fields: Record<string, unknown> = {};
      for (const k of order) fields[k] = valueOf(k);
      const json = await send({ action: 'confirm', intakeId: intake.id, type, subtype, fields, seconds: Math.round(lookedMs() / 1000) });
      onConfirmed(json as unknown as Confirmed, { type, subtype, marks });
    });

  const skip = () =>
    run(async () => {
      const json = await send({ action: 'skip', intakeId: intake.id, note: '우리 양식에 없는 상품' });
      onSkipped(json.progress as ScreenProgress);
    });

  const finish = () => {
    if (unseen.length > 0) {
      go(order.indexOf(unseen[0] as FieldKey));
      setError(`아직 안 본 칸이 ${unseen.length}개 있습니다. 다 보거나 a 로 남은 칸을 모두 맞음으로 해 주세요.`);
      return;
    }
    const looked = tooFast(type, lookedMs());
    if (looked !== null && !askedFast) {
      setAskedFast(true);
      setError(`아직 ${looked}초밖에 안 봤습니다. 칸마다 원문을 보셨으면 한 번 더 누르세요.`);
      return;
    }
    void confirm();
  };

  const pressSkip = () => {
    if (skipArmed) void skip();
    else setSkipArmed(true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (draft !== null || busy) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.repeat && (e.key === 'Enter' || e.key === 'x')) {
        e.preventDefault();
        return;
      }
      if (e.key !== 'x') setSkipArmed(false);
      if (e.key === 'ArrowDown' || e.key === 'j') step(1);
      else if (e.key === 'ArrowUp' || e.key === 'k') step(-1);
      else if (e.key === 'Escape') setCursor(null);
      else if (e.key === 'o' || e.key === ' ') {
        if (current) markOk(current);
        else if (unseen[0]) go(order.indexOf(unseen[0]));
      } else if (e.key === 'e' && current) startEdit(current);
      else if (e.key === 'n' && current) setNone(current);
      else if (e.key === 'a') setMarks((m) => ({ ...Object.fromEntries(order.map((k) => [k, { state: 'ok' } as Mark])), ...m }));
      else if (e.key === 'Enter') finish();
      else if (e.key === 'x') pressSkip();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const moved = pointer.x !== e.clientX || pointer.y !== e.clientY;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      if (!moved || draft !== null) return;
      const key = (e.target as HTMLElement | null)?.closest?.('[data-field]')?.getAttribute('data-field');
      const at = key ? order.indexOf(key as FieldKey) : -1;
      if (at >= 0 && at !== cursor) setCursor(at);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  });

  const subtypeList = SUBTYPES[type] as readonly string[];

  const renderField = (k: FieldKey, i: number) => {
    const def = fieldDef(k);
    const mark = marks[k];
    const active = i === cursor;
    const value = valueOf(k);
    const wasNone = i >= filled;
    const hint = hintOf.get(k);
    const lost = found.missing[k] ?? [];
    const line = explainField(k, value, hint);
    const rule = FIELD_RULES[k];
    const guide = guideFor(k);
    const flagged = type === model.type && model.fields[k]?.flagged === true;
    const stateText = !mark ? '' : mark.state === 'ok' ? (wasNone ? '없음 맞음' : '맞음') : value === null ? '없음으로' : wasNone ? '값 넣음' : '고침';
    return (
      <li
        key={k}
        data-field={k}
        className={`${styles.field} ${wasNone && value === null ? styles.fieldNone : ''} ${active ? styles.active : ''} ${mark?.state === 'ok' ? styles.ok : ''} ${mark?.state === 'fixed' ? styles.fixed : ''}`}
        onClick={() => {
          if (draft === null) setCursor(i);
        }}
      >
        <div className={styles.fieldHead}>
          <span className={styles.label}>{def.label}</span>
          {flagged ? <span className={styles.badge}>모델 쪽 표시</span> : null}
          {wasNone && value === null ? <span className={styles.noneLine}>모델이 비운 칸 — 원문에 이 정보가 없는지 봐 주세요</span> : null}
          <span className={styles.state}>{stateText}</span>
          <span className={`${styles.actions} ${active && draft === null ? '' : styles.hidden}`}>
            <button type="button" tabIndex={active ? 0 : -1} onClick={() => markOk(k)}>
              {wasNone && value === null ? '없음 맞음 (o)' : '맞음 (o)'}
            </button>
            <button type="button" tabIndex={active ? 0 : -1} onClick={() => startEdit(k)}>
              {value === null ? '값 넣기 (e)' : '고침 (e)'}
            </button>
            {value === null ? null : (
              <button type="button" tabIndex={active ? 0 : -1} onClick={() => setNone(k)}>
                없음으로 (n)
              </button>
            )}
          </span>
        </div>
        {wasNone && value === null ? null : (
          <div className={styles.valueRow}>
            <span className={value === null ? styles.none : styles.value}>{showEntry(k, value)}</span>
            {hint ? <span className={styles.shown}>모델의 근거 {quote(hint.tokens)}</span> : null}
          </div>
        )}
        {line ? <div className={styles.convert}>↳ {line}</div> : null}
        {hint && lost.length > 0 ? <div className={styles.warn}>모델이 준 근거를 원문에서 글자 그대로 못 찾음 — 직접 찾아 주세요</div> : null}
        {!hint && !wasNone ? <div className={styles.warn}>모델이 근거를 주지 않은 칸 — 원문에서 직접 찾아 주세요</div> : null}
        {rule && !(wasNone && value === null) ? <div className={styles.rule}>{rule}</div> : null}
        {active && draft !== null ? (
          <form
            className={styles.edit}
            onSubmit={(e) => {
              e.preventDefault();
              commitEdit(k);
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setDraft(null);
                  setError(null);
                }
              }}
              placeholder={guide.example}
            />
            <span className={styles.muted}>
              {guide.how}. 보기: {guide.example} · 비우면 없음. Enter 저장, Esc 취소.
            </span>
          </form>
        ) : null}
      </li>
    );
  };

  return (
    <div className={styles.split}>
      <section className={styles.source}>
        <div className={styles.meta}>
          넣은 글 {intake.id} · {elapsed}초 · 밑줄 = 모델이 준 근거 구절{current ? ` · 지금 칸: ${tagOf(current)}` : ' · 칸을 고르면 그 근거가 진해집니다'}
        </div>
        <pre className={styles.content} ref={sourceRef}>
          {pieces.map((p) => {
            if (p.fields.length === 0) return <Fragment key={p.start}>{p.text}</Fragment>;
            const on = current !== undefined && p.fields.includes(current);
            const pick = p.ends[0] ?? p.fields[p.fields.length - 1];
            return (
              <Fragment key={p.start}>
                <span
                  className={`${styles.mark} ${on ? styles.markOn : ''}`}
                  data-on={on ? '1' : undefined}
                  onClick={() => {
                    const at = order.indexOf(pick as FieldKey);
                    if (at >= 0 && draft === null) go(at);
                  }}
                >
                  {p.text}
                </span>
                {p.ends.map((f) => (
                  <span key={f} className={`${styles.tag} ${f === current ? styles.tagOn : ''}`}>
                    {tagOf(f)}
                  </span>
                ))}
              </Fragment>
            );
          })}
        </pre>
      </section>

      <section className={styles.truth}>
        <div className={styles.kind}>
          <select value={type} onChange={(e) => changeType(e.target.value as DocType)} aria-label="종류">
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          {subtypeList.length > 0 ? (
            <select value={subtype ?? ''} onChange={(e) => setSubtype(e.target.value)} aria-label="갈래">
              {subtypeList.includes(subtype ?? '') ? null : <option value="">갈래를 고르세요</option>}
              {subtypeList.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          ) : null}
          <span className={styles.muted}>
            모델: {TYPE_LABELS[model.type]}
            {model.subtype ? ` · ${model.subtype}` : ''}
            {type !== model.type ? ' → 종류를 바꿨습니다. 칸을 처음부터 채웁니다.' : ''}
          </span>
        </div>

        {order.length === 0 ? <p>채울 칸이 없는 글입니다. 상품이 아닌 글(공지, 인사말)이 맞으면 Enter 로 “등록 대상 아님”인 정답으로 저장합니다.</p> : null}

        <div ref={listRef}>
          <ul className={styles.fields}>{order.slice(0, filled).map((k, i) => renderField(k, i))}</ul>
          {order.length > filled ? (
            <>
              <div className={styles.groupHead}>모델이 비운 칸 {order.length - filled}개 — 원문에 정보가 있으면 “값 넣기”</div>
              <ul className={styles.fields}>{order.slice(filled).map((k, i) => renderField(k, filled + i))}</ul>
            </>
          ) : null}
        </div>

        <div className={styles.footer}>
          {error ? <p className={styles.error}>{error}</p> : null}
          <div className={styles.footerRow}>
            <button type="button" className={styles.button} disabled={busy} onClick={finish}>
              정답으로 확정 (Enter)
            </button>
            <button type="button" className={skipArmed ? styles.danger : undefined} disabled={busy} onClick={pressSkip} title="우리 양식(광고 지면·케이터링·굿즈)에 없는 상품이면 정답 문서를 만들지 않고 넘깁니다">
              {skipArmed ? '정말 넘길까요? 한 번 더 x' : '우리 양식에 없는 상품 — 넘김 (x)'}
            </button>
            <span className={styles.muted}>남은 칸 {unseen.length}개 · a 남은 칸 모두 맞음</span>
          </div>
          <div className={styles.keys}>
            ↑↓ 또는 j/k 칸 옮기기 · o 맞음 · e 고침·값 넣기 · n 없음으로 · Esc 선택 풀기 · 상품이 아닌 글이면 종류를 “등록 대상 아님”으로 바꾸고 Enter
          </div>
        </div>
      </section>
    </div>
  );
}

interface OpenItem {
  id: string;
  sourceUrl: string;
}

interface Props {
  progress: ScreenProgress;
  open: OpenItem[];
  /** 주소에 ?id= 가 있으면 그 초안부터 연다(아직 확정하지 않은 것만). */
  start: ScreenIntake | null;
  today: string;
}

interface Last {
  intakeId: string;
  /** 확정이었으면 그 확인 기록 번호. 넘김이었으면 null */
  reviewId: string | null;
  label: string;
  state: ReviewState | null;
}

export default function RealClient({ progress: firstProgress, open: firstOpen, start, today }: Props) {
  const [progress, setProgress] = useState(firstProgress);
  const [open, setOpen] = useState(firstOpen);
  const [intake, setIntake] = useState<ScreenIntake | null>(start);
  const [initial, setInitial] = useState<ReviewState | null>(null);
  const [last, setLast] = useState<Last | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const childBusy = useRef(false);

  const [content, setContent] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [fetchedOn, setFetchedOn] = useState(today);
  const [kind, setKind] = useState<RealSourceKind>('page');

  const openIntake = useCallback(async (id: string) => {
    setError(null);
    const res = await fetch(`/label/api/real?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    const json = (await res.json().catch(() => ({}))) as { intake?: ScreenIntake; progress?: ScreenProgress; error?: string };
    if (!res.ok || !json.intake) {
      setError(json.error ?? '초안을 못 읽었습니다.');
      return;
    }
    if (json.progress) setProgress(json.progress);
    if (json.intake.status !== 'open') {
      setError(`이미 끝난 건입니다(${json.intake.goldDocId ?? '넘김'}).`);
      return;
    }
    setInitial(null);
    setIntake(json.intake);
  }, []);

  const fill = async () => {
    if (working) return;
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/label/api/real', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'draft', content, sourceUrl, fetchedOn, kind }),
      });
      const json = (await res.json().catch(() => ({}))) as { intake?: ScreenIntake; progress?: ScreenProgress; resumed?: boolean; error?: string };
      if (!res.ok || !json.intake) {
        setError(json.error ?? `초안을 못 채웠습니다(${res.status}).`);
        return;
      }
      if (json.progress) setProgress(json.progress);
      setNotice(json.resumed ? '같은 글의 초안이 이미 있어 그것을 엽니다(다시 부르지 않았습니다).' : json.intake.called ? '초안을 채웠습니다(실제 호출 1번).' : '초안을 채웠습니다(장부에 있던 답, 호출 없음).');
      setInitial(null);
      setIntake(json.intake);
      setContent('');
      setSourceUrl('');
    } catch {
      setError('초안을 못 채웠습니다. 서버가 떠 있는지 봐 주세요.');
    } finally {
      setWorking(false);
    }
  };

  const undo = useCallback(async () => {
    if (!last || working || childBusy.current) return;
    setWorking(true);
    try {
      const res = await fetch('/label/api/real', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'undo', intakeId: last.intakeId, ...(last.reviewId ? { reviewId: last.reviewId } : {}) }),
      });
      const json = (await res.json().catch(() => ({}))) as { intake?: ScreenIntake | null; progress?: ScreenProgress; error?: string };
      if (!res.ok) {
        setNotice(json.error ?? `되돌리기 실패(${res.status})`);
        if (res.status === 404 || res.status === 409) setLast(null);
        return;
      }
      if (json.progress) setProgress(json.progress);
      setNotice(`${last.label} 을(를) 되돌렸습니다. 다시 봐 주세요.`);
      setInitial(last.state);
      setIntake(json.intake ?? null);
      setLast(null);
    } catch {
      setNotice('되돌리기 실패. 서버가 떠 있는지 봐 주세요.');
    } finally {
      setWorking(false);
    }
  }, [last, working]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'u' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      void undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);

  const left = Math.max(0, progress.target - progress.saved);

  return (
    <main className={styles.review}>
      <header className={styles.bar}>
        <Link href="/label">← 처음으로</Link>
        <strong>실제 자료 넣기</strong>
        <span>
          {progress.saved} / {progress.target}건
        </span>
        <span className={styles.left}>
          남은 {left}건 · 넘김 {progress.skipped}건 · 초안만 있는 것 {progress.open}건
        </span>
        <span className={styles.muted}>
          실제 호출 {progress.calls} / {progress.cap}번 (${progress.costUsd.toFixed(4)})
        </span>
        <progress value={progress.saved} max={Math.max(1, progress.target)} />
        <button type="button" disabled={!last || working} onClick={() => void undo()} title="바로 앞에 한 확정이나 넘김을 지우고 그 건을 다시 봅니다">
          {last ? `방금 한 일 되돌리기 (u) — ${last.label}` : '방금 한 일 되돌리기 (u)'}
        </button>
      </header>
      <HonestNote />
      <p className={styles.muted}>지금까지: {tallyLine(progress.tally)}</p>
      {notice ? <p className={styles.noticeLine}>{notice}</p> : null}

      {intake ? (
        <RealReview
          key={`${intake.id}:${initial ? 'again' : 'first'}`}
          intake={intake}
          initial={initial}
          busyRef={childBusy}
          onConfirmed={(done, state) => {
            setProgress(done.progress);
            setOpen((list) => list.filter((o) => o.id !== intake.id));
            setLast({ intakeId: intake.id, reviewId: done.reviewId, label: `${done.docId} 확정`, state });
            setNotice(`${done.docId} 로 저장했습니다. 사람이 바꾼 것 ${done.changed}개.`);
            setIntake(null);
          }}
          onSkipped={(p) => {
            setProgress(p);
            setOpen((list) => list.filter((o) => o.id !== intake.id));
            setLast({ intakeId: intake.id, reviewId: null, label: `넣은 글 ${intake.id} 넘김`, state: null });
            setNotice('넘겼습니다. 출처 목록에는 “넘김”으로 남습니다.');
            setIntake(null);
          }}
        />
      ) : (
        <div className={styles.form}>
          <h2>1. 글과 출처를 넣는다</h2>
          <p className={styles.muted}>
            공개된 소개 글이나 단가표에서 <strong>상품 한 건</strong>에 해당하는 글을 붙여 넣습니다. 그림·PDF 는 글로 옮겨 적어 붙입니다. 4,000자까지(앱의 접수 상한과 같음). 원문은 저장소에
            넣지 않습니다(저장소 밖의 파일과 DB 에만 둡니다). 저장소에는 출처 주소·받은 날짜·종류만 남습니다.
          </p>
          <textarea className={styles.textarea} rows={14} value={content} onChange={(e) => setContent(e.target.value)} placeholder="여기에 원문을 붙여 넣습니다" aria-label="원문" />
          <div className={styles.formRow}>
            <label>
              출처 주소 <input className={styles.wide} value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://…" />
            </label>
            <label>
              받은 날짜 <input type="date" value={fetchedOn} onChange={(e) => setFetchedOn(e.target.value)} />
            </label>
            <label>
              원문의 꼴{' '}
              <select value={kind} onChange={(e) => setKind(e.target.value as RealSourceKind)}>
                {REAL_SOURCE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {SOURCE_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error ? <p className={styles.error}>{error}</p> : null}
          <div className={styles.footerRow}>
            <button type="button" className={styles.button} disabled={working || content.trim() === '' || sourceUrl.trim() === ''} onClick={() => void fill()}>
              {working ? '초안을 채우는 중…' : '초안 채우기 (실제 호출 1번)'}
            </button>
            <span className={styles.muted}>가장 작은 모델로 한 번 부릅니다. 같은 글을 다시 넣으면 다시 부르지 않습니다. 앱의 하루 상한과 따로 셉니다.</span>
          </div>

          {open.length > 0 ? (
            <>
              <h2>초안만 있고 아직 확정하지 않은 글</h2>
              <ul>
                {open.map((o) => (
                  <li key={o.id}>
                    <button type="button" onClick={() => void openIntake(o.id)}>
                      넣은 글 {o.id} 이어서 보기
                    </button>{' '}
                    <span className={styles.muted}>{o.sourceUrl}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      )}
    </main>
  );
}
