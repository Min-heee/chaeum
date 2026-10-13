'use client';

// 검수함. 일감 줄이다: 공간(내 작업 공간 / 본보기 공간)을 고르고, 상태 숫자를 눌러 거르고, 한 줄을 눌러 연다.
// 처음에는 "대기"(사람이 볼 차례인 것: 확인 필요 + 바로 승인 가능)가 함께 보인다. 확인 필요는 사유별로 묶는다.
// 내 작업 공간의 것은 고치고 승인할 수 있고, 본보기 공간의 것은 읽기 전용이다.
// 고른 공간·상태·사유는 주소(?space=…&status=…&reason=…)에 둔다. 한 건을 열었다가 뒤로 와도 그대로 남는다.
import Link from 'next/link';
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { DraftListItemBody, DraftListResponse } from '@/contract/api';
import { TYPE_LABELS } from '@/contract/fields';
import { REASONS, REASON_CODES, type ReasonCode } from '@/contract/reasons';
import { STATUS_LABELS, type DraftStatus } from '@/contract/transitions';
import { EmptyState, Loading, Notice, PageHead, ReasonChips, StatusBadge } from './bits';
import { call, failureMessage, setQuery, useMounted, useQuery, useRole, useWorkspace } from './client';
import { formatTime } from './format';
import { SpacePanel, SpaceTabs, StatFilter, useRowOpen, useStackBelow, type SpaceKey, type StatOption } from './ListParts';
import styles from './ListParts.module.css';

/** 한 건이 사유를 여럿 가지면 이 순서에서 먼저 나오는 사유의 묶음에 넣는다. */
const GROUP_ORDER: readonly ReasonCode[] = [
  'NOT_A_PRODUCT',
  'INSTRUCTION_LIKE',
  'TRANSCRIBED',
  'LLM_SKIPPED',
  'TYPE_SUBTYPE_MISMATCH',
  'EMPTY_REQUIRED_OPTIONS',
  'REQUIRED_MISSING',
  'VALUE_MISMATCH',
  'NO_EVIDENCE',
  'PARSE_FAILED',
  'OUT_OF_RANGE',
  'PLACEHOLDER_VALUE',
  'UNIT_CONVERTED',
];
const REASON_ORDER: readonly ReasonCode[] = [...GROUP_ORDER, ...REASON_CODES.filter((c) => !GROUP_ORDER.includes(c))];

/** 요약 숫자의 순서. 사람이 볼 것(확인 필요, 바로 승인 가능)이 앞이다. */
const STATUS_ORDER: readonly DraftStatus[] = ['NEEDS_REVIEW', 'READY', 'PROCESSING', 'FAILED', 'APPROVED', 'REJECTED'];

/** 지금 보는 묶음. WAITING 은 사람이 볼 차례인 것(확인 필요 + 바로 승인 가능)을 함께 보여 준다. */
type View = 'WAITING' | DraftStatus;
const isView = (value: string | null): value is View => value === 'WAITING' || (STATUS_ORDER as readonly string[]).includes(value ?? '');

const STATUS_NOTES: Partial<Record<DraftStatus, string>> = {
  NEEDS_REVIEW: '표시가 하나라도 붙은 초안입니다. 사유별로 묶었습니다.',
  READY: '표시가 0개인 초안입니다. 그래도 사람이 승인해야 상품이 됩니다.',
};

const SPACE_NOTES: Record<SpaceKey, string> = {
  mine: '이 브라우저에서 넣은 글의 초안입니다. 고치고 승인할 수 있습니다.',
  demo: '미리 들어 있는 건입니다. 열어서 볼 수 있고, “내 작업 공간으로 가져와 고치기”를 누르면 고치고 승인할 수 있습니다.',
};

const SOURCE_KIND_LABELS = { text: '글', image: '그림', pdf: 'PDF', import: '가져온 줄' } as const;

const COLUMNS = 6;
/** 표 여섯 칸이 가로로 밀리지 않고 들어가는 너비. 이보다 좁은 자리에서는 한 건을 한 덩이로 쌓는다. */
const STACK_BELOW = 840;

interface Lane {
  items: DraftListItemBody[];
  nextCursor: number | null;
}

interface SpaceData {
  review: Lane;
  ready: Lane;
  counts: Partial<Record<DraftStatus, number>>;
}

interface Group {
  /** 묶음의 사유. null 은 사유 없는 건, undefined 는 묶지 않은 목록(머리 줄 없음). */
  code: ReasonCode | null | undefined;
  items: DraftListItemBody[];
}

type Waiting = Partial<Record<SpaceKey, number>>;

const isLane = (status: DraftStatus) => status === 'NEEDS_REVIEW' || status === 'READY';

const toLane = (page: DraftListResponse): Lane => ({ items: page.items, nextCursor: page.nextCursor });

async function loadSpace(publicSpace: boolean): Promise<SpaceData> {
  const [review, ready] = await Promise.all([
    call<DraftListResponse>('GET', '/api/drafts?status=NEEDS_REVIEW', { publicSpace }),
    call<DraftListResponse>('GET', '/api/drafts?status=READY', { publicSpace }),
  ]);
  return { review: toLane(review), ready: toLane(ready), counts: review.counts };
}

function groupByReason(items: DraftListItemBody[]): Group[] {
  const groups = new Map<ReasonCode | null, DraftListItemBody[]>();
  for (const item of items) {
    const code = GROUP_ORDER.find((c) => item.reasons.includes(c)) ?? item.reasons[0] ?? null;
    groups.set(code, [...(groups.get(code) ?? []), item]);
  }
  return [...REASON_ORDER, null].filter((code) => groups.has(code)).map((code) => ({ code, items: groups.get(code) ?? [] }));
}

function extractedText(item: DraftListItemBody, publicSpace: boolean): string {
  if (item.extractedBy === 'import') return 'AI 없이 줄의 값을 그대로 맞춤';
  if (item.extractedBy === 'rules') return '규칙만으로 뽑음';
  if (item.extractedBy === 'llm') return publicSpace ? 'AI로 뽑음(미리 받아 둔 답)' : 'AI로 뽑음';
  return '아직 안 뽑음';
}

/** 초안 목록. 줄 전체가 눌린다. 좁은 화면에서는 한 건이 한 덩이로 쌓인다(그래도 표로 읽히게 role 을 적는다). */
function DraftTable({ groups, publicSpace, status }: { groups: Group[]; publicSpace: boolean; status: DraftStatus }) {
  const open = useRowOpen();
  const stackRef = useStackBelow(STACK_BELOW);
  return (
    <div className="table-wrap" ref={stackRef}>
      <table className={styles.list} role="table" aria-label={`${STATUS_LABELS[status]} 초안`}>
        <thead role="rowgroup">
          <tr role="row">
            <th role="columnheader" scope="col" className="tight num">
              번호
            </th>
            <th role="columnheader" scope="col">
              상품 이름
            </th>
            <th role="columnheader" scope="col">
              확인할 까닭
            </th>
            <th role="columnheader" scope="col">
              종류 · 갈래
            </th>
            <th role="columnheader" scope="col">
              들어온 길 · 뽑은 방법
            </th>
            <th role="columnheader" scope="col" className="num">
              마지막 변경
            </th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.code ?? (group.code === null ? 'none' : 'all')} role="rowgroup">
            {group.code !== undefined ? (
              <tr role="row" className={styles.groupRow}>
                <th role="rowheader" scope="rowgroup" colSpan={COLUMNS}>
                  <span className="flag">{group.code ? REASONS[group.code].label : '사유 없음'}</span> <span className="count">{group.items.length}건</span>
                  {group.code ? <span className="muted">{REASONS[group.code].description}</span> : null}
                </th>
              </tr>
            ) : null}
            {group.items.map((item) => {
              const href = `/drafts/${item.id}${publicSpace ? '?pub=1' : ''}`;
              const title = isLane(status) ? (item.name ?? (item.type === 'not_product' ? '(등록 대상이 아닌 글)' : '(이름을 찾지 못함)')) : (item.name ?? '(이름 없음)');
              return (
                <tr key={item.id} role="row" className={styles.rowLink} onClick={open(href)}>
                  <td role="cell" className={`tight num ${styles.id}`}>
                    #{item.id}
                  </td>
                  <td role="cell" className={styles.name}>
                    <Link href={href} className={styles.title}>
                      {title}
                    </Link>
                    {isLane(status) ? null : <StatusBadge status={item.status} />}
                    <span className={styles.sub}>{item.preview}</span>
                  </td>
                  <td role="cell" className={styles.chipsCell}>
                    {item.reasons.length > 0 ? <ReasonChips codes={item.reasons} /> : null}
                  </td>
                  <td role="cell" className={styles.meta}>
                    {item.type ? TYPE_LABELS[item.type] : '종류 모름'}
                    {item.subtype ? ` · ${item.subtype}` : ''}
                  </td>
                  <td role="cell" className={styles.meta}>
                    {SOURCE_KIND_LABELS[item.sourceKind]}로 들어옴 <span className={styles.metaSub}>{extractedText(item, publicSpace)}</span>
                  </td>
                  <td role="cell" className={`num ${styles.meta}`}>
                    {formatTime(item.updatedAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function Space({
  space,
  refreshKey,
  report,
  picked,
  onPick,
  reason,
  onReason,
}: {
  space: SpaceKey;
  refreshKey: number;
  /** 확인·승인을 기다리는 건수를 탭에 알린다 */
  report: Dispatch<SetStateAction<Waiting>>;
  /** 고른 묶음(없으면 대기). 고른 것은 주소에 있다. */
  picked: View | null;
  onPick: (view: View) => void;
  reason: ReasonCode | 'all';
  onReason: (reason: ReasonCode | 'all') => void;
}) {
  const publicSpace = space === 'demo';
  const [data, setData] = useState<SpaceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [other, setOther] = useState<{ status: DraftStatus; lane: Lane } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    loadSpace(publicSpace)
      .then((got) => {
        if (!alive) return;
        setData(got);
        setError(null);
        report((prev) => ({ ...prev, [space]: (got.counts.NEEDS_REVIEW ?? 0) + (got.counts.READY ?? 0) }));
      })
      .catch((err: unknown) => {
        if (alive) setError(failureMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [publicSpace, refreshKey, report, space]);

  const count = (status: DraftStatus) => data?.counts[status] ?? 0;
  const waiting = count('NEEDS_REVIEW') + count('READY');
  // 고르지 않았으면 대기(확인 필요 + 바로 승인 가능)를 함께 보여 준다.
  const view: View = picked ?? 'WAITING';
  const otherStatus: DraftStatus | null = view === 'WAITING' || isLane(view) ? null : view;

  // 그 밖의 상태(처리 중·처리 실패·승인됨·반려됨)는 고를 때 읽는다.
  useEffect(() => {
    if (otherStatus === null) return undefined;
    let alive = true;
    call<DraftListResponse>('GET', `/api/drafts?status=${otherStatus}`, { publicSpace })
      .then((page) => {
        if (alive) setOther({ status: otherStatus, lane: toLane(page) });
      })
      .catch((err: unknown) => {
        if (alive) setError(failureMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [otherStatus, publicSpace, refreshKey]);

  const laneOf = (status: DraftStatus): Lane | null =>
    !data ? null : status === 'NEEDS_REVIEW' ? data.review : status === 'READY' ? data.ready : other?.status === status ? other.lane : null;

  const more = async (status: DraftStatus) => {
    const lane = laneOf(status);
    if (!data || !lane || lane.nextCursor === null) return;
    setBusy(true);
    try {
      const page = await call<DraftListResponse>('GET', `/api/drafts?status=${status}&cursor=${lane.nextCursor}`, { publicSpace });
      const next: Lane = { items: [...lane.items, ...page.items], nextCursor: page.nextCursor };
      if (status === 'NEEDS_REVIEW') setData({ ...data, review: next });
      else if (status === 'READY') setData({ ...data, ready: next });
      else setOther({ status, lane: next });
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const options: StatOption<View>[] = [
    { key: 'WAITING', label: '대기', value: `${waiting}건` },
    ...STATUS_ORDER.map((status) => ({
      key: status,
      label: STATUS_LABELS[status],
      value: `${count(status)}건`,
      tone: count(status) === 0 ? undefined : status === 'NEEDS_REVIEW' ? ('warn' as const) : status === 'READY' ? ('ok' as const) : status === 'FAILED' ? ('danger' as const) : undefined,
      disabled: !isLane(status) && count(status) === 0 && view !== status,
    })),
  ];

  /** 한 상태의 묶음: 제목 줄(+ 사유로 거르기) → 표 → 더 보기. hideEmpty 면 비었을 때 아무것도 그리지 않는다(대기 보기에서 쓴다). */
  const section = (status: DraftStatus, hideEmpty: boolean) => {
    const lane = laneOf(status);
    if (hideEmpty && lane !== null && lane.items.length === 0) return null;
    // 사유로 거르기(화면에서만). 읽어 온 건에 붙은 사유만 고를 수 있다.
    const reasonCounts = new Map<ReasonCode, number>();
    if (status === 'NEEDS_REVIEW' && lane) {
      for (const item of lane.items) for (const code of item.reasons) reasonCounts.set(code, (reasonCounts.get(code) ?? 0) + 1);
    }
    const reasonOptions = REASON_ORDER.filter((code) => reasonCounts.has(code));
    const activeReason = reason !== 'all' && reasonCounts.has(reason) ? reason : 'all';
    const groups: Group[] = !lane
      ? []
      : status !== 'NEEDS_REVIEW'
        ? [{ code: undefined, items: lane.items }]
        : activeReason === 'all'
          ? groupByReason(lane.items)
          : [{ code: activeReason, items: lane.items.filter((item) => item.reasons.includes(activeReason)) }];
    return (
      <section key={status} aria-label={STATUS_LABELS[status]}>
        <div className={styles.listHead}>
          <div className={styles.listTitle}>
            <h3>
              {STATUS_LABELS[status]} <span className="count">{count(status)}건</span>
            </h3>
            {STATUS_NOTES[status] ? <p className="muted small">{STATUS_NOTES[status]}</p> : null}
          </div>
          {reasonOptions.length > 0 ? (
            <label className={styles.listFilter}>
              사유로 거르기
              <select value={activeReason} onChange={(e) => onReason(e.target.value as ReasonCode | 'all')}>
                <option value="all">모든 사유 ({lane?.items.length ?? 0}건)</option>
                {reasonOptions.map((code) => (
                  <option key={code} value={code}>
                    {REASONS[code].label} ({reasonCounts.get(code)}건)
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        {!lane ? (
          <Loading />
        ) : lane.items.length === 0 ? (
          <EmptyState
            title={`“${STATUS_LABELS[status]}” 상태인 초안이 없습니다.`}
            action={
              !publicSpace && isLane(status) ? (
                <Link className="btn" href="/">
                  작업 화면에서 글 넣기
                </Link>
              ) : undefined
            }
          />
        ) : (
          <DraftTable groups={groups} publicSpace={publicSpace} status={status} />
        )}

        {lane && lane.nextCursor !== null ? (
          <div className={styles.listFoot}>
            <button type="button" className="btn small" disabled={busy} onClick={() => void more(status)}>
              더 보기
            </button>
            <span className="muted small">지금까지 {lane.items.length}건을 읽어 왔습니다. 사유로 거르기는 읽어 온 건 안에서만 합니다.</span>
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <>
      {publicSpace ? <p className={styles.spaceNote}>{SPACE_NOTES[space]}</p> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!data && !error ? <Loading /> : null}
      {data ? (
        <>
          <StatFilter label="상태로 거르기" options={options} value={view} onChange={onPick} />
          {view !== 'WAITING' ? (
            section(view, false)
          ) : waiting === 0 ? (
            <EmptyState
              title="대기 중인 초안이 없습니다."
              action={
                publicSpace ? undefined : (
                  <Link className="btn" href="/">
                    작업 화면에서 글 넣기
                  </Link>
                )
              }
            >
              확인 필요와 바로 승인 가능이 모두 0건입니다.
            </EmptyState>
          ) : (
            <>
              {section('NEEDS_REVIEW', true)}
              {section('READY', true)}
            </>
          )}
        </>
      ) : null}
    </>
  );
}

export function Inbox() {
  const mounted = useMounted();
  const workspace = useWorkspace();
  const role = useRole();
  const [refreshKey, setRefreshKey] = useState(0);
  const [waiting, setWaiting] = useState<Waiting>({});
  // 고른 것은 주소에 있다. 고르지 않았으면 내 작업 공간을, 아직 넣은 글이 없으면 본보기 공간을 먼저 보여 준다.
  const query = new URLSearchParams(useQuery());
  const pickedSpace = query.get('space');
  const space: SpaceKey = pickedSpace === 'mine' || pickedSpace === 'demo' ? pickedSpace : workspace ? 'mine' : 'demo';
  const status = query.get('status');
  const picked: View | null = isView(status) ? status : null;
  const reasonParam = query.get('reason');
  const reason: ReasonCode | 'all' = (REASON_CODES as readonly string[]).includes(reasonParam ?? '') ? (reasonParam as ReasonCode) : 'all';
  const waitingText = (key: SpaceKey) => (key === 'mine' && !workspace ? '대기 0건' : waiting[key] === undefined ? undefined : `대기 ${waiting[key]}건`);
  // 공간을 바꾸면 그 공간의 처음 보기(대기)로 간다.
  const pickSpace = (next: SpaceKey) => setQuery({ space: next, status: null, reason: null });
  const view = (key: SpaceKey) => ({
    picked: space === key ? picked : null,
    onPick: (next: View) => setQuery({ status: next === 'WAITING' ? null : next, reason: null }),
    reason: space === key ? reason : ('all' as const),
    onReason: (next: ReasonCode | 'all') => setQuery({ reason: next === 'all' ? null : next }),
  });

  return (
    <main className="page wide">
      <PageHead
        title="검수함"
        lead={
          role === 'seller'
            ? '셀러로 보는 중입니다. 내가 넣은 글의 초안을 열어 못 찾은 칸을 채울 수 있습니다.'
            : '운영자로 보는 중입니다. 한 건을 열어 승인하거나, 고쳐서 승인하거나, 사유를 골라 반려합니다.'
        }
        actions={
          <button type="button" className="btn" onClick={() => setRefreshKey((k) => k + 1)}>
            새로 고침
          </button>
        }
        about={
          <>
            <p>공간을 고르고, 상태 숫자를 누르면 그 상태의 초안만 아래 표에 나옵니다. 줄을 누르면 그 초안이 열립니다.</p>
            <p>“대기”는 사람이 볼 차례인 건수입니다(확인 필요 + 바로 승인 가능). 처음에는 이 둘이 함께 보입니다.</p>
            <p>내 작업 공간: {SPACE_NOTES.mine}</p>
            <p>본보기 공간 (읽기 전용): {SPACE_NOTES.demo}</p>
          </>
        }
      />
      {!mounted ? (
        <Loading />
      ) : (
        <>
          <SpaceTabs prefix="inbox" value={space} onChange={pickSpace} counts={{ mine: waitingText('mine'), demo: waitingText('demo') }} />
          <SpacePanel prefix="inbox" space="mine" active={space === 'mine'}>
            {workspace ? (
              <Space key={workspace} space="mine" refreshKey={refreshKey} report={setWaiting} {...view('mine')} />
            ) : (
              <EmptyState
                title="아직 넣은 글이 없습니다."
                action={
                  <>
                    <Link className="btn primary" href="/">
                      작업 화면으로 가기
                    </Link>
                    <button type="button" className="btn" onClick={() => pickSpace('demo')}>
                      본보기 공간 보기
                    </button>
                  </>
                }
              >
                <Link href="/">작업 화면</Link>에서 “이 글로 초안 만들기”를 누르면 여기에 쌓입니다.
              </EmptyState>
            )}
          </SpacePanel>
          <SpacePanel prefix="inbox" space="demo" active={space === 'demo'}>
            <Space space="demo" refreshKey={refreshKey} report={setWaiting} {...view('demo')} />
          </SpacePanel>
        </>
      )}
    </main>
  );
}
