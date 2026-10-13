'use client';

// 손글 쓰기: 사람이 원문을 직접 쓰고(빈 칸에서), 정답 칸도 직접 채운다. 모델의 초안을 보여 주지 않는다.
// 종류를 고르면 그 종류의 칸만 나온다. 칸마다 값의 꼴 안내와, 적은 글을 어떻게 읽었는지가 바로 보인다.
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GoldDoc } from '@/contract/eval-types';
import { DOC_TYPES, FIELDS_BY_TYPE, SUBTYPES, TYPE_LABELS, fieldDef, type DocType, type FieldKey } from '@/contract/fields';
import { HAND_TRAP_TIPS, guideFor, parseEntry, showEntry, toEntryText } from '@/gold/entry';
import { FIELD_RULES } from '@/gold/explain';
import styles from '../label.module.css';

interface HandItem {
  id: string;
  type: string;
  chars: number;
  traps: string[];
}

interface FormState {
  id: string | null;
  type: DocType | null;
  subtype: string | null;
  content: string;
  /** 칸 이름 → 사람이 적은 글 */
  texts: Partial<Record<FieldKey, string>>;
  tipIds: string[];
}

const EMPTY: FormState = { id: null, type: null, subtype: null, content: '', texts: {}, tipIds: [] };

/** 저장한 문서를 다시 입력 칸에 놓는다. 함정 귀띔은 꼬리표가 같은 것을 고른 것으로 친다(어느 귀띔이었는지는 남기지 않는다). */
export function formFromDoc(doc: GoldDoc): FormState {
  const texts: FormState['texts'] = {};
  for (const k of FIELDS_BY_TYPE[doc.truth.type]) texts[k] = toEntryText(k, doc.truth.fields[k] ?? null);
  const tipIds = doc.traps.map((trap) => HAND_TRAP_TIPS.find((t) => t.trap === trap)?.id).filter((id): id is string => id !== undefined);
  return { id: doc.id, type: doc.truth.type, subtype: doc.truth.subtype, content: doc.content, texts, tipIds };
}

interface FormProps {
  form: FormState;
  onChange: (next: FormState) => void;
}

/** 입력 칸들. 시험이 그려 볼 수 있게 내보낸다. */
export function HandForm({ form, onChange }: FormProps) {
  const set = (patch: Partial<FormState>) => onChange({ ...form, ...patch });
  const fields = form.type ? FIELDS_BY_TYPE[form.type] : [];
  const subtypeList = form.type ? (SUBTYPES[form.type] as readonly string[]) : [];

  return (
    <div className={styles.split}>
      <section className={`${styles.source} ${styles.scrollable}`}>
        <div className={styles.meta}>원문 — 공급처가 보낸 글처럼 직접 씁니다. 지어낸 이름을 씁니다(실제 회사·사람 이름을 쓰지 않습니다).</div>
        <textarea
          className={styles.textarea}
          rows={16}
          value={form.content}
          onChange={(e) => set({ content: e.target.value })}
          placeholder={'예) 안녕하세요, ○○미디어입니다.\n△△역 3번 출구 전광판 단가 안내드립니다…'}
          aria-label="원문"
        />
        <details className={styles.tips} open>
          <summary>넣어 볼 만한 함정 (고르는 것이지 꼭 넣는 것이 아닙니다)</summary>
          {HAND_TRAP_TIPS.map((t) => (
            <label key={t.id}>
              <input
                type="checkbox"
                checked={form.tipIds.includes(t.id)}
                onChange={(e) => set({ tipIds: e.target.checked ? [...form.tipIds, t.id] : form.tipIds.filter((x) => x !== t.id) })}
              />{' '}
              <strong>{t.label}</strong> — {t.tip}
            </label>
          ))}
          <p className={styles.muted}>고른 것은 이 문서의 함정 꼬리표로 남습니다. 글에 실제로 넣은 것만 고릅니다.</p>
        </details>
      </section>

      <section className={styles.truth}>
        <div className={styles.meta}>정답 — 종류를 고르면 그 종류의 칸만 나옵니다. 원문에 없는 정보의 칸은 비워 둡니다(없음).</div>
        <div className={styles.choice}>
          {DOC_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className={form.type === t ? styles.chosen : undefined}
              onClick={() => set({ type: t, subtype: (SUBTYPES[t] as readonly string[]).includes(form.subtype ?? '') ? form.subtype : null })}
            >
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        {subtypeList.length > 0 ? (
          <div className={styles.choice}>
            {subtypeList.map((s) => (
              <button key={s} type="button" className={form.subtype === s ? styles.chosen : undefined} onClick={() => set({ subtype: s })}>
                {s}
              </button>
            ))}
          </div>
        ) : null}
        {form.type === 'not_product' ? <p className={styles.muted}>등록 대상이 아닌 글은 채울 칸이 없습니다. 원문만 쓰고 저장합니다.</p> : null}
        {form.type === null ? <p className={styles.muted}>먼저 종류를 고릅니다.</p> : null}

        {fields.map((k) => {
          const def = fieldDef(k);
          const guide = guideFor(k);
          const text = form.texts[k] ?? '';
          const parsed = parseEntry(k, text);
          const filled = parsed.ok && parsed.value !== null;
          const rule = FIELD_RULES[k];
          return (
            <div key={k} data-field={k} className={`${styles.entry} ${!parsed.ok ? styles.entryBad : filled ? styles.entryFilled : ''}`}>
              <label>
                <span className={styles.entryHead}>
                  <strong>{def.label}</strong>
                  <span className={styles.entryRead}>{!parsed.ok ? <span className={styles.error}>{parsed.why}</span> : filled ? `→ ${showEntry(k, parsed.value)}` : '→ 없음'}</span>
                </span>
                <input value={text} onChange={(e) => set({ texts: { ...form.texts, [k]: e.target.value } })} placeholder={`보기: ${guide.example}`} aria-label={def.label} />
              </label>
              <div className={styles.entryGuide}>
                {guide.how}.{rule ? ` ${rule}` : ''}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}

/** 입력한 것을 저장할 꼴로. 못 읽는 칸이 있으면 그 칸 이름을 돌려준다. */
export function collectFields(form: FormState): { ok: true; fields: Record<string, unknown>; filled: number } | { ok: false; bad: string[] } {
  if (!form.type) return { ok: false, bad: [] };
  const fields: Record<string, unknown> = {};
  const bad: string[] = [];
  let filled = 0;
  for (const k of FIELDS_BY_TYPE[form.type]) {
    const parsed = parseEntry(k, form.texts[k] ?? '');
    if (!parsed.ok) bad.push(fieldDef(k).label);
    else {
      fields[k] = parsed.value;
      if (parsed.value !== null) filled += 1;
    }
  }
  return bad.length > 0 ? { ok: false, bad } : { ok: true, fields, filled };
}

interface Props {
  target: number;
  docs: HandItem[];
  /** 주소에 ?id= 가 있으면 그 문서를 고쳐 쓰는 것으로 연다. */
  start: GoldDoc | null;
}

interface Last {
  docId: string;
  reviewId: string;
  form: FormState;
}

export default function HandClient({ target, docs: firstDocs, start }: Props) {
  const [docs, setDocs] = useState(firstDocs);
  const [form, setForm] = useState<FormState>(() => (start ? formFromDoc(start) : EMPTY));
  const [last, setLast] = useState<Last | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const started = useRef(0);

  useEffect(() => {
    started.current = performance.now();
  }, [form.id]);

  const openDoc = useCallback(async (id: string) => {
    setError(null);
    const res = await fetch(`/label/api/hand?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    const json = (await res.json().catch(() => ({}))) as { doc?: GoldDoc; error?: string };
    if (!res.ok || !json.doc) {
      setError(json.error ?? '문서를 못 읽었습니다.');
      return;
    }
    setForm(formFromDoc(json.doc));
    setNotice(`${id} 을(를) 고쳐 씁니다.`);
    window.scrollTo({ top: 0 });
  }, []);

  const collected = useMemo(() => collectFields(form), [form]);

  const save = async () => {
    if (busy) return;
    setNotice(null);
    if (!form.type) return setError('종류를 골라 주세요.');
    if (form.type !== 'not_product' && !form.subtype) return setError('갈래를 골라 주세요.');
    if (form.content.trim() === '') return setError('원문을 써 주세요.');
    if (!collected.ok) return setError(`값을 못 읽은 칸이 있습니다: ${collected.bad.join(', ')}`);
    // 상품인데 칸을 거의 안 채웠으면 한 번 되묻는다. 막지는 않는다.
    if (form.type !== 'not_product' && collected.filled < 2 && !asked) {
      setAsked(true);
      return setError(`정답 칸을 ${collected.filled}개만 채웠습니다. 원문에 있는 정보를 다 옮겼으면 한 번 더 누르세요.`);
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/label/api/hand', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          id: form.id,
          content: form.content,
          type: form.type,
          subtype: form.subtype,
          fields: collected.fields,
          tipIds: form.tipIds,
          seconds: Math.round((performance.now() - started.current) / 1000),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { docId?: string; reviewId?: string; created?: boolean; progress?: { docs: HandItem[] }; error?: string };
      if (!res.ok || !json.docId) {
        setError(json.error ?? `저장 실패(${res.status})`);
        return;
      }
      if (json.progress) setDocs(json.progress.docs);
      setLast(json.created && json.reviewId ? { docId: json.docId, reviewId: json.reviewId, form } : null);
      setNotice(json.created ? `${json.docId} 로 저장했습니다. 다음 글을 씁니다.` : `${json.docId} 을(를) 고쳐 저장했습니다.`);
      setForm(EMPTY);
      setAsked(false);
      window.scrollTo({ top: 0 });
    } catch {
      setError('저장 실패. 서버가 떠 있는지 봐 주세요.');
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!last || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/label/api/hand', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'undo', docId: last.docId, reviewId: last.reviewId }) });
      const json = (await res.json().catch(() => ({}))) as { progress?: { docs: HandItem[] }; error?: string };
      if (!res.ok) {
        setNotice(json.error ?? `되돌리기 실패(${res.status})`);
        if (res.status === 404 || res.status === 409) setLast(null);
        return;
      }
      if (json.progress) setDocs(json.progress.docs);
      setForm({ ...last.form, id: null });
      setNotice(`${last.docId} 저장을 되돌렸습니다. 쓰던 글을 다시 놓았습니다.`);
      setLast(null);
    } catch {
      setNotice('되돌리기 실패. 서버가 떠 있는지 봐 주세요.');
    } finally {
      setBusy(false);
    }
  };

  const dirty = form.content.trim() !== '' || Object.values(form.texts).some((t) => (t ?? '').trim() !== '');

  return (
    <main className={styles.review}>
      <header className={styles.bar}>
        <Link href="/label">← 처음으로</Link>
        <strong>손글 쓰기{form.id ? ` — ${form.id} 고쳐 쓰기` : ''}</strong>
        <span>
          {docs.length} / {target}건
        </span>
        <span className={styles.left}>남은 {Math.max(0, target - docs.length)}건</span>
        <progress value={docs.length} max={Math.max(1, target)} />
        <button type="button" disabled={!last || busy} onClick={() => void undo()} title="방금 새로 저장한 한 건을 지우고 쓰던 글을 다시 놓습니다">
          {last ? `방금 저장 되돌리기 — ${last.docId}` : '방금 저장 되돌리기'}
        </button>
      </header>
      <p className={styles.honest}>
        이 묶음은 <strong>모델과 무관하게</strong> 만듭니다. 원문도 정답도 사람이 직접 씁니다. 이 화면은 모델을 부르지 않고 모델의 답을 보여 주지 않습니다. 원문과 정답은 저장소에
        들어갑니다(<code>npm run gold:export</code> 가 <code>data/gold/hand.jsonl</code> 로 씁니다). 그 파일을 커밋한 시각이 “파이프라인을 얼린 뒤에 썼다”의 증거입니다.
      </p>
      {notice ? <p className={styles.noticeLine}>{notice}</p> : null}

      <HandForm
        form={form}
        onChange={(next) => {
          setForm(next);
          setError(null);
        }}
      />

      <div className={styles.footer}>
        {error ? <p className={styles.error}>{error}</p> : null}
        <div className={styles.footerRow}>
          <button type="button" className={styles.button} disabled={busy} onClick={() => void save()}>
            {form.id ? '고친 것 저장' : '저장하고 다음 글'}
          </button>
          {dirty || form.id ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm('쓰던 것을 비울까요?')) {
                  setForm(EMPTY);
                  setError(null);
                  setAsked(false);
                }
              }}
            >
              비우기
            </button>
          ) : null}
          <span className={styles.muted}>{collected.ok ? `채운 칸 ${collected.filled}개 · 나머지는 없음` : form.type ? `못 읽은 칸 ${collected.bad.length}개` : ''}</span>
        </div>
      </div>

      {docs.length > 0 ? (
        <div className={styles.form}>
          <h2>쓴 글</h2>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>번호</th>
                <th>종류</th>
                <th>글자 수</th>
                <th>함정</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td>{d.id}</td>
                  <td>{TYPE_LABELS[d.type as DocType] ?? d.type}</td>
                  <td>{d.chars}</td>
                  <td>{d.traps.join(', ') || '-'}</td>
                  <td>
                    <button type="button" disabled={busy} onClick={() => void openDoc(d.id)}>
                      고쳐 쓰기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </main>
  );
}
