'use client';

// 상품(승인된 것) 목록과 양식으로 내려받기.
// 내려받기는 위쪽 도구 막대에, 목록은 표로. 내 작업 공간과 본보기 공간은 검수함과 같은 탭으로 가른다.
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { ProductBody, ProductListResponse, ProductTextState } from '@/contract/api';
import { TYPE_LABELS } from '@/contract/fields';
import { Badge, CopyButton, EmptyState, Loading, Notice, PageHead, Toolbar, type Tone } from './bits';
import { call, callBlob, callText, failureMessage, pollUntil, productHref, setQuery, useMounted, useQuery, useWorkspace } from './client';
import { formatTime, won } from './format';
import { SpacePanel, SpaceTabs, StatFilter, useRowOpen, useStackBelow, type SpaceKey, type StatOption } from './ListParts';
import styles from './ListParts.module.css';

export const TEXT_STATE_LABELS: Record<ProductTextState, string> = {
  pending: '글 만드는 중',
  ok: '글 검사 통과',
  needs_review: '글 확인 필요',
};

/** 글 검사 결과 배지의 색. 확인 필요는 "사람이 봐야 한다"는 노랑이다. */
export const TEXT_STATE_TONES: Record<ProductTextState, Tone> = { pending: 'info', ok: 'ok', needs_review: 'warn' };

export interface TemplateInfo {
  name: string;
  description: string | null;
}

type TextFilter = 'all' | ProductTextState;

/** 표 여섯 칸이 가로로 밀리지 않고 들어가는 너비. 이보다 좁은 자리에서는 한 건을 한 덩이로 쌓는다. */
const STACK_BELOW = 730;

/** 받은 CSV 글이나 XLSX 파일을 내려 준다. 공간 헤더를 실어야 해서 그냥 링크로는 받지 못한다. */
function saveFile(name: string, content: string | Blob) {
  const url = URL.createObjectURL(typeof content === 'string' ? new Blob([content], { type: 'text/csv;charset=utf-8' }) : content);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 내려받기 도구 막대. 받는 것은 늘 내 작업 공간의 상품이다. note 는 버튼 바로 아래에 적는 한 줄(누를 수 없는 까닭 등)이다. */
function Export({ templates, disabled, note, count }: { templates: TemplateInfo[]; disabled: boolean; note: string | null; count: number }) {
  const [template, setTemplate] = useState(templates.find((t) => t.name === 'default')?.name ?? templates[0]?.name ?? 'default');
  /** 방금 내려받은 것. text 가 있으면(CSV) 내용을 펼쳐 볼 수 있다. */
  const [done, setDone] = useState<{ name: string; line: string; text: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = templates.find((t) => t.name === template);
  const sectionRef = useRef<HTMLElement | null>(null);

  // 상품 상세의 "양식으로 내려받기"로 왔으면(#export) 이 막대를 보여 주고, 버튼이 눌릴 수 있게 되면 그 버튼에 초점을 둔다(한 번만).
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current || disabled || window.location.hash !== '#export') return;
    arrived.current = true;
    sectionRef.current?.scrollIntoView({ block: 'nearest' });
    sectionRef.current?.querySelector<HTMLElement>('button.primary')?.focus();
  }, [disabled]);

  const download = async (kind: 'products' | 'corrections') => {
    setBusy(true);
    setError(null);
    try {
      const path = kind === 'products' ? `/api/export.csv?kind=products&template=${template}` : '/api/export.csv?kind=corrections';
      const text = await callText(path, { label: kind === 'products' ? `양식으로 내려받기 (${template})` : '사람이 고친 값 내려받기' });
      const name = kind === 'products' ? `products-${template}.csv` : 'corrections.csv';
      setDone({ name, line: kind === 'products' ? `상품 ${count}건을 ${name} 로 내려받았습니다.` : `사람이 고친 값을 ${name} 로 내려받았습니다.`, text: text.replace(/^﻿/, '') });
      saveFile(name, text);
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const downloadXlsx = async () => {
    setBusy(true);
    setError(null);
    try {
      const file = await callBlob(`/api/export.xlsx?template=${template}`, { label: `엑셀 파일로 내려받기 (${template})` });
      const name = `chaeum-products-${template}.xlsx`;
      saveFile(name, file);
      setDone({ name, line: `상품 ${count}건을 ${name} 로 내려받았습니다(시트 셋: 상품·옵션·안내).`, text: null });
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section ref={sectionRef} id="export" className={`panel ${styles.exportPanel}`} aria-labelledby="export-title">
      <h2 id="export-title" className="sr-only">
        양식으로 내려받기
      </h2>
      <Toolbar>
        <label>
          양식
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            {templates.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn primary" disabled={busy || disabled} onClick={() => download('products')}>
          양식으로 내려받기
        </button>
        <button type="button" className="btn" disabled={busy || disabled} onClick={downloadXlsx}>
          엑셀 파일(XLSX)로 내려받기
        </button>
        <button type="button" className="btn" disabled={busy || disabled} onClick={() => download('corrections')}>
          사람이 고친 값 내려받기
        </button>
        {busy ? <Loading label="내려받는 중…" lines={0} /> : null}
      </Toolbar>
      {chosen?.description ? <p className="muted small">{chosen.description}</p> : null}
      {note ? <p className="muted small">{note}</p> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {done ? (
        <div className={styles.exportDone}>
          <p className="ok-line" role="status">
            {done.line}
          </p>
          {done.text !== null ? (
            <details className="help">
              <summary>방금 내려받은 {done.name}의 내용 보기</summary>
              <p className="muted small">방금 내려받은 {done.name}의 내용입니다.</p>
              <pre className="code" tabIndex={0}>
                {done.text}
              </pre>
              <CopyButton text={done.text} label="내용 복사" />
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** 상품 목록. 줄 전체가 눌린다. 좁은 화면에서는 한 건이 한 덩이로 쌓인다(그래도 표로 읽히게 role 을 적는다). */
function ProductTable({ items, publicSpace }: { items: ProductBody[]; publicSpace: boolean }) {
  const open = useRowOpen();
  const stackRef = useStackBelow(STACK_BELOW);
  return (
    <div className="table-wrap" ref={stackRef}>
      <table className={styles.list} role="table" aria-label={publicSpace ? '본보기 공간의 상품' : '내 작업 공간의 상품'}>
        <thead role="rowgroup">
          <tr role="row">
            <th role="columnheader" scope="col" className="tight num">
              번호
            </th>
            <th role="columnheader" scope="col">
              이름
            </th>
            <th role="columnheader" scope="col">
              종류 · 갈래
            </th>
            <th role="columnheader" scope="col" className="num">
              판매가
            </th>
            <th role="columnheader" scope="col" className="num">
              승인 시각
            </th>
            <th role="columnheader" scope="col" className="tight">
              글 검사
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {items.map((product) => {
            const href = productHref(product.id, publicSpace);
            return (
              <tr key={product.id} role="row" className={styles.rowLink} onClick={open(href)}>
                <td role="cell" className={`tight num ${styles.id}`}>
                  #{product.id}
                </td>
                <td role="cell" className={styles.name}>
                  <Link href={href} className={styles.title}>
                    {product.name}
                  </Link>
                </td>
                <td role="cell" className={styles.meta}>
                  {TYPE_LABELS[product.type]} · {product.subtype}
                </td>
                <td role="cell" className={`num ${styles.meta}`}>
                  {won(product.price_krw)}
                </td>
                <td role="cell" className={`num ${styles.meta}`} data-suffix="에 승인">
                  {formatTime(product.createdAt)}
                </td>
                <td role="cell" className={`tight ${styles.meta}`}>
                  <Badge tone={TEXT_STATE_TONES[product.textState]}>{TEXT_STATE_LABELS[product.textState]}</Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 요약 숫자(누르면 글 검사 결과로 거른다) + 표. */
function ProductList({ items, publicSpace }: { items: ProductBody[]; publicSpace: boolean }) {
  const [filter, setFilter] = useState<TextFilter>('all');
  const countOf = (state: ProductTextState) => items.filter((p) => p.textState === state).length;
  const active: TextFilter = filter !== 'all' && countOf(filter) === 0 ? 'all' : filter;
  const options: StatOption<TextFilter>[] = [
    { key: 'all', label: '전체', value: `${items.length}건` },
    // 글 만드는 중은 잠깐 지나가는 상태라 있을 때만 칸을 둔다.
    ...(['ok', 'needs_review', 'pending'] as const)
      .filter((state) => state !== 'pending' || countOf(state) > 0)
      .map((state) => ({
        key: state,
        label: TEXT_STATE_LABELS[state],
        value: `${countOf(state)}건`,
        tone: state === 'needs_review' && countOf(state) > 0 ? ('warn' as const) : undefined,
        disabled: countOf(state) === 0,
      })),
  ];
  return (
    <>
      <StatFilter label="글 검사 결과로 거르기" options={options} value={active} onChange={setFilter} />
      <ProductTable items={active === 'all' ? items : items.filter((p) => p.textState === active)} publicSpace={publicSpace} />
    </>
  );
}

export function Products({ templates }: { templates: TemplateInfo[] }) {
  const mounted = useMounted();
  const workspace = useWorkspace();
  const [items, setItems] = useState<ProductBody[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState<ProductBody[] | null>(null);
  // 고른 공간은 주소(?space=…)에 둔다. 한 건을 열었다가 뒤로 와도 그대로 남는다.
  const pickedParam = new URLSearchParams(useQuery()).get('space');
  const picked: SpaceKey | null = pickedParam === 'mine' || pickedParam === 'demo' ? pickedParam : null;
  const setPicked = (next: SpaceKey) => setQuery({ space: next });

  // 본보기 공간의 상품(읽기 전용). 공간 헤더 없이 읽는다.
  useEffect(() => {
    if (!mounted) return;
    let alive = true;
    call<ProductListResponse>('GET', '/api/products', { publicSpace: true })
      .then((list) => {
        if (alive) setDemo(list.items);
      })
      .catch(() => {
        if (alive) setDemo([]);
      });
    return () => {
      alive = false;
    };
  }, [mounted]);

  useEffect(() => {
    if (!mounted || !workspace) return;
    let alive = true;
    const read = () => call<ProductListResponse>('GET', '/api/products');
    // 글 작업이 남아 있으면 줄을 굴리며 기다린다.
    pollUntil(read, (list) => list.items.every((p) => p.textState !== 'pending'), 12)
      .then((list) => {
        if (alive) setItems(list.items);
      })
      .catch((err: unknown) => {
        if (alive) setError(failureMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [mounted, workspace]);

  const mine = workspace ? items : [];
  const hasDemo = demo !== null && demo.length > 0;
  // 본보기 상품이 없으면(읽지 못했을 때도) 탭 없이 내 작업 공간만 보여 준다.
  const showTabs = demo === null || hasDemo;
  // 고르지 않았으면 내 작업 공간을, 아직 승인한 상품이 없는 새 브라우저면 본보기 공간을 먼저 보여 준다.
  const space: SpaceKey = picked && (picked === 'mine' || showTabs) ? picked : workspace || !hasDemo ? 'mine' : 'demo';
  const ready = mounted && (workspace !== null || demo !== null);
  const nothingMine = mine !== null && mine.length === 0;

  const mineBody = (
    <>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!workspace ? (
        <EmptyState
          title="아직 승인한 상품이 없습니다."
          action={
            <>
              <Link className="btn primary" href="/">
                작업 화면으로 가기
              </Link>
              <Link className="btn" href="/inbox">
                검수함으로 가기
              </Link>
            </>
          }
        >
          <Link href="/">작업 화면</Link>에서 초안을 만들고 <Link href="/inbox">검수함</Link>에서 승인하면 여기에 생깁니다.
        </EmptyState>
      ) : items === null ? (
        error ? null : (
          <Loading />
        )
      ) : items.length === 0 ? (
        <EmptyState
          title="아직 승인한 상품이 없습니다."
          action={
            <Link className="btn primary" href="/inbox">
              검수함으로 가기
            </Link>
          }
        >
          <Link href="/inbox">검수함</Link>에서 한 건을 열어 승인해 보세요.
        </EmptyState>
      ) : (
        <ProductList items={items} publicSpace={false} />
      )}
    </>
  );

  return (
    <main className="page wide">
      <PageHead
        title="상품"
        lead="승인된 초안이 상품이 됩니다. 상품마다 영어·중국어(간체) 제목과 요약이 붙고, 글 검사 결과가 남습니다."
        about={
          <p>
            승인된 상품이 등록 양식 꼴의 CSV 한 줄씩으로 나옵니다. 양식 맞춤 파일(칸 이름·순서 대응표)을 바꾸면 다른 마켓의 양식 꼴로 나옵니다. 엑셀 파일(XLSX)은 같은 양식을
            시트 셋으로 나눕니다: 상품(한 줄에 하나), 옵션(기간·수량 옵션 하나가 한 줄), 안내.
          </p>
        }
      />
      {!ready ? (
        <Loading />
      ) : (
        <>
          {showTabs ? (
            <SpaceTabs
              prefix="products"
              value={space}
              onChange={setPicked}
              counts={{ mine: mine === null ? undefined : `${mine.length}건`, demo: demo === null ? undefined : `${demo.length}건` }}
            />
          ) : null}

          {/* 내려받기는 어느 탭을 보고 있든 내 작업 공간의 상품을 받는다. 내 상품이 있으면 늘 눌린다. */}
          <Export
            templates={templates}
            disabled={mine === null || mine.length === 0}
            count={mine?.length ?? 0}
            note={
              nothingMine
                ? space === 'demo'
                  ? '내려받기는 내 작업 공간의 상품만 됩니다. 아직 승인한 상품이 없어 내려받을 것이 없습니다.'
                  : '아직 승인한 상품이 없어 내려받을 것이 없습니다.'
                : space === 'demo'
                  ? `내려받기는 내 작업 공간의 상품만 됩니다. 지금 누르면 내 작업 공간의 상품 ${mine?.length ?? 0}건을 받습니다.`
                  : null
            }
          />

          {showTabs ? (
            <SpacePanel prefix="products" space="mine" active={space === 'mine'}>
              {mineBody}
            </SpacePanel>
          ) : (
            <section aria-label="내 작업 공간">{mineBody}</section>
          )}

          {showTabs ? (
            <SpacePanel prefix="products" space="demo" active={space === 'demo'}>
              {demo === null ? (
                <Loading />
              ) : (
                <>
                  <p className={styles.spaceNote}>
                    사이트를 처음 깔 때 보기 글의 초안 가운데 {demo.length}건을 미리 승인해 넣어 둔 상품입니다(사람이 눌러 승인한 것이 아닙니다). 도구(점검·견적·시안 검사·달력·비교)가 이
                    상품으로 돌아갑니다.
                  </p>
                  <ProductList items={demo} publicSpace />
                </>
              )}
            </SpacePanel>
          ) : null}
        </>
      )}
    </main>
  );
}
