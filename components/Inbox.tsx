'use client';

// 검수함. 두 갈래(확인 필요 / 바로 승인 가능)이고, 확인 필요는 사유별로 묶는다.
// 내 공간의 것과 읽기 전용 본보기 공간의 것을 나눠 보여 준다.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { DraftListItemBody, DraftListResponse } from '@/contract/api';
import { TYPE_LABELS } from '@/contract/fields';
import { REASONS, REASON_CODES, type ReasonCode } from '@/contract/reasons';
import { DRAFT_STATUSES, STATUS_LABELS, type DraftStatus } from '@/contract/transitions';
import { Notice, ReasonChips, StatusBadge } from './bits';
import { call, failureMessage, useMounted, useRole, useWorkspace } from './client';
import { formatTime } from './format';

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

const SOURCE_KIND_LABELS = { text: '글', image: '그림', pdf: 'PDF' } as const;

interface Lane {
  items: DraftListItemBody[];
  nextCursor: number | null;
}

interface SpaceData {
  review: Lane;
  ready: Lane;
  counts: Partial<Record<DraftStatus, number>>;
}

async function loadSpace(publicSpace: boolean): Promise<SpaceData> {
  const [review, ready] = await Promise.all([
    call<DraftListResponse>('GET', '/api/drafts?status=NEEDS_REVIEW', { publicSpace }),
    call<DraftListResponse>('GET', '/api/drafts?status=READY', { publicSpace }),
  ]);
  return {
    review: { items: review.items, nextCursor: review.nextCursor },
    ready: { items: ready.items, nextCursor: ready.nextCursor },
    counts: review.counts,
  };
}

function Item({ item, publicSpace }: { item: DraftListItemBody; publicSpace: boolean }) {
  const title = item.name ?? (item.type === 'not_product' ? '(등록 대상이 아닌 글)' : '(이름을 찾지 못함)');
  return (
    <li className="card">
      <Link href={`/drafts/${item.id}${publicSpace ? '?pub=1' : ''}`} className="card-title">
        #{item.id} {title}
      </Link>
      <div className="muted small">
        {item.type ? TYPE_LABELS[item.type] : '종류 모름'}
        {item.subtype ? ` · ${item.subtype}` : ''} · {SOURCE_KIND_LABELS[item.sourceKind]}로 들어옴 ·{' '}
        {item.extractedBy === 'rules' ? '규칙만으로 뽑음' : item.extractedBy === 'llm' ? (publicSpace ? 'AI로 뽑음(미리 받아 둔 답)' : 'AI로 뽑음') : '아직 안 뽑음'} · {formatTime(item.updatedAt)}
      </div>
      <p className="preview">{item.preview}</p>
      <ReasonChips codes={item.reasons} />
    </li>
  );
}

function groupByReason(items: DraftListItemBody[]): { code: ReasonCode | null; items: DraftListItemBody[] }[] {
  const groups = new Map<ReasonCode | null, DraftListItemBody[]>();
  for (const item of items) {
    const code = GROUP_ORDER.find((c) => item.reasons.includes(c)) ?? item.reasons[0] ?? null;
    groups.set(code, [...(groups.get(code) ?? []), item]);
  }
  const order = [...GROUP_ORDER, ...REASON_CODES.filter((c) => !GROUP_ORDER.includes(c)), null];
  return order.filter((code) => groups.has(code)).map((code) => ({ code, items: groups.get(code) ?? [] }));
}

function Space({ title, note, publicSpace, refreshKey }: { title: string; note: string; publicSpace: boolean; refreshKey: number }) {
  const [data, setData] = useState<SpaceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [other, setOther] = useState<{ status: DraftStatus; items: DraftListItemBody[] } | null>(null);

  useEffect(() => {
    let alive = true;
    loadSpace(publicSpace)
      .then((got) => {
        if (!alive) return;
        setData(got);
        setError(null);
      })
      .catch((err: unknown) => {
        if (alive) setError(failureMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [publicSpace, refreshKey]);

  const more = async (lane: 'review' | 'ready') => {
    if (!data || data[lane].nextCursor === null) return;
    const status = lane === 'review' ? 'NEEDS_REVIEW' : 'READY';
    try {
      const page = await call<DraftListResponse>('GET', `/api/drafts?status=${status}&cursor=${data[lane].nextCursor}`, { publicSpace });
      setData({ ...data, [lane]: { items: [...data[lane].items, ...page.items], nextCursor: page.nextCursor } });
    } catch (err) {
      setError(failureMessage(err));
    }
  };

  const showOther = async (status: DraftStatus) => {
    try {
      const page = await call<DraftListResponse>('GET', `/api/drafts?status=${status}`, { publicSpace });
      setOther({ status, items: page.items });
    } catch (err) {
      setError(failureMessage(err));
    }
  };

  const count = (status: DraftStatus) => data?.counts[status] ?? 0;
  const others = DRAFT_STATUSES.filter((s) => s !== 'NEEDS_REVIEW' && s !== 'READY');

  return (
    <section className="space-block" aria-label={title}>
      <h2>{title}</h2>
      <p className="muted small">{note}</p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!data && !error ? <p className="muted">읽어 오는 중…</p> : null}
      {data ? (
        <>
          <div className="lanes">
            <section className="lane" aria-label="확인 필요">
              <h3>
                확인 필요 <span className="count">{count('NEEDS_REVIEW')}건</span>
              </h3>
              <p className="muted small">표시가 하나라도 붙은 초안입니다. 사유별로 묶었습니다.</p>
              {data.review.items.length === 0 ? <p className="muted">없습니다.</p> : null}
              {groupByReason(data.review.items).map((group) => (
                <div className="group" key={group.code ?? 'none'}>
                  <h4>
                    <span className="flag">{group.code ? REASONS[group.code].label : '사유 없음'}</span>{' '}
                    <span className="count">{group.items.length}건</span>
                  </h4>
                  {group.code ? <p className="muted small">{REASONS[group.code].description}</p> : null}
                  <ul className="cards">
                    {group.items.map((item) => (
                      <Item key={item.id} item={item} publicSpace={publicSpace} />
                    ))}
                  </ul>
                </div>
              ))}
              {data.review.nextCursor !== null ? (
                <button type="button" className="btn small" onClick={() => more('review')}>
                  더 보기
                </button>
              ) : null}
            </section>

            <section className="lane" aria-label="바로 승인 가능">
              <h3>
                바로 승인 가능 <span className="count">{count('READY')}건</span>
              </h3>
              <p className="muted small">표시가 0개인 초안입니다. 그래도 사람이 승인해야 상품이 됩니다.</p>
              {data.ready.items.length === 0 ? <p className="muted">없습니다.</p> : null}
              <ul className="cards">
                {data.ready.items.map((item) => (
                  <Item key={item.id} item={item} publicSpace={publicSpace} />
                ))}
              </ul>
              {data.ready.nextCursor !== null ? (
                <button type="button" className="btn small" onClick={() => more('ready')}>
                  더 보기
                </button>
              ) : null}
            </section>
          </div>

          <div className="others">
            <span className="muted small">그 밖의 상태:</span>{' '}
            {others.map((status) => (
              <button
                key={status}
                type="button"
                className="btn small"
                aria-pressed={other?.status === status}
                disabled={count(status) === 0}
                onClick={() => (other?.status === status ? setOther(null) : void showOther(status))}
              >
                {STATUS_LABELS[status]} {count(status)}건
              </button>
            ))}
            {other ? (
              <ul className="cards">
                {other.items.map((item) => (
                  <li key={item.id} className="card">
                    <Link href={`/drafts/${item.id}${publicSpace ? '?pub=1' : ''}`} className="card-title">
                      #{item.id} {item.name ?? '(이름 없음)'}
                    </Link>{' '}
                    <StatusBadge status={item.status} />
                    <p className="preview">{item.preview}</p>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

export function Inbox() {
  const mounted = useMounted();
  const workspace = useWorkspace();
  const role = useRole();
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <main className="page wide">
      <div className="head">
        <h1>검수함</h1>
        <button type="button" className="btn small" onClick={() => setRefreshKey((k) => k + 1)}>
          새로 고침
        </button>
      </div>
      <p className="muted">
        {role === 'seller'
          ? '셀러로 보는 중입니다. 내가 넣은 글의 초안을 열어 못 찾은 칸을 채울 수 있습니다.'
          : '운영자로 보는 중입니다. 한 건을 열어 승인하거나, 고쳐서 승인하거나, 사유를 골라 반려합니다.'}
      </p>
      {!mounted ? (
        <p className="muted">읽어 오는 중…</p>
      ) : (
        <>
          {workspace ? (
            <Space key={workspace} title="내 공간" note="이 브라우저에서 넣은 글의 초안입니다. 고치고 승인할 수 있습니다." publicSpace={false} refreshKey={refreshKey} />
          ) : (
            <section className="space-block">
              <h2>내 공간</h2>
              <p className="muted">
                아직 넣은 글이 없습니다. <Link href="/">작업 화면</Link>에서 “이 글로 초안 만들기”를 누르면 여기에 쌓입니다.
              </p>
            </section>
          )}
          <Space
            title="본보기 공간 (읽기 전용)"
            note="미리 들어 있는 건입니다. 열어서 볼 수 있고, “내 공간으로 가져와 고치기”를 누르면 고치고 승인할 수 있습니다."
            publicSpace
            refreshKey={refreshKey}
          />
        </>
      )}
    </main>
  );
}
