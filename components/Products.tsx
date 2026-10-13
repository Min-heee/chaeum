'use client';

// 상품(승인된 것) 목록과 양식으로 내려받기.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ProductBody, ProductListResponse, ProductTextState } from '@/contract/api';
import { TYPE_LABELS } from '@/contract/fields';
import { CopyButton, Notice } from './bits';
import { call, callBlob, callText, failureMessage, pollUntil, productHref, useMounted, useWorkspace } from './client';
import { formatTime, won } from './format';

export const TEXT_STATE_LABELS: Record<ProductTextState, string> = {
  pending: '글 만드는 중',
  ok: '글 검사 통과',
  needs_review: '글 확인 필요',
};

export interface TemplateInfo {
  name: string;
  description: string | null;
}

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

function Export({ templates, disabled }: { templates: TemplateInfo[]; disabled: boolean }) {
  const [template, setTemplate] = useState(templates.find((t) => t.name === 'default')?.name ?? templates[0]?.name ?? 'default');
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = templates.find((t) => t.name === template);

  const download = async (kind: 'products' | 'corrections') => {
    setBusy(true);
    setError(null);
    try {
      const path = kind === 'products' ? `/api/export.csv?kind=products&template=${template}` : '/api/export.csv?kind=corrections';
      const text = await callText(path, { label: kind === 'products' ? `양식으로 내려받기 (${template})` : '사람이 고친 값 내려받기' });
      const name = kind === 'products' ? `products-${template}.csv` : 'corrections.csv';
      setPreview({ name, text: text.replace(/^﻿/, '') });
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
      saveFile(`chaeum-products-${template}.xlsx`, file);
      setPreview(null);
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="export" aria-label="양식으로 내려받기">
      <h2>양식으로 내려받기</h2>
      <p className="muted small">
        승인된 상품이 등록 양식 꼴의 CSV 한 줄씩으로 나옵니다. 양식 맞춤 파일(칸 이름·순서 대응표)을 바꾸면 다른 마켓의 양식 꼴로 나옵니다.
        엑셀 파일(XLSX)은 같은 양식을 시트 셋으로 나눕니다: 상품(한 줄에 하나), 옵션(기간·수량 옵션 하나가 한 줄), 안내.
      </p>
      <div className="actions">
        <label>
          양식{' '}
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
      </div>
      {chosen?.description ? <p className="muted small">{chosen.description}</p> : null}
      {disabled ? <p className="muted small">아직 승인한 상품이 없어 내려받을 것이 없습니다.</p> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {preview ? (
        <>
          <p className="muted small">방금 내려받은 {preview.name}의 내용입니다.</p>
          <pre className="code" tabIndex={0}>{preview.text}</pre>
          <CopyButton text={preview.text} label="내용 복사" />
        </>
      ) : null}
    </section>
  );
}

function Row({ product, publicSpace = false }: { product: ProductBody; publicSpace?: boolean }) {
  return (
    <li className="card">
      <Link href={productHref(product.id, publicSpace)} className="card-title">
        #{product.id} {product.name}
      </Link>
      <div className="muted small">
        {TYPE_LABELS[product.type]} · {product.subtype} · {won(product.price_krw)} · {formatTime(product.createdAt)}에 승인
      </div>
      <span className={`status text-${product.textState}`}>{TEXT_STATE_LABELS[product.textState]}</span>
    </li>
  );
}

export function Products({ templates }: { templates: TemplateInfo[] }) {
  const mounted = useMounted();
  const workspace = useWorkspace();
  const [items, setItems] = useState<ProductBody[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState<ProductBody[] | null>(null);

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

  return (
    <main className="page">
      <h1>상품</h1>
      <p className="muted">승인된 초안이 상품이 됩니다. 상품마다 영어·중국어(간체) 제목과 요약이 붙고, 글 검사 결과가 남습니다.</p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!mounted ? (
        <p className="muted">읽어 오는 중…</p>
      ) : !workspace ? (
        <p className="muted">
          아직 승인한 상품이 없습니다. <Link href="/">작업 화면</Link>에서 초안을 만들고 <Link href="/inbox">검수함</Link>에서 승인하면 여기에 생깁니다.
        </p>
      ) : items === null && !error ? (
        <p className="muted">읽어 오는 중…</p>
      ) : items && items.length === 0 ? (
        <p className="muted">
          아직 승인한 상품이 없습니다. <Link href="/inbox">검수함</Link>에서 한 건을 열어 승인해 보세요.
        </p>
      ) : (
        <ul className="cards">
          {(items ?? []).map((p) => (
            <Row key={p.id} product={p} />
          ))}
        </ul>
      )}
      <Export templates={templates} disabled={!workspace || !items || items.length === 0} />
      {demo && demo.length > 0 ? (
        <section aria-label="본보기 공간">
          <h2>본보기 공간 (읽기 전용)</h2>
          <p className="muted small">
            사이트를 처음 깔 때 보기 글의 초안 가운데 {demo.length}건을 미리 승인해 넣어 둔 상품입니다(사람이 눌러 승인한 것이 아닙니다). 도구(점검·견적·시안 검사·달력·비교)가 이 상품으로 돌아갑니다. 내려받기는
            내 작업 공간의 상품만 됩니다.
          </p>
          <ul className="cards">
            {demo.map((p) => (
              <Row key={p.id} product={p} publicSpace />
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
