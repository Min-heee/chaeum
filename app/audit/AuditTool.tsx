'use client';

// 점검 화면. 한 번 누르면 등록된 상품 전체(또는 올린 양식 꼴 파일)를 살펴 사유별 묶음과 상품별 목록을 보여 준다.
// 판단은 서버가 한다(POST /api/audits). 이 화면은 결과를 보여 주기만 한다(거르기도 화면에서만 한다).
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { WORKSPACE_HEADER } from '@/contract/api';
import { TYPE_LABELS } from '@/contract/fields';
import {
  AUDIT_CODE_DEFS,
  AUDIT_CODES,
  AUDIT_LIMITS,
  AUDIT_SEVERITIES,
  AUDIT_SEVERITY_LABELS,
  type AuditCode,
  type AuditFinding,
  type AuditItem,
  type AuditResponse,
  type AuditSeverity,
} from '@/contract/tools/audit';
import { Badge, CopyButton, EmptyState, Loading, Notice, PageHead, Stats, Toolbar, type Tone } from '../../components/bits';
import { call, failureMessage, getWorkspace, productHref, useMounted, useWorkspace } from '../../components/client';
import { setToolSpace, useToolSpace } from '../../components/space';
import styles from './audit.module.css';

type Target = { kind: 'mine' } | { kind: 'public' } | { kind: 'file'; file: File };

/** 갈래의 색: 값 문제는 빨강, 글 문제는 노랑(사람이 읽어 봐야 한다). */
const SEVERITY_TONE: Record<AuditSeverity, Tone> = { error: 'danger', warning: 'warn' };

/** 갈래가 뜻하는 것(약속 파일의 풀이 그대로). */
const SEVERITY_NOTES: Record<AuditSeverity, string> = { error: '상품 값이 틀렸습니다', warning: '다른 언어 글을 손봐야 합니다' };

function SeverityBadge({ severity }: { severity: AuditSeverity }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{AUDIT_SEVERITY_LABELS[severity]}</Badge>;
}

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

const itemTitle = (item: AuditItem): string => `${item.rowNumber !== null ? `${item.rowNumber}번째 줄` : `#${item.productId ?? ''}`} ${item.name ?? '(이름 없음)'}`;

/**
 * 문제 한 줄을 "어느 칸"과 "무엇이 문제"로 나눈다. 서버가 적은 글은 "칸 이름: 설명" 꼴이다.
 * 그 꼴이 아니면 나누지 않고 받은 글을 그대로 보여 준다(글을 고쳐 쓰지 않는다).
 */
function splitMessage(finding: AuditFinding): { where: string; what: string } {
  const at = finding.message.indexOf(': ');
  if (at > 0 && at <= 40) return { where: finding.message.slice(0, at), what: finding.message.slice(at + 2) };
  return { where: finding.field ?? '상품 전체', what: finding.message };
}

function Result({ result, target }: { result: AuditResponse; target: Target }) {
  const [csv, setCsv] = useState<{ state: 'idle' | 'busy' | 'failed' } | { state: 'done'; text: string }>({ state: 'idle' });
  const [severity, setSeverity] = useState<'all' | AuditSeverity>('all');
  const [code, setCode] = useState<'all' | AuditCode>('all');
  const top = useRef<HTMLElement>(null);
  const { totals } = result;
  const withFindings = result.items.filter((i) => i.findings.length > 0);
  const clean = result.items.filter((i) => i.findings.length === 0);
  const linked = target.kind !== 'file';
  const publicSpace = target.kind === 'public';

  // 결과가 화면 아래에 생기면(좁은 화면) 그 자리로 내려간다. 이미 보이면 움직이지 않는다.
  useEffect(() => {
    const el = top.current;
    if (el && el.getBoundingClientRect().top > window.innerHeight * 0.7) el.scrollIntoView({ block: 'start' });
  }, []);

  // 거르기: 화면에서만 한다. 숫자(요약, 사유별 표, CSV)는 거르기와 상관없이 전체다.
  const matches = (f: AuditFinding) => (severity === 'all' || f.severity === severity) && (code === 'all' || f.code === code);
  const groups = withFindings.map((item) => ({ item, findings: item.findings.filter(matches) })).filter((g) => g.findings.length > 0);
  const shown = groups.reduce((n, g) => n + g.findings.length, 0);
  const filtered = severity !== 'all' || code !== 'all';

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
    <section className={styles.result} aria-label="점검 결과" ref={top}>
      <div aria-live="polite">
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
          <p className={styles.summary}>
            <strong>
              {totals.items}건 가운데 {totals.itemsWithFindings}건에서 문제 {totals.findings}개
            </strong>
            를 찾았습니다({AUDIT_SEVERITY_LABELS.error} {totals.bySeverity.error ?? 0}개, {AUDIT_SEVERITY_LABELS.warning} {totals.bySeverity.warning ?? 0}개).
          </p>
        )}

        {totals.items > 0 ? (
          <Stats
            items={[
              { label: '살핀 상품', value: `${totals.items}건` },
              { label: '문제가 있는 상품', value: `${totals.itemsWithFindings}건`, note: `문제 ${totals.findings}개` },
              ...AUDIT_SEVERITIES.map((s) => {
                const n = totals.bySeverity[s] ?? 0;
                return { label: AUDIT_SEVERITY_LABELS[s], value: `${n}개`, note: SEVERITY_NOTES[s], tone: n > 0 ? (SEVERITY_TONE[s] as 'danger' | 'warn') : undefined };
              }),
            ]}
          />
        ) : null}
      </div>

      {result.byCode.length > 0 ? (
        <>
          <h3>사유별</h3>
          <div className={`table-wrap ${styles.byCode}`} tabIndex={0} role="region" aria-label="사유별 문제 수">
            <table>
              <thead>
                <tr>
                  <th scope="col">사유</th>
                  <th scope="col">갈래</th>
                  <th scope="col" className="num tight">
                    문제 수
                  </th>
                  <th scope="col" className="num tight">
                    걸린 상품 수
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.byCode.map((row) => (
                  <tr key={row.code}>
                    <th scope="row">
                      {row.label}
                      <span className="muted small">{AUDIT_CODE_DEFS[row.code].description}</span>
                    </th>
                    <td className="tight">
                      <SeverityBadge severity={row.severity} />
                    </td>
                    <td className="num tight">{row.findings}</td>
                    <td className="num tight">{row.items}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={`head ${styles.subhead}`}>
            <h3>
              상품별 <span className="count">문제가 있는 {withFindings.length}건</span>
            </h3>
            <button type="button" className="btn small" disabled={csv.state === 'busy'} onClick={download}>
              결과를 CSV로 내려받기
            </button>
          </div>
          <Toolbar label="문제 거르기">
            <div className="segmented" role="group" aria-label="갈래로 거르기">
              <button type="button" className="seg" aria-pressed={severity === 'all'} onClick={() => setSeverity('all')}>
                모두 {totals.findings}
              </button>
              {AUDIT_SEVERITIES.map((s) => (
                <button key={s} type="button" className="seg" aria-pressed={severity === s} disabled={(totals.bySeverity[s] ?? 0) === 0} onClick={() => setSeverity(s)}>
                  {AUDIT_SEVERITY_LABELS[s]} {totals.bySeverity[s] ?? 0}
                </button>
              ))}
            </div>
            <label>
              사유
              <select value={code} onChange={(e) => setCode(e.target.value as 'all' | AuditCode)}>
                <option value="all">모든 사유</option>
                {result.byCode.map((row) => (
                  <option key={row.code} value={row.code}>
                    {row.label} ({row.findings})
                  </option>
                ))}
              </select>
            </label>
            {filtered ? (
              <span className="muted small" role="status">
                {shown}개 보임 / 전체 {totals.findings}개
              </span>
            ) : null}
          </Toolbar>

          {groups.length === 0 ? (
            <EmptyState
              action={
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    setSeverity('all');
                    setCode('all');
                  }}
                >
                  거르기 풀기
                </button>
              }
            >
              고른 갈래와 사유에 맞는 문제가 없습니다.
            </EmptyState>
          ) : (
            <div className={`table-wrap ${styles.findings}`} tabIndex={0} role="region" aria-label="상품별 문제">
              <table>
                <thead>
                  <tr>
                    <th scope="col">상품</th>
                    <th scope="col">갈래</th>
                    <th scope="col">사유</th>
                    <th scope="col">어느 칸</th>
                    <th scope="col">무엇이 문제</th>
                  </tr>
                </thead>
                {groups.map(({ item, findings }) => (
                  <tbody key={item.key}>
                    {findings.map((f, i) => {
                      const { where, what } = splitMessage(f);
                      return (
                        <tr key={`${f.code}-${f.field ?? ''}-${i}`}>
                          {i === 0 ? (
                            <th scope="rowgroup" rowSpan={findings.length}>
                              {linked && item.productId !== null ? <Link href={productHref(item.productId, publicSpace)}>{itemTitle(item)}</Link> : itemTitle(item)}
                              <span className="muted small">
                                {item.type ? TYPE_LABELS[item.type] : '종류 모름'} · {item.subtype ?? '갈래 없음'}
                                {item.rowNumber !== null && item.productId !== null ? ` · 상품번호 ${item.productId}` : ''}
                              </span>
                            </th>
                          ) : null}
                          <td className="tight">
                            <SeverityBadge severity={f.severity} />
                          </td>
                          <td className="tight">
                            <span className="flag" title={AUDIT_CODE_DEFS[f.code].description}>
                              {AUDIT_CODE_DEFS[f.code].label}
                            </span>
                          </td>
                          <td className={styles.where}>{where}</td>
                          <td className={styles.what}>{what}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
              </table>
            </div>
          )}

          <p className="muted small">CSV에는 문제 하나가 한 줄입니다. 문제 없는 상품은 줄이 없습니다. 위에서 거른 것과 상관없이 찾은 문제가 모두 들어갑니다.</p>
          {csv.state === 'failed' ? <Notice kind="error">CSV를 받지 못했습니다. 잠시 뒤 다시 해 주세요.</Notice> : null}
          {csv.state === 'done' ? (
            <>
              <pre className="code" tabIndex={0}>
                {csv.text}
              </pre>
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
              <li key={item.key}>{itemTitle(item)}</li>
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
  // 어느 공간의 상품을 살필지. 고른 적이 없으면 내 작업 공간에 상품이 있을 때 내 작업 공간, 아니면 본보기 공간이다(다른 도구와 같은 규칙).
  const chosen = useToolSpace();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ result: AuditResponse; target: Target } | null>(null);
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
      <PageHead
        title="점검"
        lead={
          <>
            등록된 상품 전체를 한 번에 살핍니다. <strong>AI를 쓰지 않고</strong>, 아무것도 저장하거나 고치지 않습니다.
          </>
        }
        about={
          <p>
            이미 올라간 상품 전체를 한 번에 살펴 &ldquo;어디가 잘못 올라가 있나&rdquo;를 봅니다. <strong>AI를 쓰지 않습니다.</strong> 초안을 따질 때 쓰는 규칙과 글 검사를
            등록된 상품에 그대로 다시 돌립니다. 아무것도 저장하거나 고치지 않습니다.
          </p>
        }
      />

      <div className={styles.targets}>
        <section className="panel" aria-label="등록된 상품 살피기">
          <h2 className="panel-title">등록된 상품 살피기</h2>
          <div className="who" role="group" aria-label="어느 공간의 상품을 살필지">
            <button type="button" className="seg" aria-pressed={chosen === 'mine'} disabled={!mounted || !workspace} onClick={() => setToolSpace('mine')}>
              내 작업 공간
            </button>
            <button type="button" className="seg" aria-pressed={chosen === 'public'} onClick={() => setToolSpace('public')}>
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
            <button type="button" className="btn primary" disabled={busy || chosen === null} onClick={() => (chosen ? run({ kind: chosen }) : undefined)}>
              {busy ? '살피는 중…' : '점검하기'}
            </button>
          </div>
          <p className="hint">본보기 공간은 읽기 전용이지만 점검은 읽기만 하므로 돌릴 수 있습니다.</p>
        </section>

        <section className="panel" aria-label="파일 살피기">
          <h2 className="panel-title">파일 살피기</h2>
          <p className="muted small">
            <Link href="/products">상품 화면</Link>에서 기본 양식으로 내려받은 CSV(또는 XLSX)를 올리면 그 줄들을 같은 규칙으로 살핍니다. 파일은 저장하지 않습니다.{' '}
            {Math.round(AUDIT_LIMITS.fileMaxBytes / 1024 / 1024)}MB, {AUDIT_LIMITS.maxItems}줄까지입니다. 꼴대로 읽지 못한 칸은 값을 짐작하지 않고 &ldquo;읽지 못한
            칸&rdquo;으로 알립니다. 다른 양식의 파일은 이 화면에서는 읽지 못합니다(API에는 양식 이름을 줄 수 있습니다).
          </p>
          <label className="stack">
            살필 파일
            <input type="file" accept=".csv,.xlsx,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <div className="actions">
            <button type="button" className="btn" disabled={busy || !file} onClick={() => (file ? run({ kind: 'file', file }) : undefined)}>
              이 파일 점검하기
            </button>
          </div>
        </section>
      </div>

      {error ? <Notice kind="error">{error}</Notice> : null}
      {busy ? <Loading label="살피는 중…" /> : null}
      {done && !busy ? <Result key={`${done.target.kind}-${done.result.totals.items}-${done.result.totals.findings}`} result={done.result} target={done.target} /> : null}

      <details className="help">
        <summary>이 점검이 보는 것 {AUDIT_CODES.length}가지</summary>
        <div className={`table-wrap ${styles.codes}`} tabIndex={0} role="region" aria-label="이 점검이 보는 것">
          <table>
            <thead>
              <tr>
                <th scope="col">사유</th>
                <th scope="col">갈래</th>
                <th scope="col">무엇을 보나</th>
              </tr>
            </thead>
            <tbody>
              {AUDIT_CODES.map((code) => (
                <tr key={code}>
                  <th scope="row">
                    <span className="flag">{AUDIT_CODE_DEFS[code].label}</span>
                  </th>
                  <td className="tight">
                    <SeverityBadge severity={AUDIT_CODE_DEFS[code].severity} />
                  </td>
                  <td>{AUDIT_CODE_DEFS[code].description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
