'use client';

// 첫 화면 = 작업 화면. 왼쪽에 원문(보기 글이 이미 들어 있다), 오른쪽에 채워진 칸.
// 직접 넣기(글 붙여 넣기, 그림·PDF 올리기)도 같은 화면에 있다.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { BulkIntakeResponse, DraftDetailResponse, HealthResponse, IntakeResponse, SampleListResponse, SourceFileResponse } from '@/contract/api';
import { LIMITS } from '@/contract/api';
import { STYLE_LABELS } from '@/contract/eval-types';
import { FIELDS_BY_TYPE, TYPE_LABELS } from '@/contract/fields';
import { UPLOAD_PROBLEM_MESSAGES, checkUpload } from '@/contract/pipeline-api';
import { LLM_SKIP_LABELS } from '@/contract/reasons';
import { LocalRunHelp, Notice } from './bits';
import { ApiFailure, call, drainOnce, failureMessage, waitForDraft } from './client';
import { DraftPanel } from './DraftPanel';
import { fieldLabel } from './format';

type Sample = SampleListResponse['items'][number];
type Mode = 'sample' | 'paste' | 'bulk' | 'file';

const MODE_LABELS: Record<Mode, string> = { sample: '보기 글', paste: '글 직접 넣기', bulk: '여러 건 넣기', file: '그림·PDF 올리기' };

/** 여러 건 넣기에서 글과 글을 가르는 줄. 이 글자만 있는 줄이다. */
const BULK_DIVIDER = '---';

/** 붙여 넣은 글을 구분 줄로 갈라 글의 목록으로 만든다. 빈 덩어리는 버린다. */
export function splitBulk(text: string): string[] {
  const docs: string[] = [];
  let lines: string[] = [];
  const push = () => {
    const doc = lines.join('\n').trim();
    if (doc !== '') docs.push(doc);
    lines = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === BULK_DIVIDER) push();
    else lines.push(line);
  }
  push();
  return docs;
}

interface BulkOutcome {
  counts: BulkIntakeResponse['counts'];
  /** 못 넣은 글: 몇 번째 글인지와 까닭 */
  errors: { index: number; message: string }[];
  /** 줄을 굴린 뒤에도 남은 일 */
  remaining: number;
}

/** 처음 온 사람에게 이 화면이 무엇인지 한 문장으로 말하고, 낯선 낱말을 풀어 둔다. */
function Intro() {
  return (
    <div className="intro">
      <p>제각각인 상품 소개 글을 넣으면 등록 양식 칸이 채워지고, 틀릴 만한 칸에 확인할 까닭이 표시됩니다. 승인은 사람이 합니다.</p>
      <details className="help">
        <summary>이 화면에서 쓰는 말</summary>
        <dl className="glossary">
          <dt>종류와 갈래</dt>
          <dd>종류는 광고 지면·케이터링·굿즈 셋이고, 갈래는 그 아래의 작은 분류입니다(광고 지면의 전광판·지하철·버스 등).</dd>
          <dt>줄 굴리기</dt>
          <dd>접수한 글은 작업 줄에 섭니다. 이 사이트는 따로 도는 작업자가 없어서, 화면이 줄을 굴려 처리합니다.</dd>
          <dt>규칙만</dt>
          <dd>AI를 거치지 않고 정해 둔 규칙(글자 꼴 찾기)만으로 뽑은 것입니다. 그렇게 뽑은 초안에는 표시가 붙습니다.</dd>
          <dt>틀 문장과 자리표시</dt>
          <dd>
            다른 언어 글에서 값·일수·수량은 AI가 숫자로 쓰지 않고 {'{price}'} 같은 자리표시로 씁니다. 숫자는 코드가 넣습니다. AI 글이 검사에 걸리면 코드가 미리 정해 둔 틀 문장으로
            바꿉니다.
          </dd>
          <dt>본보기 공간</dt>
          <dd>누구나 읽기만 할 수 있는 보기용 공간입니다. 직접 넣은 글은 이 브라우저만의 작업 공간에 들어갑니다.</dd>
          <dt>VAT</dt>
          <dd>부가세입니다. 금액에 부가세가 들었는지는 “부가세 포함” 칸에 따로 적습니다.</dd>
        </dl>
      </details>
    </div>
  );
}

export function Workbench({ samples, samplesError }: { samples: Sample[]; samplesError: boolean }) {
  const [mode, setMode] = useState<Mode>('sample');
  const [sampleId, setSampleId] = useState<string>(samples[0]?.id ?? '');
  const [pasted, setPasted] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [bulk, setBulk] = useState<BulkOutcome | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftDetailResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; rulesHint: boolean } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);

  const sample = samples.find((s) => s.id === sampleId) ?? samples[0];

  useEffect(() => {
    let alive = true;
    call<HealthResponse>('GET', '/api/health')
      .then((h) => {
        if (alive) setHealth(h);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const bulkDocs = mode === 'bulk' ? splitBulk(bulkText) : [];
  const bulkTooMany = bulkDocs.length > LIMITS.bulkMaxDocs;

  const reset = () => {
    setBulk(null);
    setDraft(null);
    setError(null);
    setNote(null);
  };

  const pickFile = async (picked: File | null) => {
    reset();
    setFile(null);
    setFileProblem(null);
    if (!picked) return;
    const check = checkUpload(new Uint8Array(await picked.arrayBuffer()));
    if (!check.ok) {
      setFileProblem(UPLOAD_PROBLEM_MESSAGES[check.problem]);
      return;
    }
    setFile(picked);
  };

  /** 여러 건을 한 번에 넣고, 줄이 빌 때까지 굴린다. 결과는 건수로 보여 주고 초안은 검수함에서 본다. */
  const makeBulk = async () => {
    const sent = await call<BulkIntakeResponse>('POST', '/api/source-docs/bulk', { body: { texts: bulkDocs }, label: `여러 건 한 번에 넣기 (${bulkDocs.length}건)` });
    setBusy('칸을 채우는 중입니다…');
    let remaining = sent.counts.new;
    for (let turn = 0; turn < 60 && remaining > 0; turn += 1) {
      try {
        remaining = (await drainOnce(turn === 0 ? '줄 굴리기' : undefined)).remaining;
      } catch {
        break;
      }
    }
    setBulk({
      counts: sent.counts,
      errors: sent.items.flatMap((item) => (item.result === 'error' ? [{ index: item.index, message: item.message }] : [])),
      remaining,
    });
  };

  const make = async () => {
    setError(null);
    setNote(null);
    setDraft(null);
    setBulk(null);
    try {
      if (mode === 'bulk') {
        if (bulkDocs.length === 0 || bulkTooMany) return;
        setBusy('접수하는 중입니다…');
        await makeBulk();
        return;
      }
      let got: IntakeResponse;
      if (mode === 'file') {
        if (!file) return;
        setBusy('AI가 파일을 글로 옮기는 중입니다…');
        const sent = await call<SourceFileResponse>('POST', '/api/source-files', { file, label: '그림·PDF 올리기' });
        got = sent;
        if (sent.duplicate) setNote('전에 올린 것과 같은 파일이라 모델을 다시 부르지 않고 있던 초안을 보여 줍니다.');
      } else {
        const text = mode === 'sample' ? (sample?.text ?? '') : pasted;
        if (text.trim() === '') return;
        setBusy('접수하는 중입니다…');
        got = await call<IntakeResponse>('POST', '/api/source-docs', {
          body: { text },
          label: mode === 'sample' ? `보기 글로 초안 만들기 (${sample?.label ?? ''})` : '직접 넣은 글로 초안 만들기',
        });
        if (got.duplicate) setNote('이 공간에 이미 넣은 글이라 있던 초안을 보여 줍니다.');
      }
      setBusy('칸을 채우는 중입니다…');
      setDraft(await waitForDraft(got.draftId, { label: '줄 굴리기' }));
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    } catch (err) {
      // 서버의 글에 까닭이 이미 들어 있다. 없을 때만 덧붙인다.
      const label = err instanceof ApiFailure && err.skipCause ? LLM_SKIP_LABELS[err.skipCause] : '';
      const message = failureMessage(err);
      setError({ message: label && !message.includes(label.replace(/\.$/, '')) ? `${message} (${label})` : message, rulesHint: err instanceof ApiFailure && (err.status === 503 || err.status === 429) });
    } finally {
      setBusy(null);
    }
  };

  const liveLine = health
    ? health.llm.live
      ? `지금 실제 호출이 열려 있습니다(오늘 남은 호출 ${health.llm.liveLeftToday}건 / 하루 ${health.llm.liveCap}건, 모델 ${health.llm.model}). 글이 ${LIMITS.liveLlmTextMaxChars.toLocaleString('en-US')}자를 넘으면 규칙만으로 뽑습니다.`
      : '지금 이 서버는 실제 호출이 닫혀 있습니다. 직접 넣은 글은 규칙만으로 뽑고 그렇게 표시합니다. 그림·PDF는 받지 못합니다.'
    : null;

  const canMake =
    busy === null &&
    (mode === 'file' ? file !== null : mode === 'sample' ? Boolean(sample) : mode === 'bulk' ? bulkDocs.length > 0 && !bulkTooMany : pasted.trim() !== '');

  const inputs = (
    <div className="intake">
      <div className="who" role="group" aria-label="무엇으로 초안을 만들지">
        {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            className="seg"
            aria-pressed={mode === m}
            onClick={() => {
              setMode(m);
              reset();
            }}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      {mode === 'sample' ? (
        samples.length === 0 ? (
          <Notice kind="warn">{samplesError ? '보기 글을 읽어 오지 못했습니다. DB 연결을 확인해 주세요.' : '보기 글이 없습니다.'}</Notice>
        ) : (
          <>
            <label className="row">
              보기 글 고르기{' '}
              <select
                value={sample?.id ?? ''}
                onChange={(e) => {
                  setSampleId(e.target.value);
                  reset();
                }}
              >
                {samples.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            {sample ? (
              <p className="muted small">
                꼴: {STYLE_LABELS[sample.style]} ·{' '}
                {sample.recorded ? 'AI 답은 미리 받아 둔 실제 응답이라 바로 뜹니다.' : '이 글은 미리 받아 둔 응답이 없습니다. 실제 호출이 닫혀 있으면 규칙만으로 뽑습니다.'}
              </p>
            ) : null}
          </>
        )
      ) : null}

      {mode === 'paste' ? (
        <>
          <label className="stack">
            공급처가 보낸 글을 그대로 붙여 넣으세요
            <textarea
              rows={9}
              maxLength={LIMITS.textMaxChars}
              value={pasted}
              onChange={(e) => {
                setPasted(e.target.value);
                if (draft) reset();
              }}
              placeholder="예) 홍대입구역 9번 출구 전광판, 1주 150만원(VAT별도), 05시~25시 운영…"
            />
          </label>
          <p className="muted small">
            {pasted.length.toLocaleString('en-US')} / {LIMITS.textMaxChars.toLocaleString('en-US')}자 · 개인 정보나 실제 거래 자료는 넣지 마세요. {liveLine}
          </p>
        </>
      ) : null}

      {mode === 'bulk' ? (
        <>
          <label className="stack">
            글 여러 건을 붙여 넣으세요. 글과 글 사이에 “{BULK_DIVIDER}”만 있는 줄을 넣어 가릅니다 ({LIMITS.bulkMaxDocs}건까지)
            <textarea
              rows={12}
              value={bulkText}
              onChange={(e) => {
                setBulkText(e.target.value);
                if (bulk) reset();
              }}
              placeholder={`예) 합정역 7번 출구 전광판, 1주 150만원…\n${BULK_DIVIDER}\n달무리 커피차 100잔 80만원…\n${BULK_DIVIDER}\n응원 슬로건 200x600mm, 10장부터 장당 5,000원`}
            />
          </label>
          {bulkTooMany ? (
            <Notice kind="error">
              지금 {bulkDocs.length}건입니다. 한 번에 {LIMITS.bulkMaxDocs}건까지 넣을 수 있습니다. 나눠서 넣어 주세요.
            </Notice>
          ) : null}
          <p className="muted small">
            지금 {bulkDocs.length}건 · 글 한 건은 {LIMITS.textMaxChars.toLocaleString('en-US')}자까지 · 한 건이 틀려도 나머지는 들어갑니다. CSV로 넣는 길은 API 탭에 있습니다. 개인
            정보나 실제 거래 자료는 넣지 마세요. {liveLine}
          </p>
        </>
      ) : null}

      {mode === 'file' ? (
        <>
          <label className="stack">
            단가표 그림(JPG·PNG·WEBP)이나 PDF 소개서를 고르세요 (3MB까지, PDF는 10쪽까지)
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {fileProblem ? <Notice kind="error">{fileProblem}</Notice> : null}
          <p className="muted small">
            AI가 먼저 글로 옮기고, 그 글이 같은 길을 탑니다. 파일은 저장하지 않고 옮긴 글만 남깁니다. 개인 정보가 든 파일은 올리지 마세요. {liveLine}
          </p>
        </>
      ) : null}

      <div className="actions">
        <button type="button" className="btn primary big" onClick={make} disabled={!canMake}>
          {mode === 'file' ? '이 파일로 초안 만들기' : mode === 'bulk' ? `${bulkDocs.length}건 한 번에 초안 만들기` : '이 글로 초안 만들기'}
        </button>
        {busy ? (
          <span className="muted" role="status">
            {busy}
          </span>
        ) : null}
      </div>
      {note ? <Notice>{note}</Notice> : null}
      {bulk ? (
        <Notice kind={bulk.errors.length > 0 ? 'warn' : 'info'}>
          새로 넣은 글 {bulk.counts.new}건 · 이미 있던 글 {bulk.counts.duplicate}건 · 넣지 못한 글 {bulk.counts.error}건.
          {bulk.remaining > 0 ? ` 아직 처리 중인 것이 ${bulk.remaining}건 있습니다.` : ''} <Link href="/inbox">검수함에서 초안 보기</Link>
          {bulk.errors.length > 0 ? (
            <ul className="plain">
              {bulk.errors.map((e) => (
                <li key={e.index}>
                  {e.index + 1}번째 글: {e.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
      {error ? (
        <Notice kind="error">
          {error.message}
          {error.rulesHint ? <LocalRunHelp /> : null}
        </Notice>
      ) : null}
    </div>
  );

  if (draft) {
    return (
      <main className="page wide">
        <h1 className="sr-only">작업 화면</h1>
        <Intro />
        <div ref={resultRef}>
          <DraftPanel draft={draft} onDraft={setDraft} mode="workbench" sourceTop={inputs} />
        </div>
      </main>
    );
  }

  const previewText = mode === 'sample' ? (sample?.text ?? '') : null;
  const previewFields = mode === 'sample' && sample ? FIELDS_BY_TYPE[sample.type] : FIELDS_BY_TYPE.ad;

  return (
    <main className="page wide">
      <h1 className="sr-only">작업 화면</h1>
      <Intro />
      <div className="split">
        <section className="pane" aria-label="원문">
          {inputs}
          {previewText !== null ? (
            <>
              <h2 className="pane-title">원문</h2>
              <pre className="source" tabIndex={0} aria-label="원문">
                {previewText}
              </pre>
            </>
          ) : null}
        </section>
        <section className="pane" aria-label="채워진 칸">
          <h2 className="pane-title">등록 양식</h2>
          <p className="muted">
            {busy ?? '아직 비어 있습니다. “초안 만들기” 버튼을 누르면 칸이 채워지고, 확인할 곳에 노란 표시와 사유가 붙습니다.'}
          </p>
          {mode === 'sample' && sample?.type === 'not_product' ? (
            <p className="muted">이 보기 글은 상품 소개가 아닙니다. “{TYPE_LABELS.not_product}”으로 걸리는지 보는 글입니다.</p>
          ) : (
            previewFields.map((key) => (
              <div className="field field-empty" key={key}>
                <div className="field-name">{fieldLabel(key)}</div>
                <div className="field-body muted">—</div>
              </div>
            ))
          )}
        </section>
      </div>
    </main>
  );
}
