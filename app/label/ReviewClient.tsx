'use client';

// 정답 확인: 왼쪽 원문, 오른쪽 칸별 정답. 칸마다 "맞음 / 고침", 건마다 "확인 끝 / 이 건 버림".
// 키보드: ↑↓ 칸 옮기기, o 맞음, e 고침, n 없음으로, a 남은 칸 모두 맞음, Enter 확인 끝, x 두 번 버림.
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { GoldDoc } from '@/contract/eval-types';
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
import styles from './label.module.css';

interface QueueData {
  docs: GoldDoc[];
  total: number;
  done: number;
}

type Mark = { state: 'ok' } | { state: 'fixed'; value: FieldValue | null };

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

function DocReview({ doc, pass, onDone }: { doc: GoldDoc; pass: 1 | 2; onDone: () => void }) {
  const keys = FIELDS_BY_TYPE[doc.truth.type];
  const [marks, setMarks] = useState<Partial<Record<FieldKey, Mark>>>({});
  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subtype, setSubtype] = useState(doc.truth.subtype);
  const [dropArmed, setDropArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // 걸린 시간: 화면이 보이는 동안만 센다.
  const clock = useRef({ start: 0, hidden: 0, hiddenAt: null as number | null });

  const secondsNow = () => {
    const c = clock.current;
    const now = performance.now();
    const hidden = c.hidden + (c.hiddenAt === null ? 0 : now - c.hiddenAt);
    return Math.max(0, Math.round((now - c.start - hidden) / 1000));
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
    const tick = setInterval(() => setElapsed(secondsNow()), 1000);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(tick);
    };
  }, []);

  const valueOf = (k: FieldKey): FieldValue | null => {
    const m = marks[k];
    return m?.state === 'fixed' ? m.value : (doc.truth.fields[k] ?? null);
  };
  const current = keys[cursor];
  const unseen = keys.filter((k) => !marks[k]);

  const markOk = (k: FieldKey) => {
    setMarks((m) => (m[k] ? m : { ...m, [k]: { state: 'ok' } }));
    setCursor((c) => Math.min(keys.length - 1, c + 1));
  };
  const setNone = (k: FieldKey) => {
    const original = doc.truth.fields[k] ?? null;
    setMarks((m) => ({ ...m, [k]: original === null ? { state: 'ok' } : { state: 'fixed', value: null } }));
    setCursor((c) => Math.min(keys.length - 1, c + 1));
  };
  const startEdit = (k: FieldKey) => {
    setError(null);
    setDraft(toEditText(fieldDef(k).kind, valueOf(k)));
  };
  const commitEdit = (k: FieldKey) => {
    const parsed = parseEdit(k, draft ?? '');
    if (!parsed.ok) {
      setError('값의 꼴이 다르다. 보기처럼 적는다.');
      return;
    }
    const original = doc.truth.fields[k] ?? null;
    const same = JSON.stringify(parsed.value) === JSON.stringify(original);
    setMarks((m) => ({ ...m, [k]: same ? { state: 'ok' } : { state: 'fixed', value: parsed.value } }));
    setDraft(null);
    setError(null);
    setCursor((c) => Math.min(keys.length - 1, c + 1));
  };

  const submit = async (drop: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const fixes: Record<string, unknown> = {};
    for (const k of keys) {
      const m = marks[k];
      if (m?.state === 'fixed') fixes[k] = m.value;
    }
    try {
      const res = await fetch('/label/api/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: doc.id, pass, drop, fixes, ...(subtype !== doc.truth.subtype && subtype ? { subtype } : {}), seconds: secondsNow() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `저장 실패(${res.status})`);
        setBusy(false);
        return;
      }
      onDone();
    } catch {
      setError('저장 실패. 서버가 떠 있는지 본다.');
      setBusy(false);
    }
  };

  const finish = () => {
    if (unseen.length > 0) {
      setCursor(keys.indexOf(unseen[0] as FieldKey));
      setError(`아직 안 본 칸이 ${unseen.length}개 있다. 다 보거나 a 로 남은 칸을 모두 맞음으로 한다.`);
      return;
    }
    void submit(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (draft !== null || busy) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'x') setDropArmed(false);
      if (e.key === 'ArrowDown' || e.key === 'j') setCursor((c) => Math.min(keys.length - 1, c + 1));
      else if (e.key === 'ArrowUp' || e.key === 'k') setCursor((c) => Math.max(0, c - 1));
      else if ((e.key === 'o' || e.key === ' ') && current) markOk(current);
      else if (e.key === 'e' && current) startEdit(current);
      else if (e.key === 'n' && current) setNone(current);
      else if (e.key === 'a') setMarks((m) => ({ ...Object.fromEntries(keys.map((k) => [k, { state: 'ok' } as Mark])), ...m }));
      else if (e.key === 'Enter') finish();
      else if (e.key === 'x') {
        if (dropArmed) void submit(true);
        else setDropArmed(true);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const subtypeList = SUBTYPES[doc.truth.type] as readonly string[];

  return (
    <div className={styles.split}>
      <section className={styles.source}>
        <div className={styles.meta}>
          {doc.id} · {elapsed}초
        </div>
        <pre className={styles.content}>{doc.content}</pre>
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
          <span className={styles.muted}>종류가 틀렸으면 이 건을 버린다.</span>
        </div>

        {keys.length === 0 ? <p>채울 칸이 없는 글이다. 등록 대상이 아닌 글이 맞으면 Enter.</p> : null}

        <ul className={styles.fields}>
          {keys.map((k, i) => {
            const def = fieldDef(k);
            const mark = marks[k];
            const active = i === cursor;
            return (
              <li
                key={k}
                className={`${styles.field} ${active ? styles.active : ''} ${mark?.state === 'ok' ? styles.ok : ''} ${mark?.state === 'fixed' ? styles.fixed : ''}`}
                onClick={() => setCursor(i)}
              >
                <div className={styles.fieldHead}>
                  <span className={styles.label}>{def.label}</span>
                  <span className={styles.state}>{mark?.state === 'ok' ? '맞음' : mark?.state === 'fixed' ? '고침' : ''}</span>
                </div>
                <div className={valueOf(k) === null ? styles.none : styles.value}>{showValue(def.kind, valueOf(k))}</div>
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
                      {def.kind === 'text' ? '글자 그대로 적는다.' : `보기: ${EXAMPLES[def.kind]}`} 비우면 없음. Enter 저장, Esc 취소.
                    </span>
                  </form>
                ) : active ? (
                  <div className={styles.actions}>
                    <button type="button" onClick={() => markOk(k)}>
                      맞음 (o)
                    </button>
                    <button type="button" onClick={() => startEdit(k)}>
                      고침 (e)
                    </button>
                    <button type="button" onClick={() => setNone(k)}>
                      없음으로 (n)
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        {error ? <p className={styles.error}>{error}</p> : null}
        <div className={styles.footer}>
          <button type="button" className={styles.button} disabled={busy} onClick={finish}>
            확인 끝 (Enter)
          </button>
          <button type="button" disabled={busy} onClick={() => (dropArmed ? void submit(true) : setDropArmed(true))}>
            {dropArmed ? '한 번 더 누르면 버린다 (x)' : '이 건 버림 (x)'}
          </button>
          <span className={styles.muted}>남은 칸 {unseen.length}개 · a 남은 칸 모두 맞음</span>
        </div>
      </section>
    </div>
  );
}

export default function ReviewClient({ query, pass, title }: { query: string; pass: 1 | 2; title: string }) {
  const [queue, setQueue] = useState<QueueData | null>(null);
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);

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
        setFailed(null);
      })
      .catch(() => {
        if (alive) setFailed('문서 줄을 못 읽었다.');
      });
    return () => {
      alive = false;
    };
  }, [query, round]);

  if (failed) return <main className={styles.home}>{failed}</main>;
  if (!queue) return <main className={styles.home}>읽는 중…</main>;

  const doc = queue.docs[index];
  const doneNow = queue.done + index;
  const left = queue.total - doneNow;

  return (
    <main className={styles.review}>
      <header className={styles.bar}>
        <Link href="/label">← 처음으로</Link>
        <strong>{title}</strong>
        <span>
          {doneNow} / {queue.total}건 · 이번 묶음 {Math.min(index + 1, queue.docs.length)} / {queue.docs.length}
        </span>
        <progress value={doneNow} max={Math.max(1, queue.total)} />
      </header>
      {doc ? (
        <DocReview key={doc.id} doc={doc} pass={pass} onDone={() => setIndex((i) => i + 1)} />
      ) : (
        <div className={styles.home}>
          <p>{queue.docs.length === 0 ? '볼 문서가 없다.' : `이번 묶음 ${queue.docs.length}건을 다 봤다.`}</p>
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
