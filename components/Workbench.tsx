'use client';

// 첫 화면 = 작업 화면. 왼쪽에 글 넣기와 원문(보기 글이 이미 들어 있다), 오른쪽에 등록 양식(채워진 칸).
// 직접 넣기(글 붙여 넣기, 여러 건 넣기, 그림·PDF 올리기)도 같은 화면에 있다.
// 일하는 차례는 글 넣기 → 확인할 칸 보기 → 승인(검수함) → 내려받기(상품)이고, 화면 머리 아래에 한 줄로 보인다.
// 한 건을 끝내면(승인·반려) 아래 막대의 "새 글 넣기"로 글 칸을 비우고 바로 다음 글을 받는다.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { BulkIntakeResponse, DraftDetailResponse, HealthResponse, IntakeResponse, SampleListResponse, SourceFileResponse } from '@/contract/api';
import { LIMITS } from '@/contract/api';
import { STYLE_LABELS } from '@/contract/eval-types';
import { FIELDS_BY_TYPE, TYPE_LABELS } from '@/contract/fields';
import { UPLOAD_PROBLEM_MESSAGES, checkUpload } from '@/contract/pipeline-api';
import { LLM_SKIP_LABELS } from '@/contract/reasons';
import type { DraftStatus } from '@/contract/transitions';
import { Badge, EmptyState, Loading, LocalRunHelp, Notice, PageHead, Stats, StatusBadge, Steps, type StepItem, type StepState } from './bits';
import { ApiFailure, call, drainOnce, failureMessage, waitForDraft } from './client';
import { DraftPanel, SourceText, TWO_PANES } from './DraftPanel';
import { fieldLabel } from './format';
import styles from './Workbench.module.css';

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

/** 처리 중일 때 어느 단계인지. text 는 화면 읽기 도구가 읽는 한 줄이다. */
interface Busy {
  text: string;
  stage: number;
  stages: readonly string[];
}

const TEXT_STAGES = ['접수', '칸 채우기'] as const;
const FILE_STAGES = ['파일을 글로 옮기기', '칸 채우기'] as const;

/** 여러 건 넣기로 생긴(또는 이미 있던) 초안 한 건. 결과 판의 한 줄이다. */
interface BulkRow {
  /** 붙여 넣은 글 가운데 몇 번째인지(0부터) */
  index: number;
  draftId: number;
  duplicate: boolean;
  status: DraftStatus;
  /** 상품 이름. 못 찾았으면 null. */
  name: string | null;
  notProduct: boolean;
}

interface BulkOutcome {
  counts: BulkIntakeResponse['counts'];
  rows: BulkRow[];
  /** 못 넣은 글: 몇 번째 글인지와 까닭 */
  errors: { index: number; message: string }[];
  /** 줄을 굴린 뒤에도 남은 일 */
  remaining: number;
}

const LEAD = '제각각인 상품 소개 글을 넣으면 등록 양식 칸이 채워지고, 틀릴 만한 칸에 확인할 까닭이 표시됩니다. 승인은 사람이 합니다.';

/** 낯선 낱말 풀이. 화면 머리의 접힌 "이 화면에서 쓰는 말" 안에 들어간다. */
function Glossary() {
  return (
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
  );
}

/** 일하는 차례 한 줄. 지금 어디인지는 초안의 상태가 정한다. 3·4 는 그 일을 하는 화면으로 가는 길이다. */
function flowSteps(now: 1 | 2 | 3 | 4): StepItem[] {
  const state = (n: number): StepState => (n < now ? 'done' : n === now ? 'now' : 'todo');
  return [
    { n: 1, label: '글 넣기', state: state(1) },
    { n: 2, label: '확인할 칸 보기', state: state(2) },
    { n: 3, label: '승인', note: '검수함', state: state(3), href: '/inbox' },
    { n: 4, label: '내려받기', note: '상품', state: state(4), href: '/products' },
  ];
}

/** 초안의 상태로 지금 단계를 정한다. 확인 필요 → 2, 바로 승인 가능 → 3, 승인됨 → 4. 반려·실패·처리 중이면 글 넣기로 돌아간다. */
function stepOf(status: DraftStatus): 1 | 2 | 3 | 4 {
  if (status === 'NEEDS_REVIEW') return 2;
  if (status === 'READY') return 3;
  if (status === 'APPROVED') return 4;
  return 1;
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
  /** 넣는 길이나 보기 글을 바꿔 초안 보기를 비웠을 때, 방금 만든 초안으로 돌아가는 길을 남긴다. */
  const [lastDraftId, setLastDraftId] = useState<number | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<{ message: string; rulesHint: boolean } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const bulkTitleRef = useRef<HTMLHeadingElement | null>(null);
  const intakeRef = useRef<HTMLDivElement | null>(null);
  /** "새 글 넣기"를 누른 뒤, 글 칸이 다시 그려지면 그리로 초점을 보낸다. */
  const focusInput = useRef(false);

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

  useEffect(() => {
    if (!focusInput.current) return;
    focusInput.current = false;
    const input = intakeRef.current?.querySelector<HTMLElement>('textarea, select, input[type="file"]');
    input?.focus();
    intakeRef.current?.scrollIntoView({ block: 'nearest' });
  });

  const bulkDocs = mode === 'bulk' ? splitBulk(bulkText) : [];
  const bulkTooMany = bulkDocs.length > LIMITS.bulkMaxDocs;

  const reset = () => {
    setBulk(null);
    setDraft(null);
    setError(null);
    setNote(null);
  };

  /** 넣는 길이나 보기 글을 바꾸면 초안 보기를 비운다. 초안은 그대로 있으므로 돌아가는 길을 남긴다. */
  const leaveDraft = () => {
    setLastDraftId(draft ? draft.id : null);
    reset();
  };

  /** 한 건을 끝내고 다음 글을 받는다: 글 칸을 비우고 초점을 그리로 옮긴다. */
  const newDoc = () => {
    reset();
    setLastDraftId(null);
    setPasted('');
    setBulkText('');
    setFile(null);
    setFileProblem(null);
    focusInput.current = true;
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

  /** 여러 건을 한 번에 넣고, 줄이 빌 때까지 굴린다. 결과는 건수와 초안 줄로 보여 주고, 초안은 검수함에서 본다. */
  const makeBulk = async () => {
    const sent = await call<BulkIntakeResponse>('POST', '/api/source-docs/bulk', { body: { texts: bulkDocs }, label: `여러 건 한 번에 넣기 (${bulkDocs.length}건)` });
    setBusy({ text: '칸을 채우는 중입니다…', stage: 1, stages: TEXT_STAGES });
    let remaining = sent.counts.new;
    for (let turn = 0; turn < 60 && remaining > 0; turn += 1) {
      try {
        remaining = (await drainOnce(turn === 0 ? '줄 굴리기' : undefined)).remaining;
      } catch {
        break;
      }
    }
    // 생긴 초안의 이름과 상태를 읽어 결과 판에 줄로 보여 준다(읽지 못한 것은 접수 때의 상태 그대로 둔다).
    const rows = await Promise.all(
      sent.items.flatMap((item) => (item.result === 'error' ? [] : [item])).map(async (item): Promise<BulkRow> => {
        const row: BulkRow = { index: item.index, draftId: item.draftId, duplicate: item.result === 'duplicate', status: item.status, name: null, notProduct: false };
        try {
          const detail = await call<DraftDetailResponse>('GET', `/api/drafts/${item.draftId}`);
          const name = detail.fields.find((f) => f.field === 'name')?.finalValue;
          return { ...row, status: detail.status, name: typeof name === 'string' && name.trim() !== '' ? name : null, notProduct: detail.type === 'not_product' };
        } catch {
          return row;
        }
      }),
    );
    setBulk({
      counts: sent.counts,
      rows,
      errors: sent.items.flatMap((item) => (item.result === 'error' ? [{ index: item.index, message: item.message }] : [])),
      remaining,
    });
    // 결과 판의 제목으로 초점을 옮긴다. 두 칸이 위아래로 서는 너비에서는 그 자리까지 내려간다.
    requestAnimationFrame(() => {
      const title = bulkTitleRef.current;
      if (!title) return;
      title.scrollIntoView({ block: window.matchMedia(TWO_PANES).matches ? 'nearest' : 'start' });
      title.focus({ preventScroll: true });
    });
  };

  const make = async () => {
    setError(null);
    setNote(null);
    setDraft(null);
    setBulk(null);
    setLastDraftId(null);
    try {
      if (mode === 'bulk') {
        if (bulkDocs.length === 0 || bulkTooMany) return;
        setBusy({ text: '접수하는 중입니다…', stage: 0, stages: TEXT_STAGES });
        await makeBulk();
        return;
      }
      let got: IntakeResponse;
      if (mode === 'file') {
        if (!file) return;
        setBusy({ text: 'AI가 파일을 글로 옮기는 중입니다…', stage: 0, stages: FILE_STAGES });
        const sent = await call<SourceFileResponse>('POST', '/api/source-files', { file, label: '그림·PDF 올리기' });
        got = sent;
        if (sent.duplicate) setNote('전에 올린 것과 같은 파일이라 모델을 다시 부르지 않고 있던 초안을 보여 줍니다.');
      } else {
        const text = mode === 'sample' ? (sample?.text ?? '') : pasted;
        if (text.trim() === '') return;
        setBusy({ text: '접수하는 중입니다…', stage: 0, stages: TEXT_STAGES });
        got = await call<IntakeResponse>('POST', '/api/source-docs', {
          body: { text },
          label: mode === 'sample' ? `보기 글로 초안 만들기 (${sample?.label ?? ''})` : '직접 넣은 글로 초안 만들기',
        });
        if (got.duplicate) setNote('이 공간에 이미 넣은 글이라 있던 초안을 보여 줍니다.');
      }
      setBusy({ text: '칸을 채우는 중입니다…', stage: 1, stages: mode === 'file' ? FILE_STAGES : TEXT_STAGES });
      setDraft(await waitForDraft(got.draftId, { label: '줄 굴리기' }));
      // 결과(초안 번호와 상태)로 초점을 옮긴다. 두 칸이 위아래로 서는 너비에서는 그 자리까지 내려간다.
      requestAnimationFrame(() => {
        const title = resultRef.current?.querySelector<HTMLElement>('[data-draft-title]');
        if (!title) return;
        const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        title.scrollIntoView({ block: window.matchMedia(TWO_PANES).matches ? 'nearest' : 'start', behavior: calm ? 'auto' : 'smooth' });
        title.focus({ preventScroll: true });
      });
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

  // 실제 호출이 열려 있는지는 결과를 읽는 데 꼭 필요한 단서라 입력 바로 아래에 상자로 둔다.
  // 닫혀 있으면 그림·PDF 는 받지 못하므로 그 길에서는 주의로 적는다.
  const liveNote = liveLine ? <Notice kind={mode === 'file' && health && !health.llm.live ? 'warn' : 'info'}>{liveLine}</Notice> : null;

  const canMake =
    busy === null &&
    (mode === 'file' ? file !== null : mode === 'sample' ? Boolean(sample) : mode === 'bulk' ? bulkDocs.length > 0 && !bulkTooMany : pasted.trim() !== '');

  const makeLabel = mode === 'file' ? '이 파일로 초안 만들기' : mode === 'bulk' ? `${bulkDocs.length}건 한 번에 초안 만들기` : '이 글로 초안 만들기';

  // 초안이 생기면 직접 넣은 글·올린 파일의 입력은 한 줄로 접는다. 같은 글이 아래 "원문"에 그대로 있고, 접어야 원문이 위로 올라온다.
  const folded = draft !== null && (mode === 'paste' || mode === 'file');

  const inputs = (
    <div ref={intakeRef} className={`intake ${styles.intake}`}>
      <h2 className={`pane-title ${styles.intakeTitle}`}>글 넣기</h2>
      <div className={`who ${styles.modes}`} role="group" aria-label="무엇으로 초안을 만들지">
        {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            className="seg"
            aria-pressed={mode === m}
            onClick={() => {
              setMode(m);
              leaveDraft();
            }}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      {folded ? (
        <div className={styles.folded}>
          <p>
            {mode === 'paste' ? (
              <>
                넣은 글 <span className="num">{pasted.length.toLocaleString('en-US')}자</span>
              </>
            ) : (
              <>올린 파일{file ? `: ${file.name}` : ''}</>
            )}{' '}
            <span className="muted">· 아래 “원문”에 그대로 있습니다.</span>
          </p>
          <button type="button" className="btn small" onClick={newDoc}>
            새 글 넣기
          </button>
        </div>
      ) : null}

      {mode === 'sample' ? (
        samples.length === 0 ? (
          <Notice kind="warn">{samplesError ? '보기 글을 읽어 오지 못했습니다. DB 연결을 확인해 주세요.' : '보기 글이 없습니다.'}</Notice>
        ) : (
          <>
            <label className="stack">
              보기 글 고르기
              <select
                value={sample?.id ?? ''}
                onChange={(e) => {
                  setSampleId(e.target.value);
                  leaveDraft();
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
              <p className={`muted small ${styles.note}`}>
                꼴: {STYLE_LABELS[sample.style]} ·{' '}
                {sample.recorded ? 'AI 답은 미리 받아 둔 실제 응답이라 바로 뜹니다.' : '이 글은 미리 받아 둔 응답이 없습니다. 실제 호출이 닫혀 있으면 규칙만으로 뽑습니다.'}
              </p>
            ) : null}
          </>
        )
      ) : null}

      {mode === 'paste' && !folded ? (
        <>
          <label className="stack">
            공급처가 보낸 글을 그대로 붙여 넣으세요
            <textarea
              rows={9}
              maxLength={LIMITS.textMaxChars}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="예) 홍대입구역 9번 출구 전광판, 1주 150만원(VAT별도), 05시~25시 운영…"
            />
          </label>
          <p className={`muted small ${styles.note}`}>
            <span className="num">
              {pasted.length.toLocaleString('en-US')} / {LIMITS.textMaxChars.toLocaleString('en-US')}자
            </span>{' '}
            · 개인 정보나 실제 거래 자료는 넣지 마세요.
          </p>
          {liveNote}
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
          <p className={`muted small ${styles.note}`}>
            지금 {bulkDocs.length}건 · 글 한 건은 {LIMITS.textMaxChars.toLocaleString('en-US')}자까지 · 한 건이 틀려도 나머지는 들어갑니다. CSV로 넣는 길은 API 화면에 있습니다. 개인
            정보나 실제 거래 자료는 넣지 마세요.
          </p>
          {liveNote}
        </>
      ) : null}

      {mode === 'file' && !folded ? (
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
          <p className={`muted small ${styles.note}`}>
            AI가 먼저 글로 옮기고, 그 글이 같은 길을 탑니다. 파일은 저장하지 않고 옮긴 글만 남깁니다. 개인 정보가 든 파일은 올리지 마세요.
          </p>
          {liveNote}
        </>
      ) : null}

      {folded ? null : (
        <div className={`actions ${styles.go}`}>
          {/* 여러 건을 넣은 뒤에는 지금 할 일이 오른쪽 결과 판의 "검수함에서 … 보기"다. 같은 글을 또 넣지 않게 이 버튼은 조용히 둔다. */}
          <button type="button" className={bulk ? 'btn big' : 'btn primary big'} onClick={make} disabled={!canMake}>
            {makeLabel}
          </button>
          {bulk ? (
            <button type="button" className="btn" onClick={newDoc}>
              글 칸 비우기
            </button>
          ) : null}
          {busy ? <Loading label={busy.text} lines={0} /> : null}
        </div>
      )}
      {lastDraftId !== null && !draft ? (
        <p className={`muted small ${styles.note}`}>
          초안 보기를 비웠습니다. 방금 만든 초안은 그대로 있습니다. <Link href={`/drafts/${lastDraftId}`}>초안 #{lastDraftId} 다시 열기</Link>
        </p>
      ) : null}
      {note ? <Notice>{note}</Notice> : null}
      {bulk ? (
        <Notice kind={bulk.errors.length > 0 ? 'warn' : 'info'}>
          새로 넣은 글 {bulk.counts.new}건 · 이미 있던 글 {bulk.counts.duplicate}건 · 넣지 못한 글 {bulk.counts.error}건.
          {bulk.remaining > 0 ? ` 아직 처리 중인 것이 ${bulk.remaining}건 있습니다.` : ''} <Link href="/inbox?space=mine">검수함에서 초안 보기</Link>
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

  const head = <PageHead title="작업 화면" lead={LEAD} about={<Glossary />} aboutLabel="이 화면에서 쓰는 말" />;

  if (draft) {
    return (
      <main className="page wide">
        {head}
        <Steps label="일하는 차례" items={flowSteps(stepOf(draft.status))} />
        <div ref={resultRef}>
          <DraftPanel draft={draft} onDraft={setDraft} mode="workbench" sourceTop={inputs} onNew={newDoc} />
        </div>
      </main>
    );
  }

  const previewText = mode === 'sample' ? (sample?.text ?? '') : null;
  const previewType = mode === 'sample' && sample ? sample.type : 'ad';
  const previewFields = FIELDS_BY_TYPE[previewType];
  const notProduct = mode === 'sample' && sample?.type === 'not_product';
  const bulkWaiting = bulk ? bulk.rows.filter((row) => row.status === 'NEEDS_REVIEW').length : 0;
  const bulkReady = bulk ? bulk.rows.filter((row) => row.status === 'READY').length : 0;

  return (
    <main className="page wide">
      {head}
      <Steps label="일하는 차례" items={flowSteps(bulk && bulk.rows.length > 0 ? 2 : 1)} />
      <div className="split">
        <section className="pane" aria-label="원문">
          {inputs}
          {previewText !== null ? (
            <>
              <h2 className="pane-title">원문</h2>
              <SourceText text={previewText} />
            </>
          ) : null}
        </section>
        {bulk && !busy ? (
          <section className="pane" aria-label="넣은 결과">
            <div className={styles.formHead}>
              <h2 ref={bulkTitleRef} className={`pane-title ${styles.formTitle}`} tabIndex={-1}>
                넣은 결과
              </h2>
              <Badge tone={bulk.counts.error > 0 ? 'warn' : 'ok'}>{bulk.counts.error > 0 ? '넣지 못한 글 있음' : '모두 들어감'}</Badge>
            </div>
            <div className={styles.bulkStats}>
              <Stats
                items={[
                  { label: '새로 넣은 글', value: `${bulk.counts.new}건` },
                  { label: '이미 있던 글', value: `${bulk.counts.duplicate}건` },
                  { label: '넣지 못한 글', value: `${bulk.counts.error}건`, tone: bulk.counts.error > 0 ? 'danger' : undefined },
                ]}
              />
            </div>
            {bulk.remaining > 0 ? <Notice>아직 처리 중인 것이 {bulk.remaining}건 있습니다. 검수함에서 새로 고침을 눌러 보세요.</Notice> : null}
            {bulk.rows.length > 0 ? (
              <>
                <div className="actions">
                  <Link className="btn primary" href={`/inbox?space=mine&status=${bulkWaiting > 0 || bulkReady === 0 ? 'NEEDS_REVIEW' : 'READY'}`}>
                    {bulkWaiting > 0 || bulkReady === 0 ? `검수함에서 확인 필요 ${bulkWaiting}건 보기` : `검수함에서 바로 승인 가능 ${bulkReady}건 보기`}
                  </Link>
                  <span className="muted small">
                    확인 필요 {bulkWaiting}건 · 바로 승인 가능 {bulkReady}건 · 그 밖 {bulk.rows.length - bulkWaiting - bulkReady}건
                  </span>
                </div>
                <div className="table-wrap" tabIndex={0} role="region" aria-label="넣은 글의 초안">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col" className="tight num">
                          번호
                        </th>
                        <th scope="col">상품 이름</th>
                        <th scope="col" className="tight">
                          상태
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {bulk.rows.map((row) => (
                        <tr key={`${row.index}-${row.draftId}`}>
                          <td className="tight num">#{row.draftId}</td>
                          <td>
                            <Link href={`/drafts/${row.draftId}`}>{row.name ?? (row.notProduct ? '(등록 대상이 아닌 글)' : '(이름을 찾지 못함)')}</Link>
                            <span className={`muted small ${styles.bulkWhere}`}>
                              {row.index + 1}번째 글{row.duplicate ? ' · 이미 있던 글' : ''}
                            </span>
                          </td>
                          <td className="tight">
                            <StatusBadge status={row.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <EmptyState title="들어간 글이 없습니다">왼쪽의 까닭을 보고 글을 고쳐 다시 넣어 주세요.</EmptyState>
            )}
          </section>
        ) : (
          <section className="pane" aria-label="채워진 칸">
            <div className={styles.formHead}>
              <h2 className={`pane-title ${styles.formTitle}`}>등록 양식</h2>
              <Badge tone={busy ? 'info' : 'neutral'}>{busy ? '처리 중' : '비어 있음'}</Badge>
            </div>
            {busy ? (
              <>
                <ol className={styles.stages} role="list" aria-label="처리 단계">
                  {busy.stages.map((name, index) => (
                    <li key={name} data-state={index < busy.stage ? 'done' : index === busy.stage ? 'now' : 'todo'} aria-current={index === busy.stage ? 'step' : undefined}>
                      <span className={styles.stageNo} aria-hidden="true">
                        {index + 1}
                      </span>
                      {name}
                      {index < busy.stage ? <span className="sr-only"> (끝남)</span> : null}
                    </li>
                  ))}
                </ol>
                <p className={`muted ${styles.stageText}`}>{busy.text}</p>
                <div className={styles.bones} aria-hidden="true">
                  <span className="skeleton" />
                  <span className="skeleton" />
                  <span className="skeleton" />
                  <span className="skeleton" />
                </div>
              </>
            ) : (
              <>
                <div className={styles.blank}>
                  <EmptyState title="아직 비어 있습니다">“초안 만들기” 버튼을 누르면 칸이 채워지고, 확인할 곳에 노란 표시와 사유가 붙습니다.</EmptyState>
                </div>
                {notProduct ? (
                  <p className="muted">이 보기 글은 상품 소개가 아닙니다. “{TYPE_LABELS.not_product}”으로 걸리는지 보는 글입니다.</p>
                ) : (
                  <>
                    <h3 className={styles.previewTitle}>
                      채워질 칸 <span className="count">{previewFields.length}개</span>
                    </h3>
                    <p className={`muted small ${styles.previewNote}`}>
                      {mode === 'sample' && sample
                        ? `이 보기 글의 종류(${TYPE_LABELS[previewType]})에 있는 칸입니다.`
                        : `칸은 글의 종류에 따라 달라집니다. 아래는 ${TYPE_LABELS.ad}의 칸입니다.`}
                    </p>
                    <ul className={styles.previewList}>
                      {previewFields.map((key) => (
                        <li key={key}>{fieldLabel(key)}</li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
