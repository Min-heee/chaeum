'use client';

// 용어 사전 화면. 공용 줄(읽기 전용)과 내 작업 공간의 줄을 보여 주고, 내 줄을 더하고·고치고·승인한다.
// 무엇이 쓰이는지는 서버가 정한다(승인된 줄만, 내 줄이 공용 줄을 이긴다). 이 화면은 그 결과를 보여 줄 뿐이다.
// 찾기와 거르기는 화면에서만 한다(서버에 다시 묻지 않는다).
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  GLOSSARY_LIMITS,
  GLOSSARY_STATUS_LABELS,
  GLOSSARY_STATUSES,
  type GlossaryListResponse,
  type GlossaryStatus,
  type GlossaryTerm,
  type GlossaryWriteResponse,
} from '@/contract/tools/glossary';
import { Badge, EmptyState, Loading, Notice, PageHead, Stats, Toolbar, type Tone } from '../../components/bits';
import { call, failureMessage, useMounted, useWorkspace } from '../../components/client';
import { formatTime } from '../../components/format';
import styles from './glossary.module.css';

/** 상태의 색: 승인은 초록, 제안은 노랑(사람이 확인해야 쓰인다). */
const STATUS_TONE: Record<GlossaryStatus, Tone> = { proposed: 'warn', approved: 'ok' };

function StatusBadge({ status }: { status: GlossaryStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{GLOSSARY_STATUS_LABELS[status]}</Badge>;
}

const blankToNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

function AddForm({ onAdded }: { onAdded: () => void }) {
  const [ko, setKo] = useState('');
  const [en, setEn] = useState('');
  const [zh, setZh] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAdded(null);
    try {
      const word = ko.trim();
      await call<GlossaryWriteResponse>('POST', '/api/glossary', {
        body: { ko: word, en: blankToNull(en), 'zh-Hans': blankToNull(zh), note: blankToNull(note) },
        label: '용어 더하기',
      });
      setKo('');
      setEn('');
      setZh('');
      setNote('');
      setAdded(word);
      onAdded();
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={`panel ${styles.add}`} onSubmit={submit} aria-label="용어 더하기">
      <h3 className="panel-title">용어 더하기</h3>
      <div className="form-grid">
        <label className="stack">
          한국어 낱말
          <input value={ko} maxLength={GLOSSARY_LIMITS.termMaxChars} onChange={(e) => setKo(e.target.value)} required />
        </label>
        <label className="stack">
          영어 표기
          <input value={en} maxLength={GLOSSARY_LIMITS.termMaxChars} onChange={(e) => setEn(e.target.value)} />
        </label>
        <label className="stack">
          중국어(간체) 표기
          <input value={zh} lang="zh-Hans" maxLength={GLOSSARY_LIMITS.termMaxChars} onChange={(e) => setZh(e.target.value)} />
        </label>
        <label className="stack">
          메모
          <input value={note} maxLength={GLOSSARY_LIMITS.noteMaxChars} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <div className="actions">
        <button type="submit" className="btn primary" disabled={busy || ko.trim() === ''}>
          제안으로 더하기
        </button>
        <span className="muted small">제안 상태로 들어갑니다. 승인하기 전에는 어디에도 쓰이지 않습니다. 표기는 나중에 채워도 됩니다.</span>
      </div>
      {added ? (
        <p className={`ok-line small ${styles.added}`} role="status">
          &ldquo;{added}&rdquo; 줄을 제안으로 더했습니다. 아래 표에서 표기를 채우고 승인할 수 있습니다.
        </p>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </form>
  );
}

function OwnRow({ term, hidden, onChanged }: { term: GlossaryTerm; hidden: boolean; onChanged: () => void }) {
  const [en, setEn] = useState(term.en ?? '');
  const [zh, setZh] = useState(term['zh-Hans'] ?? '');
  const [note, setNote] = useState(term.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = en.trim() !== (term.en ?? '') || zh.trim() !== (term['zh-Hans'] ?? '') || note.trim() !== (term.note ?? '');
  const complete = en.trim() !== '' && zh.trim() !== '';

  const save = async (status?: GlossaryStatus) => {
    setBusy(true);
    setError(null);
    try {
      await call<GlossaryWriteResponse>('PATCH', `/api/glossary/${term.id}`, {
        body: { en: blankToNull(en), 'zh-Hans': blankToNull(zh), note: blankToNull(note), ...(status ? { status } : {}) },
        label: status === 'approved' ? '용어 승인' : status === 'proposed' ? '용어 승인 풀기' : '용어 고치기',
      });
      onChanged();
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // 거르기에 걸려 안 보이는 줄도 그대로 둔다(숨기기만 한다). 고치던 글자가 사라지지 않게 하려는 것이다.
  return (
    <tr hidden={hidden}>
      <th scope="row">
        {term.ko}
        <span className="muted small">{formatTime(term.updatedAt)}에 고침</span>
      </th>
      <td data-label="영어 표기">
        <input aria-label={`${term.ko}의 영어 표기`} value={en} maxLength={GLOSSARY_LIMITS.termMaxChars} onChange={(e) => setEn(e.target.value)} />
      </td>
      <td data-label="중국어(간체) 표기">
        <input aria-label={`${term.ko}의 중국어(간체) 표기`} lang="zh-Hans" value={zh} maxLength={GLOSSARY_LIMITS.termMaxChars} onChange={(e) => setZh(e.target.value)} />
      </td>
      <td data-label="메모">
        <input aria-label={`${term.ko}의 메모`} value={note} maxLength={GLOSSARY_LIMITS.noteMaxChars} onChange={(e) => setNote(e.target.value)} />
      </td>
      <td className={styles.state} data-label="상태">
        <StatusBadge status={term.status} />
      </td>
      <td className={styles.acts} data-label="할 일">
        <div className={styles.rowActions}>
          <button type="button" className="btn small" disabled={busy || !dirty || (term.status === 'approved' && !complete)} onClick={() => save()}>
            저장
          </button>
          {term.status === 'proposed' ? (
            <button type="button" className="btn small primary" disabled={busy || !complete} onClick={() => save('approved')}>
              승인
            </button>
          ) : (
            <button type="button" className="btn small" disabled={busy} onClick={() => save('proposed')}>
              승인 풀기
            </button>
          )}
        </div>
        {term.status === 'proposed' && !complete ? <span className={styles.rowHint}>두 표기를 다 채워야 승인할 수 있습니다.</span> : null}
        {error ? <Notice kind="error">{error}</Notice> : null}
      </td>
    </tr>
  );
}

export function GlossaryTool() {
  const mounted = useMounted();
  const workspace = useWorkspace();
  const [data, setData] = useState<GlossaryListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [turn, setTurn] = useState(0);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | GlossaryStatus>('all');
  const reload = useCallback(() => setTurn((n) => n + 1), []);

  useEffect(() => {
    if (!mounted) return;
    let alive = true;
    // 내 작업 공간이 없으면 헤더 없이 읽는다(본보기 공간의 공용 줄만 온다).
    call<GlossaryListResponse>('GET', '/api/glossary')
      .then((list) => {
        if (alive) {
          setData(list);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (alive) setError(failureMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [mounted, workspace, turn]);

  const shared = data?.items.filter((t) => t.shared) ?? [];
  const own = data?.items.filter((t) => !t.shared) ?? [];

  // 찾기·거르기: 화면에서만 한다. 위의 요약 숫자는 거르기와 상관없이 전체다.
  const needle = query.trim().toLowerCase();
  const matches = (t: GlossaryTerm) =>
    (status === 'all' || t.status === status) && (needle === '' || [t.ko, t.en ?? '', t['zh-Hans'] ?? '', t.note ?? ''].some((text) => text.toLowerCase().includes(needle)));
  const filtered = needle !== '' || status !== 'all';
  const ownShown = own.filter(matches);
  const sharedShown = shared.filter(matches);
  const proposed = data?.counts.proposed ?? 0;

  return (
    <main className="page">
      <PageHead
        title="용어 사전"
        lead={
          <>
            낱말의 다른 언어 표기를 한곳에서 정합니다. <strong>승인된 표기만</strong> 쓰이고, AI를 쓰지 않습니다.
          </>
        }
        about={
          <p>
            &ldquo;커피차&rdquo; 같은 낱말이 언어마다 같은 말로 옮겨지도록 표기를 한곳에서 정합니다. <strong>승인된 표기만</strong> 다른 언어 글 만들기와 글 검사,{' '}
            <Link href="/audit">점검</Link>에 쓰입니다. 제안 상태의 줄은 어디에도 쓰이지 않습니다. <strong>AI를 쓰지 않습니다.</strong> 상품 글에서 용어 후보를 AI가
            제안하는 기능은 만들지 않았습니다.
          </p>
        }
      />

      {error ? <Notice kind="error">{error}</Notice> : null}
      {data ? (
        <>
          <Stats
            items={[
              { label: '지금 이 공간의 글에 쓰이는 용어', value: `${data.inUse}개`, note: '같은 낱말은 내 승인 줄이 공용 줄을 대신합니다' },
              { label: '승인', value: `${data.counts.approved ?? 0}줄` },
              { label: '제안', value: `${proposed}줄`, note: '승인하기 전에는 어디에도 쓰이지 않습니다', tone: proposed > 0 ? 'warn' : undefined },
            ]}
          />
          <Toolbar label="용어 찾기와 거르기">
            <label>
              찾기
              <input type="search" className={styles.search} value={query} placeholder="낱말이나 표기" onChange={(e) => setQuery(e.target.value)} />
            </label>
            <label>
              상태
              <select value={status} onChange={(e) => setStatus(e.target.value as 'all' | GlossaryStatus)}>
                <option value="all">모든 상태</option>
                {GLOSSARY_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {GLOSSARY_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted small" role="status">
              {filtered ? `내 줄 ${ownShown.length}/${own.length} · 공용 줄 ${sharedShown.length}/${shared.length} 보임` : '아래 두 표를 함께 거릅니다. 화면에서만 거릅니다.'}
            </span>
          </Toolbar>
        </>
      ) : !error ? (
        <Loading />
      ) : null}

      <section className={styles.section} aria-label="내 작업 공간의 용어">
        <h2>
          내 작업 공간의 용어 <span className="count">{own.length}줄</span>
        </h2>
        <AddForm onAdded={reload} />
        {data && own.length === 0 ? (
          <EmptyState title="아직 내 작업 공간에 더한 용어가 없습니다.">
            지금은 아래 공용 용어만 쓰입니다. 공용 용어와 다르게 적고 싶은 낱말이 있으면 같은 한국어 낱말로 더하고 승인해 보세요. 내 작업 공간의 글에는 내 표기가
            쓰입니다.
            {mounted && !workspace ? ' 처음 더할 때 작업 공간이 생기고 이 브라우저에 저장됩니다.' : ''}
          </EmptyState>
        ) : null}
        {own.length > 0 ? (
          <>
            <div className={`table-wrap ${styles.own}`} tabIndex={0} role="region" aria-label="내 작업 공간의 용어 표" hidden={ownShown.length === 0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">한국어 낱말</th>
                    <th scope="col">영어 표기</th>
                    <th scope="col">중국어(간체) 표기</th>
                    <th scope="col">메모</th>
                    <th scope="col">상태</th>
                    <th scope="col">할 일</th>
                  </tr>
                </thead>
                <tbody>
                  {own.map((term) => (
                    <OwnRow key={`${term.id}-${term.updatedAt}`} term={term} hidden={!matches(term)} onChanged={reload} />
                  ))}
                </tbody>
              </table>
            </div>
            {ownShown.length === 0 ? <EmptyState>찾는 말과 상태에 맞는 내 줄이 없습니다.</EmptyState> : null}
          </>
        ) : null}
        <ul className={styles.notes}>
          <li>
            내 작업 공간의 줄에서 승인은 &ldquo;사람이 이 표기를 확인했다&rdquo;는 뜻입니다. 읽지 못하는 언어의 표기는 승인하지 말고 제안으로 두세요. 아래 공용
            줄의 &ldquo;승인&rdquo;은 그런 뜻이 아닙니다(공용 용어 설명 참고).
          </li>
          <li>
            승인해도 이미 만든 글은 다시 만들지 않습니다. 그 글은 <Link href="/audit">점검</Link>에서 &ldquo;용어 표기 다름&rdquo;으로 보이고, 상품 화면에서 사람이
            고칩니다. 새로 승인하는 상품의 글부터 새 표기가 들어갑니다.
          </li>
          <li>한국어 낱말은 고칠 수 없습니다(다른 낱말이면 새 줄입니다). 줄을 지우는 기능은 없습니다. 승인을 풀면 쓰이지 않습니다.</li>
          <li>
            한 공간에 {GLOSSARY_LIMITS.termsPerWorkspace}줄까지, 낱말과 표기는 {GLOSSARY_LIMITS.termMaxChars}자까지입니다.
          </li>
        </ul>
      </section>

      <section className={styles.section} aria-label="공용 용어">
        <h2>
          공용 용어 <span className="count">{shared.length}줄 · 읽기 전용</span>
        </h2>
        <p className="muted small">
          모든 공간이 함께 쓰는 줄입니다. 지어낸 가상 마켓의 용어이고, 방문자는 고칠 수 없습니다. <strong>이 줄들의 &ldquo;승인&rdquo;은 사람이 눌러서 된 것이
          아닙니다.</strong> 사이트를 처음 깔 때 넣는 파일이 승인 상태로 실은 것입니다. 표기는 만든 쪽이 지은 것이고, 사람이 하나씩 확인했다는 기록이 없습니다. 특히
          중국어(간체) 표기는 읽을 줄 아는 사람이 확인하지 않았습니다. 뜻이 통하는 낱말을 골랐을 뿐입니다.
        </p>
        {data && shared.length === 0 ? (
          <EmptyState title="공용 용어가 표에 없습니다(처음 넣는 자료를 싣지 않은 DB입니다).">
            이때는 저장소의 파일(data/seed/glossary.json)에 든 용어가 그대로 쓰입니다. 위의 &ldquo;쓰이는 용어&rdquo; 수가 그 수입니다.
          </EmptyState>
        ) : null}
        {shared.length > 0 && sharedShown.length === 0 ? <EmptyState>찾는 말과 상태에 맞는 공용 줄이 없습니다.</EmptyState> : null}
        {sharedShown.length > 0 ? (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="공용 용어 표">
            <table>
              <thead>
                <tr>
                  <th scope="col">한국어 낱말</th>
                  <th scope="col">영어 표기</th>
                  <th scope="col">중국어(간체) 표기</th>
                  <th scope="col">상태</th>
                </tr>
              </thead>
              <tbody>
                {sharedShown.map((term) => (
                  <tr key={term.id}>
                    <th scope="row">{term.ko}</th>
                    <td>{term.en ?? ''}</td>
                    <td lang="zh-Hans">{term['zh-Hans'] ?? ''}</td>
                    <td>
                      <StatusBadge status={term.status} />
                      {term.overridden ? <span className={styles.overridden}>내 승인 줄에 가려 이 공간에서는 쓰이지 않습니다</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </main>
  );
}
