'use client';

// 점검 화면. 한 번 누르면 등록된 상품 전체(또는 올린 양식 꼴 파일)를 살펴 사유별 묶음과 상품별 목록을 보여 준다.
// 판단은 서버가 한다(POST /api/audits). 이 화면은 결과를 보여 주기만 한다.
import Link from 'next/link';
import { useState } from 'react';
import { WORKSPACE_HEADER } from '@/contract/api';
import { TYPE_LABELS } from '@/contract/fields';
import {
  AUDIT_CODE_DEFS,
  AUDIT_CODES,
  AUDIT_LIMITS,
  AUDIT_SEVERITY_LABELS,
  type AuditItem,
  type AuditResponse,
  type AuditSeverity,
} from '@/contract/tools/audit';
import { CopyButton, Notice } from '../../components/bits';
import { call, failureMessage, getWorkspace, productHref, useMounted, useWorkspace } from '../../components/client';

type Target = { kind: 'mine' } | { kind: 'public' } | { kind: 'file'; file: File };

const SEVERITY_CLASS: Record<AuditSeverity, string> = { error: 'status status-FAILED', warning: 'status status-NEEDS_REVIEW' };

/** 같은 점검을 CSV 로 다시 받는다. 공간 헤더를 실어야 해서 그냥 링크로는 받지 못한다. */
async function fetchCsv(target: Target): Promise<string> {
  const headers: Record<string, string> = {};
  const workspace = target.kind === 'public' ? null : getWorkspace();
  if (workspace) headers[WORKSPACE_HEADER] = workspace;
  let body: BodyInit;
  if (target.kind === 'file') {
    const form = new FormData();
    form.append(AUDIT_LIMITS.formField, target.file);
    body = form;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ source: 'workspace' });
  }
  const response = await fetch('/api/audits?format=csv', { method: 'POST', headers, body, cache: 'no-store' });
  if (!response.ok) throw new Error('csv');
  return response.text();
}

function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function targetLabel(target: Target): string {
  if (target.kind === 'file') return `올린 파일 "${target.file.name}"`;
  return target.kind === 'mine' ? '내 작업 공간의 상품' : '본보기 공간의 상품';
}

function ItemCard({ item, linked, publicSpace }: { item: AuditItem; linked: boolean; publicSpace: boolean }) {
  const title = `${item.rowNumber !== null ? `${item.rowNumber}번째 줄` : `#${item.productId ?? ''}`} ${item.name ?? '(이름 없음)'}`;
  return (
    <li className="card">
      {linked && item.productId !== null ? (
        <Link href={productHref(item.productId, publicSpace)} className="card-title">
          {title}
        </Link>
      ) : (
        <span className="card-title">{title}</span>
      )}
      <div className="muted small">
        {item.type ? TYPE_LABELS[item.type] : '종류 모름'} · {item.subtype ?? '갈래 없음'}
        {item.rowNumber !== null && item.productId !== null ? ` · 상품번호 ${item.productId}` : ''}
      </div>
      <ul className="reasons">
        {item.findings.map((f, i) => (
          <li key={`${f.code}-${f.field ?? ''}-${i}`}>
            <span className={SEVERITY_CLASS[f.severity]}>{AUDIT_SEVERITY_LABELS[f.severity]}</span>{' '}
            <span className="flag" title={AUDIT_CODE_DEFS[f.code].description}>
              {AUDIT_CODE_DEFS[f.code].label}
            </span>{' '}
            {f.message}
          </li>
        ))}
      </ul>
    </li>
  );
}

function Result({ result, target }: { result: AuditResponse; target: Target }) {
  const [csv, setCsv] = useState<{ state: 'idle' | 'busy' | 'failed' } | { state: 'done'; text: string }>({ state: 'idle' });
  const { totals } = result;
  const withFindings = result.items.filter((i) => i.findings.length > 0);
  const clean = result.items.filter((i) => i.findings.length === 0);

  const download = async () => {
    setCsv({ state: 'busy' });
    try {
      const text = await fetchCsv(target);
      setCsv({ state: 'done', text: text.replace(/^﻿/, '') });
      saveFile('chaeum-audit.csv', text);
    } catch {
      setCsv({ state: 'failed' });
    }
  };

  return (
    <section className="export" aria-label="점검 결과" aria-live="polite">
      <h2>점검 결과</h2>
      <p className="muted small">살핀 곳: {targetLabel(target)}. 이 결과는 저장되지 않습니다. 다시 누르면 지금의 값과 용어로 다시 살핍니다.</p>

      {result.file && result.file.missingHeaders.length > 0 ? (
        <Notice kind="warn">
          파일에 없던 칸 이름: {result.file.missingHeaders.join(', ')}. 열이 없는 칸은 값이 비었는지 알 수 없어 살피지 않았습니다.
        </Notice>
      ) : null}
      {result.truncated ? (
        <Notice kind="warn">
          한 번에 {AUDIT_LIMITS.maxItems}건까지만 살핍니다. 앞의 {totals.items}건만 살폈고 그 뒤는 살피지 않았습니다.
        </Notice>
      ) : null}

      {totals.items === 0 ? (
        <Notice>
          살필 상품이 없습니다.{' '}
          {target.kind === 'file'
            ? '파일에 칸 이름 줄만 있고 상품 줄이 없습니다.'
            : target.kind === 'public'
              ? '본보기 공간에 승인된 상품이 아직 없습니다.'
              : '이 공간에 승인한 상품이 아직 없습니다. 검수함에서 초안을 승인하면 상품이 됩니다.'}
        </Notice>
      ) : totals.findings === 0 ? (
        <Notice>
          살핀 {totals.items}건에서 문제를 찾지 못했습니다. 아래 &ldquo;이 점검이 보는 것&rdquo;에 적힌 것만 봤습니다. 값이 사실과 맞는지, 번역이 자연스러운지는 보지
          않습니다.
        </Notice>
      ) : (
        <p>
          <strong>
            {totals.items}건 가운데 {totals.itemsWithFindings}건에서 문제 {totals.findings}개
          </strong>
          를 찾았습니다({AUDIT_SEVERITY_LABELS.error} {totals.bySeverity.error ?? 0}개, {AUDIT_SEVERITY_LABELS.warning} {totals.bySeverity.warning ?? 0}개).
        </p>
      )}

      {result.byCode.length > 0 ? (
        <>
          <h3>사유별</h3>
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">사유</th>
                  <th scope="col">갈래</th>
                  <th scope="col">문제 수</th>
                  <th scope="col">걸린 상품 수</th>
                </tr>
              </thead>
              <tbody>
                {result.byCode.map((row) => (
                  <tr key={row.code}>
                    <th scope="row">
                      {row.label}
                      <span className="muted small">{AUDIT_CODE_DEFS[row.code].description}</span>
                    </th>
                    <td>
                      <span className={SEVERITY_CLASS[row.severity]}>{AUDIT_SEVERITY_LABELS[row.severity]}</span>
                    </td>
                    <td>{row.findings}</td>
                    <td>{row.items}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>
            상품별 <span className="count">문제가 있는 {withFindings.length}건</span>
          </h3>
          <ul className="cards">
            {withFindings.map((item) => (
              <ItemCard key={item.key} item={item} linked={target.kind !== 'file'} publicSpace={target.kind === 'public'} />
            ))}
          </ul>

          <div className="actions">
            <button type="button" className="btn" disabled={csv.state === 'busy'} onClick={download}>
              결과를 CSV로 내려받기
            </button>
            <span className="muted small">문제 하나가 한 줄입니다. 문제 없는 상품은 줄이 없습니다.</span>
          </div>
          {csv.state === 'failed' ? <Notice kind="error">CSV를 받지 못했습니다. 잠시 뒤 다시 해 주세요.</Notice> : null}
          {csv.state === 'done' ? (
            <>
              <pre className="code" tabIndex={0}>{csv.text}</pre>
              <CopyButton text={csv.text} label="내용 복사" />
            </>
          ) : null}
        </>
      ) : null}

      {clean.length > 0 && totals.findings > 0 ? (
        <details className="help">
          <summary>문제를 찾지 못한 상품 {clean.length}건</summary>
          <ul className="plain">
            {clean.map((item) => (
              <li key={item.key}>
                {item.rowNumber !== null ? `${item.rowNumber}번째 줄` : `#${item.productId ?? ''}`} {item.name ?? '(이름 없음)'}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

export function AuditTool() {
  const mounted = useMounted();
  const workspace = useWorkspace();
  const [space, setSpace] = useState<'mine' | 'public'>('mine');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ result: AuditResponse; target: Target } | null>(null);
  // 내 작업 공간이 아직 없으면 볼 수 있는 것은 본보기 공간뿐이다.
  const chosen: 'mine' | 'public' = workspace ? space : 'public';

  const run = async (target: Target) => {
    setBusy(true);
    setError(null);
    try {
      const result =
        target.kind === 'file'
          ? await call<AuditResponse>('POST', '/api/audits', { file: target.file, label: '점검 (올린 파일)' })
          : await call<AuditResponse>('POST', '/api/audits', {
              body: { source: 'workspace' },
              publicSpace: target.kind === 'public',
              label: target.kind === 'public' ? '점검 (본보기 공간)' : '점검 (내 작업 공간)',
            });
      setDone({ result, target });
    } catch (err) {
      setDone(null);
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <h1>점검</h1>
      <p className="muted">
        이미 올라간 상품 전체를 한 번에 살펴 &ldquo;어디가 잘못 올라가 있나&rdquo;를 봅니다. <strong>AI를 쓰지 않습니다.</strong> 초안을 따질 때 쓰는 규칙과 글
        검사를 등록된 상품에 그대로 다시 돌립니다. 아무것도 저장하거나 고치지 않습니다.
      </p>

      <section aria-label="등록된 상품 살피기">
        <h2>등록된 상품 살피기</h2>
        <div className="who" role="group" aria-label="어느 공간의 상품을 살필지">
          <button type="button" className="seg" aria-pressed={chosen === 'mine'} disabled={!mounted || !workspace} onClick={() => setSpace('mine')}>
            내 작업 공간
          </button>
          <button type="button" className="seg" aria-pressed={chosen === 'public'} onClick={() => setSpace('public')}>
            본보기 공간
          </button>
        </div>
        {mounted && !workspace ? (
          <p className="muted small">
            아직 내 작업 공간이 없어 본보기 공간만 살필 수 있습니다. <Link href="/">작업 화면</Link>에서 글을 넣고 <Link href="/inbox">검수함</Link>에서 승인하면
            내 상품이 생깁니다.
          </p>
        ) : null}
        <div className="actions">
          <button type="button" className="btn primary" disabled={busy || !mounted} onClick={() => run({ kind: chosen })}>
            {busy ? '살피는 중…' : '점검하기'}
          </button>
          <span className="muted small">본보기 공간은 읽기 전용이지만 점검은 읽기만 하므로 돌릴 수 있습니다.</span>
        </div>
      </section>

      <section aria-label="파일 살피기">
        <h2>파일 살피기</h2>
        <p className="muted small">
          <Link href="/products">상품 화면</Link>에서 기본 양식으로 내려받은 CSV(또는 XLSX)를 올리면 그 줄들을 같은 규칙으로 살핍니다. 파일은 저장하지 않습니다.{' '}
          {Math.round(AUDIT_LIMITS.fileMaxBytes / 1024 / 1024)}MB, {AUDIT_LIMITS.maxItems}줄까지입니다. 꼴대로 읽지 못한 칸은 값을 짐작하지 않고 &ldquo;읽지 못한
          칸&rdquo;으로 알립니다. 다른 양식의 파일은 이 화면에서는 읽지 못합니다(API에는 양식 이름을 줄 수 있습니다).
        </p>
        <div className="actions">
          <label>
            <span className="sr-only">살필 파일</span>
            <input type="file" accept=".csv,.xlsx,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button type="button" className="btn" disabled={busy || !file} onClick={() => (file ? run({ kind: 'file', file }) : undefined)}>
            이 파일 점검하기
          </button>
        </div>
      </section>

      {error ? <Notice kind="error">{error}</Notice> : null}
      {done ? <Result key={`${done.target.kind}-${done.result.totals.items}-${done.result.totals.findings}`} result={done.result} target={done.target} /> : null}

      <details className="help">
        <summary>이 점검이 보는 것 {AUDIT_CODES.length}가지</summary>
        <ul className="reasons">
          {AUDIT_CODES.map((code) => (
            <li key={code}>
              <span className={SEVERITY_CLASS[AUDIT_CODE_DEFS[code].severity]}>{AUDIT_SEVERITY_LABELS[AUDIT_CODE_DEFS[code].severity]}</span>{' '}
              <span className="flag">{AUDIT_CODE_DEFS[code].label}</span> {AUDIT_CODE_DEFS[code].description}
            </li>
          ))}
        </ul>
        <p className="muted small">
          글 문제는 두 가지를 함께 봅니다. 글자는 지금의 값과 지금 승인된 <Link href="/glossary">용어 사전</Link>으로 다시 검사합니다. 그래서 용어를 새로
          승인하면 전에 통과한 글이 &ldquo;용어 표기 다름&rdquo;으로 나올 수 있습니다. 그리고 상품에 &ldquo;확인 필요&rdquo;로 저장된 글(모델 글이 검사에 걸려
          코드의 틀 문장으로 바뀐 글)은 지금 글자가 검사를 통과해도 &ldquo;글 확인 필요&rdquo;로 냅니다. 상품 화면의 표시와 같습니다. 올린 파일에는 이 상태가
          실려 있지 않아 파일 점검에서는 나오지 않습니다. &ldquo;숫자 어긋남&rdquo;은 글의 숫자가 판매가, 가장 짧은 기간, 가장 적은 수량(굿즈는 최소 주문 수량),
          이름·지역에 든 숫자 가운데 어느 것과도 다를 때 붙습니다. 되는 숫자끼리 자리가 바뀐 글은 잡지 못합니다. 보지 않는 것: 값이 원문과 맞는지(등록된 상품에는 원문 근거가 붙어 있지
          않습니다), 번역이 자연스러운지, 같은 상품이 두 번 올라갔는지.
        </p>
      </details>
    </main>
  );
}
