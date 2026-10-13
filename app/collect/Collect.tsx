'use client';

// 모으기 화면. 받은 묶음(출처, 이용 조건, 줄 수)과 모은 줄을 보여 주고, 고른 줄을 초안으로 보낸다.
// 내 작업 공간의 것과 읽기 전용 본보기 공간의 것을 탭으로 나눠 보여 준다. 수집기(파이썬)는 이 사이트에서 돌지 않는다.
// 위에서 아래로: 공간 고르기 → 요약 숫자 → 받은 묶음 → 거르기 → 모은 줄 표(고르기) → 초안으로 보내기.
import Link from 'next/link';
import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  COLLECT_FLAG_LABELS,
  COLLECT_FLAGS,
  COLLECT_LIMITS,
  type CollectedDraftResponse,
  type CollectedItem,
  type CollectedListResponse,
  type CollectFlag,
  type ImportListResponse,
} from '@/contract/tools/collect';
import { Badge, CopyButton, EmptyState, Loading, Notice, PageHead, Stats, type StatItem } from '../../components/bits';
import { ApiFailure, call, failureMessage, setQuery, useMounted, useQuery, useWorkspace } from '../../components/client';
import { comma, formatTime } from '../../components/format';
import { SpacePanel, SpaceTabs, type SpaceKey } from '../../components/ListParts';
import styles from './collect.module.css';

interface Filters {
  sourceId: string;
  flag: CollectFlag | '';
  drafted: 'yes' | 'no' | '';
  q: string;
}

const NO_FILTERS: Filters = { sourceId: '', flag: '', drafted: '', q: '' };

function listPath(filters: Filters, cursor: number | null): string {
  const params = new URLSearchParams();
  if (filters.sourceId) params.set('sourceId', filters.sourceId);
  if (filters.flag) params.set('flag', filters.flag);
  if (filters.drafted) params.set('drafted', filters.drafted);
  if (filters.q) params.set('q', filters.q);
  if (cursor !== null) params.set('cursor', String(cursor));
  const query = params.toString();
  return `/api/collected${query ? `?${query}` : ''}`;
}

const placeOf = (item: CollectedItem): string =>
  [[item.subwayLine, item.station].filter(Boolean).join(' '), item.address ?? item.region].filter(Boolean).join(' · ') || '(위치 없음)';

const sizeOf = (item: CollectedItem): string =>
  item.widthM !== null && item.heightM !== null ? `${item.widthM}×${item.heightM}m` : item.widthM !== null ? `가로 ${item.widthM}m` : item.heightM !== null ? `세로 ${item.heightM}m` : '(크기 없음)';

/** 요약 숫자와 받은 묶음 표. 숫자는 서버가 센 그대로다. */
function Batches({ data }: { data: ImportListResponse }) {
  const t = data.totals;
  const stats: StatItem[] = [
    { label: '지금 있는 줄', value: comma(t.items) },
    { label: '초안이 된 줄', value: comma(t.drafted) },
    { label: '출처', value: `${comma(t.sources)}곳` },
    { label: '서버가 받은 줄', value: comma(t.received) },
    { label: '새 줄', value: comma(t.new) },
    { label: '중복', value: comma(t.duplicate) },
    t.unreadable > 0 ? { label: '못 읽은 줄', value: comma(t.unreadable), tone: 'warn' } : { label: '못 읽은 줄', value: comma(t.unreadable) },
  ];
  return (
    <>
      <div className={styles.totals}>
        <Stats items={stats} />
      </div>
      {t.collectorUnreadable + t.collectorDuplicates > 0 ? (
        <p className="muted small">
          수집기가 보내기 전에 뺀 줄: 못 읽음 {comma(t.collectorUnreadable)}, 파일 안 중복 {comma(t.collectorDuplicates)}
        </p>
      ) : null}

      <h2>
        받은 묶음 <span className="count">{comma(data.batches.length)}개</span>
      </h2>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="받은 묶음 표">
        <table>
          <caption className="sr-only">받은 묶음</caption>
          <thead>
            <tr>
              <th scope="col">출처</th>
              <th scope="col">이용 조건</th>
              <th scope="col">자료를 받은 때</th>
              <th scope="col" className="num">
                받은 줄
              </th>
              <th scope="col" className="num">
                새 줄
              </th>
              <th scope="col" className="num">
                중복
              </th>
              <th scope="col" className="num">
                못 읽은 줄
              </th>
            </tr>
          </thead>
          <tbody>
            {data.batches.map((b) => (
              <tr key={b.id}>
                <th scope="row">
                  {b.source.name}
                  <span className="muted small">
                    {b.source.id} · {b.source.url}
                  </span>
                </th>
                <td>{b.source.license}</td>
                <td>
                  {formatTime(b.source.fetchedAt)}
                  <div className="muted small">서버 도착 {formatTime(b.receivedAt)}</div>
                </td>
                <td className="num">{comma(b.received)}</td>
                <td className="num">{comma(b.new)}</td>
                <td className="num">
                  {comma(b.duplicate)}
                  {b.collectorDuplicates > 0 ? <div className="muted small">수집기가 뺀 것 {comma(b.collectorDuplicates)}</div> : null}
                </td>
                <td className="num">
                  {comma(b.unreadable)}
                  {b.collectorUnreadable > 0 ? <div className="muted small">수집기가 못 읽은 것 {comma(b.collectorUnreadable)}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ItemRow({
  item,
  publicSpace,
  checked,
  onToggle,
  columns,
}: {
  item: CollectedItem;
  publicSpace: boolean;
  checked: boolean;
  onToggle: () => void;
  /** 표의 칸 수. 원래 줄을 펼친 줄이 표 너비를 다 쓴다. */
  columns: number;
}) {
  const [open, setOpen] = useState(false);
  const rawId = useId();
  const title = item.name ?? '(이름 없음)';
  return (
    <>
      <tr className={checked ? 'is-picked' : undefined}>
        {publicSpace ? null : (
          <td className={`tight ${styles.pickCell}`}>
            {/* 칸 전체가 누르는 자리다(네모만 누르지 않아도 된다). */}
            {item.draftId === null ? (
              <label>
                <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`${title} 고르기`} />
              </label>
            ) : null}
          </td>
        )}
        <th scope="row" className={styles.name}>
          {title}
          <span className={`muted small ${styles.sub}`}>
            <span>
              {item.sourceId} · {item.line}번째 줄
            </span>
            <button type="button" className={styles.rawToggle} aria-expanded={open} aria-controls={open ? rawId : undefined} onClick={() => setOpen(!open)}>
              원래 줄 보기
            </button>
          </span>
        </th>
        <td className={styles.place}>{placeOf(item)}</td>
        <td>
          {item.mediaType ?? item.kind ?? '(매체 종류 없음)'}
          {item.operator ? <div className="muted small">{item.operator}</div> : null}
        </td>
        <td>{sizeOf(item)}</td>
        <td className="num">{item.quantity !== null ? comma(item.quantity) : <span className="muted">없음</span>}</td>
        <td className={styles.flags}>
          {item.flags.length === 0 ? (
            <span className="muted small">없음</span>
          ) : (
            <span className="chips">
              {item.flags.map((flag) => (
                <span key={flag} className="flag">
                  {COLLECT_FLAG_LABELS[flag]}
                </span>
              ))}
            </span>
          )}
        </td>
        <td className="tight">
          {item.draftId === null ? <span className="muted small">아직</span> : <Link href={`/drafts/${item.draftId}${publicSpace ? '?pub=1' : ''}`}>초안 #{item.draftId}</Link>}
        </td>
      </tr>
      {open ? (
        <tr className={styles.rawRow} id={rawId}>
          <td colSpan={columns}>
            <pre className="code" tabIndex={0} aria-label={`${title} 원래 줄`}>
              {JSON.stringify(item.raw, null, 2)}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Space({
  publicSpace,
  onShowSample,
  onKnown,
}: {
  publicSpace: boolean;
  onShowSample?: () => void;
  /** 이 공간에 받은 묶음이 있는지 알게 되면 부른다(비었으면 true). 읽지 못했을 때는 false 로 부른다. */
  onKnown?: (empty: boolean) => void;
}) {
  const [batches, setBatches] = useState<ImportListResponse | null>(null);
  const [list, setList] = useState<CollectedListResponse | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [qDraft, setQDraft] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ made: number; had: number; failed: number; why: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    call<ImportListResponse>('GET', '/api/imports', { publicSpace })
      .then((data) => {
        if (!alive) return;
        setBatches(data);
        onKnown?.(data.batches.length === 0);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(failureMessage(err));
        onKnown?.(false);
      });
    return () => {
      alive = false;
    };
  }, [publicSpace, tick, onKnown]);

  useEffect(() => {
    let alive = true;
    call<CollectedListResponse>('GET', listPath(filters, null), { publicSpace })
      .then((data) => {
        if (alive) setList(data);
      })
      .catch((err: unknown) => {
        if (alive) setError(failureMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [publicSpace, filters, tick]);

  const more = async () => {
    if (!list || list.nextCursor === null) return;
    setBusy(true);
    setError(null);
    try {
      const next = await call<CollectedListResponse>('GET', listPath(filters, list.nextCursor), { publicSpace });
      setList({ items: [...list.items, ...next.items], nextCursor: next.nextCursor, total: next.total });
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const change = (patch: Partial<Filters>) => {
    setFilters({ ...filters, ...patch });
    setPicked(new Set());
  };
  const search = (e: FormEvent) => {
    e.preventDefault();
    change({ q: qDraft.trim().slice(0, 60) });
  };
  const clearFilters = () => {
    setQDraft('');
    change(NO_FILTERS);
  };
  const toggle = (id: number) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const pickable = (list?.items ?? []).filter((i) => i.draftId === null).map((i) => i.id);

  /** 고른 줄을 하나씩 초안으로 보낸다. 상한(429)에 닿으면 남은 줄은 보내지 않는다. */
  const send = async () => {
    const ids = [...picked].sort((a, b) => a - b);
    if (ids.length === 0) return;
    setBusy(true);
    setError(null);
    const result = { made: 0, had: 0, failed: 0, why: null as string | null };
    for (const [i, id] of ids.entries()) {
      try {
        const got = await call<CollectedDraftResponse>('POST', `/api/collected/${id}/draft`, { label: i === 0 ? '모은 줄을 초안으로' : undefined });
        if (got.duplicate) result.had += 1;
        else result.made += 1;
      } catch (err) {
        result.why = failureMessage(err);
        if (err instanceof ApiFailure && err.status === 429) {
          result.failed += ids.length - i;
          break;
        }
        result.failed += 1;
      }
    }
    setSent(result);
    setPicked(new Set());
    setBusy(false);
    setTick((n) => n + 1);
  };

  if (!batches || !list) return error ? <Notice kind="error">{error}</Notice> : <Loading />;

  const stored = batches.totals.items;
  if (batches.batches.length === 0) {
    return publicSpace ? (
      <EmptyState>수집기는 로컬에서 돕니다. 본보기 공간에는 실어 둔 줄이 없습니다.</EmptyState>
    ) : (
      <EmptyState
        title="이 공간에는 아직 받은 줄이 없습니다."
        action={
          onShowSample ? (
            <button type="button" className="btn" onClick={onShowSample}>
              본보기 공간 보기
            </button>
          ) : null
        }
      >
        아래 &quot;수집기에서 보내는 법&quot;대로 이 공간 번호로 보내면 여기에 보입니다.
      </EmptyState>
    );
  }

  const sources = [...new Map(batches.batches.map((b) => [b.source.id, b.source.name])).entries()];
  const filtered = filters.sourceId !== '' || filters.flag !== '' || filters.drafted !== '' || filters.q !== '';
  const columns = publicSpace ? 7 : 8;
  return (
    <>
      {publicSpace ? (
        <Notice>수집기는 로컬에서 돕니다. 여기에는 본보기로 실은 {comma(stored)}줄만 있습니다. 읽기 전용이라 초안으로 보낼 수 없습니다.</Notice>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Batches data={batches} />

      <h2>모은 줄</h2>
      <form className={`toolbar ${styles.filters}`} role="search" aria-label="모은 줄 거르기" onSubmit={search}>
        <label>
          출처{' '}
          <select value={filters.sourceId} onChange={(e) => change({ sourceId: e.target.value })}>
            <option value="">전체</option>
            {sources.map(([id, name]) => (
              <option key={id} value={id}>
                {name} ({id})
              </option>
            ))}
          </select>
        </label>
        <label>
          표시{' '}
          <select value={filters.flag} onChange={(e) => change({ flag: e.target.value as Filters['flag'] })}>
            <option value="">전체</option>
            {COLLECT_FLAGS.map((flag) => (
              <option key={flag} value={flag}>
                {COLLECT_FLAG_LABELS[flag]}
              </option>
            ))}
          </select>
        </label>
        <label>
          초안{' '}
          <select value={filters.drafted} onChange={(e) => change({ drafted: e.target.value as Filters['drafted'] })}>
            <option value="">전체</option>
            <option value="no">아직 초안이 아닌 줄</option>
            <option value="yes">초안이 된 줄</option>
          </select>
        </label>
        <label>
          찾기 <input type="search" value={qDraft} maxLength={60} placeholder="이름·주소·지역·역" onChange={(e) => setQDraft(e.target.value)} />
        </label>
        <button type="submit" className="btn">
          찾기
        </button>
        {filtered ? (
          <button type="button" className="btn ghost" onClick={clearFilters}>
            조건 지우기
          </button>
        ) : null}
      </form>

      <div className={publicSpace ? styles.bulk : `${styles.bulk} ${styles.bulkSticky}`}>
        <p className={`muted small ${styles.bulkCount}`} role="status">
          걸러 낸 줄 {comma(list.total)}건 가운데 {comma(list.items.length)}건을 보고 있습니다. 한 번에 {COLLECT_LIMITS.pageSize}건씩 읽습니다.
        </p>
        {publicSpace ? (
          <Badge>읽기 전용</Badge>
        ) : (
          <div className={styles.bulkActions}>
            <button type="button" className="btn" disabled={busy || pickable.length === 0} onClick={() => setPicked(new Set(picked.size === pickable.length ? [] : pickable))}>
              {picked.size > 0 && picked.size === pickable.length ? '고른 것 풀기' : '보이는 줄 전부 고르기'}
            </button>
            <button type="button" className={`btn primary ${styles.btnGrow}`} disabled={busy || picked.size === 0} onClick={send}>
              {busy ? '보내는 중…' : `고른 줄 ${comma(picked.size)}건 초안으로 보내기`}
            </button>
          </div>
        )}
      </div>
      {publicSpace ? null : (
        <p className={`muted small ${styles.sendNote}`}>
          초안으로 보낼 때 AI를 부르지 않습니다. 줄의 이름·위치·크기를 본체의 맞추기와 따지기에 그대로 넣습니다. 이 자료에는 가격·운영 시간·유동인구가 없어서
          초안은 &quot;필수 칸 빔&quot; 표시가 붙은 채 검수함의 &quot;확인 필요&quot;로 갑니다. 사람이 값을 채워야 승인할 수 있습니다.
        </p>
      )}
      {sent ? (
        <Notice kind={sent.failed > 0 ? 'warn' : 'info'}>
          새 초안 {comma(sent.made)}건을 만들었습니다.
          {sent.had > 0 ? ` 이미 초안이 있던 줄 ${comma(sent.had)}건.` : ''}
          {sent.failed > 0 ? ` 만들지 못한 줄 ${comma(sent.failed)}건${sent.why ? `: ${sent.why}` : '.'}` : ''} <Link href="/inbox">검수함에서 보기</Link>
        </Notice>
      ) : null}

      {list.items.length === 0 ? (
        <EmptyState
          action={
            filtered ? (
              <button type="button" className="btn" onClick={clearFilters}>
                조건 지우기
              </button>
            ) : null
          }
        >
          이 조건에 맞는 줄이 없습니다.
        </EmptyState>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="모은 줄 표">
          <table className={styles.items}>
            <caption className="sr-only">모은 줄</caption>
            <thead>
              <tr>
                {publicSpace ? null : (
                  <th scope="col" className="tight">
                    고르기
                  </th>
                )}
                <th scope="col">이름</th>
                <th scope="col">위치</th>
                <th scope="col">매체 종류</th>
                <th scope="col">크기</th>
                <th scope="col" className="num">
                  수량
                </th>
                <th scope="col">표시</th>
                <th scope="col" className="tight">
                  초안
                </th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((item) => (
                <ItemRow key={item.id} item={item} publicSpace={publicSpace} checked={picked.has(item.id)} onToggle={() => toggle(item.id)} columns={columns} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list.nextCursor !== null ? (
        <div className="actions">
          <button type="button" className="btn" disabled={busy} onClick={more}>
            더 보기
          </button>
        </div>
      ) : null}
    </>
  );
}

export function Collect() {
  const mounted = useMounted();
  const workspace = useWorkspace();
  // 고른 공간은 주소(?space=…)에 둔다. 고르지 않았으면 내 작업 공간에 받은 줄이 있을 때는 그것을, 공간이 없거나 비었으면 본보기 공간을 먼저 보여 준다.
  // 내 공간이 비었는지는 읽어 봐야 안다. 알기 전에는 어느 쪽도 고르지 않고 읽는 중이라고 보여 준다(탭이 깜박이며 바뀌지 않게).
  const pickedParam = new URLSearchParams(useQuery()).get('space');
  const tab: SpaceKey | null = pickedParam === 'mine' || pickedParam === 'demo' ? pickedParam : null;
  const setTab = (next: SpaceKey) => setQuery({ space: next });
  const [mineEmpty, setMineEmpty] = useState<boolean | null>(null);
  const first: SpaceKey | null = !workspace ? 'demo' : mineEmpty === null ? null : mineEmpty ? 'demo' : 'mine';
  const chosen: SpaceKey | null = mounted ? (tab ?? first) : null;

  return (
    <main className="page wide">
      <PageHead
        title="모으기"
        lead="수집기가 보낸 설치 현황 줄을 보고, 고른 줄을 초안으로 보냅니다. 가격이 없는 자료이고 이 화면은 AI를 쓰지 않습니다."
        about={
          <>
            <p>
              여러 기관이 제각각 낸 전광판·옥외광고 설치 현황 자료를 로컬의 수집기(파이썬)가 받아 한 꼴로 정리해 이 서버로 보냅니다. 서버는 줄의 꼴을 다시 보고, 같은
              자리·같은 규격의 줄을 한 건으로 합쳐 모아 둡니다. 이 화면은 그렇게 모인 줄을 보여 주고, 고른 줄을 초안으로 보냅니다.
            </p>
            <p>
              판매 상품이 아니라 설치 현황 자료입니다. 가격이 없고, 지어내지 않습니다. 이 화면은 AI를 쓰지 않습니다. 수집기는 이 사이트에서 돌지 않으며, 이 사이트가 다른
              사이트를 긁어 오지도 않습니다.
            </p>
          </>
        }
      />

      {/* 검수함·상품과 같은 공간 탭(화살표 키로 옮긴다). 어느 쪽인지 알기 전에는 어느 탭도 고른 표시를 하지 않는다. */}
      <SpaceTabs prefix="collect" value={chosen} onChange={setTab} />

      {chosen === null ? <Loading /> : null}

      <SpacePanel prefix="collect" space="mine" active={chosen === 'mine'}>
        {!mounted ? null : workspace ? (
          <Space key={workspace} publicSpace={false} onShowSample={() => setTab('demo')} onKnown={setMineEmpty} />
        ) : (
          <EmptyState
            title="아직 내 작업 공간이 없습니다."
            action={
              <button type="button" className="btn" onClick={() => setTab('demo')}>
                본보기 공간 보기
              </button>
            }
          >
            <Link href="/">작업 화면</Link>에서 글을 한 건 접수하면 공간 번호가 생깁니다. 수집기를 공간 번호 없이 돌리면 서버가 새 공간을 만들어 그 번호를 응답으로 돌려줍니다.
          </EmptyState>
        )}
        <details className="help">
          <summary>수집기에서 보내는 법</summary>
          <p className="small">
            로컬에서 수집기를 돌려 이 서버의 <code>POST /api/imports</code> 로 보냅니다. 한 번에 {comma(COLLECT_LIMITS.rowsPerRequest)}줄까지, 요청 하나에 출처 하나입니다. 헤더{' '}
            <code>X-Workspace</code> 에 아래 공간 번호를 넣으면 이 화면의 &quot;내 작업 공간&quot;에 보입니다. 줄의 꼴과 중복을 가르는 식은 저장소의 <code>docs/IMPORT-FORMAT.md</code> 에
            있습니다.
          </p>
          {mounted && workspace ? (
            <p className="small">
              내 작업 공간 번호: <code className="wrap">{workspace}</code> <CopyButton text={workspace} label="번호 복사" />
            </p>
          ) : null}
          <p className="muted small">
            한 공간에 묶음 {comma(COLLECT_LIMITS.batchesPerWorkspace)}개, 줄 {comma(COLLECT_LIMITS.itemsPerWorkspace)}줄까지 둡니다. 이 수는 잰 근거 없이 정한 상한입니다.
          </p>
        </details>
      </SpacePanel>

      <SpacePanel prefix="collect" space="demo" active={chosen === 'demo'}>
        {mounted ? <Space publicSpace /> : null}
      </SpacePanel>
    </main>
  );
}
