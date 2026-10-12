'use client';

// 정답 확인: 왼쪽 원문, 오른쪽 칸별 정답. 칸마다 "맞음 / 고침", 건마다 "확인 끝 / 이 건 버림".
// 칸을 고르면(키보드로 옮기거나 마우스를 올리면) 그 칸의 표기 조각이 원문에서 진하게 보이고, 화면 밖이면 그 자리로 간다.
// 키보드: ↑↓(j/k) 칸 옮기기, o 맞음, e 고침, n 없음으로, a 남은 칸 모두 맞음, Enter 확인 끝, x 두 번 버림, Esc 선택 풀기, u 방금 판정 되돌리기.
// 잘못 누름 막기: 버림은 두 번 눌러야 되고, 연 지 몇 초 안 된 문서의 "확인 끝"은 한 번 되묻는다. 키를 누르고 있어서 생기는 되풀이는 받지 않는다.
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { GoldDoc, GoldTruth } from '@/contract/eval-types';
import {
  FIELDS_BY_TYPE,
  SUBTYPES,
  TYPE_LABELS,
  fieldDef,
  parseFieldValue,
  type FieldKey,
  type FieldKind,
  type FieldValue,
} from '@/contract/fields';
import { FIELD_RULES, explainField } from '@/gold/explain';
import type { FieldHint } from '@/gold/hints';
import { cutPieces, findSpans } from '@/gold/marks';
import { dropOne, etaMinutes, putBack, tooFast } from '@/gold/pace';
import styles from './label.module.css';

interface QueueData {
  docs: GoldDoc[];
  total: number;
  done: number;
  /** 문서 번호 → 칸별 표기 조각. 표기 지시 파일이 없으면 비어 있다. */
  hints?: Record<string, FieldHint[]>;
  /** 지금까지 건마다 걸린 초 */
  seconds?: number[];
}

/** 방금 끝낸 판정. 되돌리기에 쓴다. */
interface Done {
  reviewId: string;
  before: GoldTruth | null;
  verdict: string;
  seconds: number;
}

type Mark = { state: 'ok' } | { state: 'fixed'; value: FieldValue | null };

const VERDICT_LABELS: Record<string, string> = { ok: '맞음', fixed: '고침', dropped: '버림' };
/** 버림을 한 번 누른 뒤 이만큼 지나면 없던 일이 된다. */
const DROP_CONFIRM_MS = 2000;

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;

/** 표준 값을 사람이 읽기 쉽게. */
function showValue(kind: FieldKind, value: unknown): string {
  if (value === null || value === undefined) return '없음';
  const v = value as Record<string, unknown>;
  switch (kind) {
    case 'money':
      return won(value as number);
    case 'bool':
      return value ? '포함' : '별도';
    case 'count':
    case 'days':
    case 'footfall':
      return (value as number).toLocaleString('ko-KR');
    case 'size_m':
      return `가로 ${v.width} × 세로 ${v.height} m`;
    case 'size_mm':
      return `가로 ${v.width} × 세로 ${v.height} mm`;
    case 'resolution':
      return `${v.width} × ${v.height} px`;
    case 'hours':
      return `${v.open} ~ ${v.close}${v.nextDay ? ' (끝이 다음 날)' : ''}`;
    case 'period_options':
      return (value as { days: number; price_krw: number }[]).map((o) => `${o.days}일 ${won(o.price_krw)}`).join(' / ');
    case 'quantity_options':
      return (value as { qty: number; price_krw: number }[]).map((o) => `${o.qty}개 ${won(o.price_krw)}`).join(' / ');
    case 'formats':
      return (value as string[]).join(', ');
    default:
      return String(value);
  }
}

const EXAMPLES: Partial<Record<FieldKind, string>> = {
  money: '1500000',
  bool: 'true 또는 false',
  count: '15',
  days: '7',
  footfall: '100000',
  size_m: '{"width":8,"height":4.5}',
  size_mm: '{"width":55,"height":85}',
  resolution: '{"width":1920,"height":1080}',
  hours: '{"open":"05:00","close":"01:00","nextDay":true}',
  period_options: '[{"days":7,"price_krw":1500000}]',
  quantity_options: '[{"qty":100,"price_krw":450000}]',
  formats: '["jpg","mp4"]',
};

const toEditText = (kind: FieldKind, value: unknown) => (value === null || value === undefined ? '' : kind === 'text' ? String(value) : JSON.stringify(value));

/** 입력한 글을 표준 값으로. 비우면 "없음". */
function parseEdit(key: FieldKey, text: string): { ok: true; value: FieldValue | null } | { ok: false } {
  const t = text.trim();
  if (t === '' || t === '없음' || t === 'null') return { ok: true, value: null };
  if (fieldDef(key).kind === 'text') return { ok: true, value: t };
  let raw: unknown;
  try {
    raw = JSON.parse(/^[\d,]+$/.test(t) ? t.replace(/,/g, '') : t);
  } catch {
    return { ok: false };
  }
  return parseFieldValue(key, raw);
}

/** 꼬리표에 적는 짧은 칸 이름. "판매가(원)" → "판매가" */
/**
 * 마우스가 마지막으로 있던 자리. 문서가 바뀌어도 이어 쓴다.
 * 목록이 움직이거나 새 문서가 뜨면 브라우저가 "움직임"을 알리는데, 그때는 자리가 그대로다. 자리가 바뀐 진짜 움직임에만 칸을 고른다.
 */
const pointer = { x: -1, y: -1 };

const tagOf = (key: string) => fieldDef(key as FieldKey).label.replace(/\(.*\)$/, '');
const quote = (tokens: readonly string[]) => tokens.map((t) => `“${t.replace(/\t/g, ' ⇥ ')}”`).join(' · ');

interface DocReviewProps {
  doc: GoldDoc;
  pass: 1 | 2;
  /** 이 문서의 칸별 표기. 정보가 없으면 null(강조 없이 돈다). */
  hints: FieldHint[] | null;
  /** 저장하는 동안 true. 그동안에는 되돌리기를 받지 않는다. */
  busyRef: RefObject<boolean>;
  onDone: (done: Done) => void;
}

/** 문서 한 건의 확인 화면. 시험이 그려 볼 수 있게 내보낸다. */
export function DocReview({ doc, pass, hints, busyRef, onDone }: DocReviewProps) {
  // 값이 있는 칸을 위로, "없음"인 칸을 아래 묶음으로. 보는 동안 차례가 바뀌지 않게 처음 정답으로 정한다.
  const { order, filled } = useMemo(() => {
    const all = FIELDS_BY_TYPE[doc.truth.type];
    const has = (k: FieldKey) => (doc.truth.fields[k] ?? null) !== null;
    const withValue = all.filter(has);
    return { order: [...withValue, ...all.filter((k) => !has(k))], filled: withValue.length };
  }, [doc]);

  const [marks, setMarks] = useState<Partial<Record<FieldKey, Mark>>>({});
  /** 고른 칸의 차례. null 이면 아무 칸도 안 고른 것(모든 칸의 조각을 옅게 보인다). */
  const [cursor, setCursor] = useState<number | null>(order.length > 0 ? 0 : null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subtype, setSubtype] = useState(doc.truth.subtype);
  const [dropArmed, setDropArmed] = useState(false);
  /** 너무 빨리 "확인 끝"을 눌러 한 번 되물었는가. 문서마다 한 번만 묻는다. */
  const [askedFast, setAskedFast] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // 걸린 시간: 화면이 보이는 동안만 센다.
  const clock = useRef({ start: 0, hidden: 0, hiddenAt: null as number | null });
  const sourceRef = useRef<HTMLPreElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** 키보드로 칸을 옮겼을 때만 칸 목록을 따라 움직인다(마우스를 올렸을 때 목록이 움직이면 다른 칸이 잡힌다). */
  const followList = useRef(false);

  /** 이 문서를 본 시간(ms). 화면이 가려져 있던 동안은 뺀다. */
  const lookedMs = () => {
    const c = clock.current;
    const now = performance.now();
    const hidden = c.hidden + (c.hiddenAt === null ? 0 : now - c.hiddenAt);
    return Math.max(0, now - c.start - hidden);
  };
  const secondsNow = () => Math.round(lookedMs() / 1000);

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

  // 버림은 한 번 더 눌러야 된다. 잠깐 지나면 없던 일로 한다.
  useEffect(() => {
    if (!dropArmed) return;
    const timer = setTimeout(() => setDropArmed(false), DROP_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [dropArmed]);

  const hintOf = useMemo(() => new Map((hints ?? []).map((h) => [h.field, h])), [hints]);
  const found = useMemo(() => findSpans(doc.content, hints ?? []), [doc.content, hints]);
  const pieces = useMemo(() => cutPieces(doc.content, found.spans), [doc.content, found]);

  const valueOf = (k: FieldKey): FieldValue | null => {
    const m = marks[k];
    return m?.state === 'fixed' ? m.value : (doc.truth.fields[k] ?? null);
  };
  const current = cursor === null ? undefined : order[cursor];
  const unseen = order.filter((k) => !marks[k]);

  // 고른 칸의 조각이 원문 칸에서 안 보이면 그 자리로 간다.
  useEffect(() => {
    const box = sourceRef.current;
    const first = current ? box?.querySelector<HTMLElement>('[data-on="1"]') : null;
    if (!box || !first) return;
    const b = box.getBoundingClientRect();
    const r = first.getBoundingClientRect();
    if (r.top < b.top + 4 || r.bottom > b.bottom - 4) box.scrollTo({ top: box.scrollTop + (r.top - b.top) - box.clientHeight / 3, behavior: 'smooth' });
  }, [current, pieces]);

  // 키보드로 옮긴 칸이 화면 밖이면 칸 목록도 따라간다.
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

  const markOk = (k: FieldKey) => {
    setMarks((m) => (m[k] ? m : { ...m, [k]: { state: 'ok' } }));
    next();
  };
  const setNone = (k: FieldKey) => {
    const original = doc.truth.fields[k] ?? null;
    setMarks((m) => ({ ...m, [k]: original === null ? { state: 'ok' } : { state: 'fixed', value: null } }));
    next();
  };
  const startEdit = (k: FieldKey) => {
    setError(null);
    setDraft(toEditText(fieldDef(k).kind, valueOf(k)));
  };
  const commitEdit = (k: FieldKey) => {
    const parsed = parseEdit(k, draft ?? '');
    if (!parsed.ok) {
      setError('값의 꼴이 다릅니다. 보기처럼 적어 주세요.');
      return;
    }
    const original = doc.truth.fields[k] ?? null;
    const same = JSON.stringify(parsed.value) === JSON.stringify(original);
    setMarks((m) => ({ ...m, [k]: same ? { state: 'ok' } : { state: 'fixed', value: parsed.value } }));
    setDraft(null);
    setError(null);
    next();
  };

  const submit = async (drop: boolean) => {
    if (busy) return;
    setBusy(true);
    busyRef.current = true;
    setError(null);
    const fixes: Record<string, unknown> = {};
    for (const k of order) {
      const m = marks[k];
      if (m?.state === 'fixed') fixes[k] = m.value;
    }
    const seconds = secondsNow();
    try {
      const res = await fetch('/label/api/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: doc.id, pass, drop, fixes, ...(subtype !== doc.truth.subtype && subtype ? { subtype } : {}), seconds }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; verdict?: string; reviewId?: string; before?: GoldTruth | null };
      if (!res.ok) {
        setError(body.error ?? `저장 실패(${res.status})`);
        setBusy(false);
        busyRef.current = false;
        return;
      }
      busyRef.current = false;
      onDone({ reviewId: body.reviewId ?? '', before: body.before ?? null, verdict: body.verdict ?? (drop ? 'dropped' : 'ok'), seconds });
    } catch {
      setError('저장 실패. 서버가 떠 있는지 봐 주세요.');
      setBusy(false);
      busyRef.current = false;
    }
  };

  const finish = () => {
    if (unseen.length > 0) {
      go(order.indexOf(unseen[0] as FieldKey));
      setError(`아직 안 본 칸이 ${unseen.length}개 있습니다. 다 보거나 a 로 남은 칸을 모두 맞음으로 해 주세요.`);
      return;
    }
    // 연 지 몇 초 안 됐으면 바로 넘기지 않고 한 번 되묻는다. 한 번 더 누르면 넘어간다.
    const looked = tooFast(doc.truth.type, lookedMs());
    if (looked !== null && !askedFast) {
      setAskedFast(true);
      setError(`아직 ${looked}초밖에 안 봤습니다. 칸을 다 보셨으면 한 번 더 누르세요.`);
      return;
    }
    void submit(false);
  };

  const pressDrop = () => {
    if (dropArmed) void submit(true);
    else setDropArmed(true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (draft !== null || busy) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      // 키를 누르고 있어서 되풀이되는 입력으로는 넘기거나 버리지 않는다.
      if (e.repeat && (e.key === 'Enter' || e.key === 'x')) {
        e.preventDefault();
        return;
      }
      if (e.key !== 'x') setDropArmed(false);
      if (e.key === 'ArrowDown' || e.key === 'j') step(1);
      else if (e.key === 'ArrowUp' || e.key === 'k') step(-1);
      else if (e.key === 'Escape') setCursor(null);
      else if (e.key === 'o' || e.key === ' ') {
        // 아무 칸도 안 골랐으면 아직 안 본 첫 칸을 고르기만 한다.
        if (current) markOk(current);
        else if (unseen[0]) go(order.indexOf(unseen[0]));
      } else if (e.key === 'e' && current) startEdit(current);
      else if (e.key === 'n' && current) setNone(current);
      else if (e.key === 'a') setMarks((m) => ({ ...Object.fromEntries(order.map((k) => [k, { state: 'ok' } as Mark])), ...m }));
      else if (e.key === 'Enter') finish();
      else if (e.key === 'x') pressDrop();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 마우스를 칸 위에 올리면 그 칸을 고른다.
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

  const subtypeList = SUBTYPES[doc.truth.type] as readonly string[];

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
    const buttons = (
      <span className={`${styles.actions} ${active && draft === null ? '' : styles.hidden}`}>
        <button type="button" tabIndex={active ? 0 : -1} onClick={() => markOk(k)}>
          맞음 (o)
        </button>
        <button type="button" tabIndex={active ? 0 : -1} onClick={() => startEdit(k)}>
          고침 (e)
        </button>
        <button type="button" tabIndex={active ? 0 : -1} onClick={() => setNone(k)}>
          없음으로 (n)
        </button>
      </span>
    );
    return (
      <li
        key={k}
        data-field={k}
        className={`${styles.field} ${wasNone ? styles.fieldNone : ''} ${active ? styles.active : ''} ${mark?.state === 'ok' ? styles.ok : ''} ${mark?.state === 'fixed' ? styles.fixed : ''}`}
        onClick={() => {
          if (draft === null) setCursor(i);
        }}
      >
        <div className={styles.fieldHead}>
          <span className={styles.label}>{def.label}</span>
          {wasNone && value === null ? <span className={styles.noneLine}>없음 — 이 칸의 정보가 원문에 없어야 맞습니다</span> : null}
          <span className={styles.state}>{mark?.state === 'ok' ? '맞음' : mark?.state === 'fixed' ? '고침' : ''}</span>
          {buttons}
        </div>
        {wasNone && value === null ? null : (
          <div className={styles.valueRow}>
            <span className={value === null ? styles.none : styles.value}>{showValue(def.kind, value)}</span>
            {hint ? <span className={styles.shown}>원문 표기 {quote(hint.tokens)}</span> : null}
          </div>
        )}
        {line ? <div className={styles.convert}>↳ {line}</div> : null}
        {hints && hint && lost.length > 0 ? (
          <div className={styles.warn}>
            {lost.length === hint.tokens.length ? '표기를 원문에서 못 찾음 — 직접 찾아 주세요' : `표기 ${quote(lost)} 를 원문에서 못 찾음 — 직접 찾아 주세요`}
          </div>
        ) : null}
        {hints && !hint && value !== null ? <div className={styles.warn}>정해 둔 표기가 없는 칸 — 원문에서 직접 찾아 주세요</div> : null}
        {hint && wasNone ? <div className={styles.warn}>정답은 없음인데 정해 둔 표기({quote(hint.tokens)})가 있습니다 — 원문을 봐 주세요</div> : null}
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
              placeholder={EXAMPLES[def.kind] ?? '글자 그대로'}
            />
            <span className={styles.muted}>
              {def.kind === 'text' ? '글자 그대로 적습니다.' : `보기: ${EXAMPLES[def.kind]}`} 비우면 없음. Enter 저장, Esc 취소.
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
          {doc.id} · {elapsed}초
          {hints ? (
            <span> · 밑줄 = 칸마다 정해 둔 표기{current ? ` · 지금 칸: ${tagOf(current)}` : ' · 칸을 고르면 그 표기가 진해집니다'}</span>
          ) : (
            <span> · 이 문서는 표기 정보가 없어 강조 없이 보입니다</span>
          )}
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
          <strong>{TYPE_LABELS[doc.truth.type]}</strong>
          {subtypeList.length > 0 ? (
            <select value={subtype ?? ''} onChange={(e) => setSubtype(e.target.value)} aria-label="갈래">
              {subtypeList.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          ) : null}
          <span className={styles.muted}>종류가 틀렸으면 이 건을 버립니다.</span>
        </div>

        {order.length === 0 ? <p>채울 칸이 없는 글입니다. 등록 대상이 아닌 글이 맞으면 Enter.</p> : null}

        <div ref={listRef}>
          <ul className={styles.fields}>{order.slice(0, filled).map((k, i) => renderField(k, i))}</ul>
          {order.length > filled ? (
            <>
              <div className={styles.groupHead}>없음 {order.length - filled}칸 — 원문에 이 정보가 없는지만 보면 됩니다</div>
              <ul className={styles.fields}>{order.slice(filled).map((k, i) => renderField(k, filled + i))}</ul>
            </>
          ) : null}
        </div>

        <div className={styles.footer}>
          {error ? <p className={styles.error}>{error}</p> : null}
          <div className={styles.footerRow}>
            <button type="button" className={styles.button} disabled={busy} onClick={finish}>
              확인 끝 (Enter)
            </button>
            <button type="button" className={dropArmed ? styles.danger : undefined} disabled={busy} onClick={pressDrop}>
              {dropArmed ? '정말 버릴까요? 한 번 더 x' : '이 건 버림 (x)'}
            </button>
            <span className={styles.muted}>남은 칸 {unseen.length}개 · a 남은 칸 모두 맞음</span>
          </div>
          <div className={styles.keys}>↑↓ 또는 j/k 칸 옮기기 · o 맞음 · e 고침 · n 없음으로 · Esc 선택 풀기 · u 방금 판정 되돌리기</div>
        </div>
      </section>
    </div>
  );
}

export default function ReviewClient({ query, pass, title }: { query: string; pass: 1 | 2; title: string }) {
  const [queue, setQueue] = useState<QueueData | null>(null);
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  /** 이번 묶음에서 건마다 걸린 초(서버가 준 목록 뒤에 잇는다) */
  const [session, setSession] = useState<number[]>([]);
  /** 바로 앞 문서의 판정. 되돌리기는 이것 하나만 된다. */
  const [last, setLast] = useState<(Done & { doc: GoldDoc }) | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const childBusy = useRef(false);

  // round 가 바뀌면 다음 묶음을 읽는다.
  const [round, setRound] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch(`/label/api/queue?${query}`, { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<QueueData>) : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (!alive) return;
        setQueue(data);
        setIndex(0);
        setSession([]);
        setFailed(null);
      })
      .catch(() => {
        if (alive) setFailed('문서 줄을 못 읽었습니다.');
      });
    return () => {
      alive = false;
    };
  }, [query, round]);

  const undo = useCallback(async () => {
    if (!last || !queue || undoing || childBusy.current) return;
    setUndoing(true);
    try {
      const res = await fetch('/label/api/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: last.doc.id, reviewId: last.reviewId, ...(last.before ? { before: last.before } : {}) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice(body.error ?? `되돌리기 실패(${res.status})`);
        if (res.status === 404 || res.status === 409) setLast(null);
        return;
      }
      // 되돌린 문서를 지금 자리에 다시 놓는다.
      const back = putBack(queue, index, last.doc, last.seconds);
      setQueue(back.queue);
      setIndex(back.index);
      if (back.sameBatch) setSession((s) => dropOne(s, last.seconds));
      setNotice(`${last.doc.id} 의 판정(${VERDICT_LABELS[last.verdict] ?? last.verdict})을 되돌렸습니다. 다시 확인해 주세요.`);
      setLast(null);
    } catch {
      setNotice('되돌리기 실패. 서버가 떠 있는지 봐 주세요.');
    } finally {
      setUndoing(false);
    }
  }, [last, queue, undoing, index]);

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

  if (failed) return <main className={styles.home}>{failed}</main>;
  if (!queue) return <main className={styles.home}>읽는 중…</main>;

  const doc = queue.docs[index];
  const doneNow = queue.done + index;
  const left = Math.max(0, queue.total - doneNow);
  const eta = etaMinutes([...(queue.seconds ?? []), ...session], left);
  const etaText = eta === null ? '예상 시간은 한 건 본 뒤부터 나옵니다' : `지금 속도로 약 ${eta}분`;

  return (
    <main className={styles.review}>
      <header className={styles.bar}>
        <Link href="/label">← 처음으로</Link>
        <strong>{title}</strong>
        <span>
          {doneNow} / {queue.total}건
        </span>
        <span className={styles.left}>
          남은 {left}건 · {etaText}
        </span>
        <span className={styles.muted}>
          이번 묶음 {Math.min(index + 1, queue.docs.length)} / {queue.docs.length}
        </span>
        <progress value={doneNow} max={Math.max(1, queue.total)} />
        <button type="button" disabled={!last || undoing} onClick={() => void undo()} title="바로 앞 문서의 판정을 지우고 그 문서를 다시 봅니다">
          {last ? `방금 판정 되돌리기 (u) — ${last.doc.id} ${VERDICT_LABELS[last.verdict] ?? ''}` : '방금 판정 되돌리기 (u)'}
        </button>
      </header>
      {notice ? <p className={styles.noticeLine}>{notice}</p> : null}
      {doc ? (
        <DocReview
          key={doc.id}
          doc={doc}
          pass={pass}
          hints={queue.hints?.[doc.id] ?? null}
          busyRef={childBusy}
          onDone={(done) => {
            setLast({ ...done, doc });
            setSession((s) => [...s, done.seconds]);
            setNotice(null);
            setIndex((i) => i + 1);
          }}
        />
      ) : (
        <div className={styles.home}>
          {queue.docs.length === 0 ? (
            <p>볼 문서가 없습니다.</p>
          ) : left > 0 ? (
            <p className={styles.rest}>
              {queue.docs.length}건 끝. 쉬었다 하세요 — 남은 {left}건, {etaText}
            </p>
          ) : (
            <p className={styles.rest}>{queue.total}건을 모두 확인했습니다. 수고하셨습니다.</p>
          )}
          {left > 0 && queue.docs.length > 0 ? (
            <button type="button" className={styles.button} onClick={() => setRound((n) => n + 1)}>
              다음 묶음 ({left}건 남음)
            </button>
          ) : (
            <Link className={styles.button} href="/label">
              처음으로
            </Link>
          )}
        </div>
      )}
    </main>
  );
}
