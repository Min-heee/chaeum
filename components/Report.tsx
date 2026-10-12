'use client';

// 성적표. 평가 실행이 남긴 값만 그대로 보여 준다. 화면에서 숫자를 만들지 않는다.
// 묶음별로 따로, 모든 비율 옆에 분자/분모를 적는다.
import { useEffect, useState } from 'react';
import type { EvalRunDetailResponse, EvalRunListResponse } from '@/contract/api';
import { CORRECTION_COLUMNS } from '@/contract/api';
import { EVAL_METHODS, GOLD_SPLITS, METHOD_LABELS, SPLIT_LABELS, SPLIT_SIZES, type EvalMethod, type EvalMetrics, type GoldSplit, type Ratio, type Verdict } from '@/contract/eval-types';
import { FIELD_KEYS } from '@/contract/fields';
import { Notice } from './bits';
import { call, callText, failureMessage, useMounted, useWorkspace } from './client';
import { fieldLabel, formatTime, formatValue, seconds, usd } from './format';

type Run = EvalRunListResponse['items'][number];

/** 내세우는 묶음을 앞에, 연습 묶음을 맨 뒤에 둔다. */
const SPLIT_ORDER: readonly GoldSplit[] = ['test', 'real', 'hand', 'dev'];

const SPLIT_NOTES: Record<GoldSplit, string> = {
  test: '원문은 AI가 썼고 정답은 코드가 먼저 정한 값을 사람이 대조했습니다. 고치는 동안 열지 않는 묶음입니다.',
  real: '남이 쓴 공개 글을 사람이 골라 온 묶음입니다. 원문과 값은 싣지 않습니다.',
  hand: '사람이 직접 쓴 묶음입니다. 파이프라인을 얼린 뒤에 씁니다.',
  dev: '프롬프트와 규칙을 고칠 때 보는 묶음입니다. 바깥에 내세우는 숫자가 아닙니다.',
};

const VERDICT_LABELS: Record<Verdict, string> = {
  correct: '맞음',
  wrong: '다른 값',
  missed: '놓침',
  fabricated: '지어냄',
  true_none: '없음이 맞음',
};

const isRatio = (v: unknown): v is Ratio =>
  typeof v === 'object' && v !== null && typeof (v as Ratio).num === 'number' && typeof (v as Ratio).den === 'number';

/** 비율. 분자/분모를 먼저 적는다. 분모가 0 이면 비율을 내지 않고, 분자가 0 이면 "0%"라고 쓰지 않는다. */
function ratio(v: unknown): string {
  if (!isRatio(v)) return '기록 없음';
  if (v.den === 0) return '0/0 (해당 없음)';
  if (v.num === 0) return `0/${v.den}`;
  return `${v.num}/${v.den} · ${((v.num / v.den) * 100).toFixed(1)}%`;
}

const NONE = '이 방식에는 없음';

/** 실행 기록에 "확인 전 문서 포함"이 적혀 있는가(metrics.runInfo.includeUnreviewed). */
function hasUnreviewed(metrics: unknown): boolean {
  const info = (metrics as { runInfo?: { includeUnreviewed?: unknown } } | null)?.runInfo;
  return info?.includeUnreviewed === true;
}

/** 커밋 표시. 앞 일곱 자리로 줄이되, 커밋하지 않은 변경이 있던 실행(-dirty)은 그 꼬리를 남긴다. */
function commitLabel(gitCommit: string): string {
  const dirty = gitCommit.endsWith('-dirty');
  const hash = dirty ? gitCommit.slice(0, -'-dirty'.length) : gitCommit;
  return `${hash.slice(0, 7)}${dirty ? '-dirty(커밋 안 된 변경 있음)' : ''}`;
}

interface MetricRow {
  label: string;
  hint: string;
  read: (m: Partial<EvalMetrics>) => string;
}

const ROWS: MetricRow[] = [
  {
    label: '채점한 문서',
    hint: '확인 전 문서가 들었는지는 값 옆에 적습니다',
    read: (m) => (typeof m.docs === 'number' ? `${m.docs}건 (${hasUnreviewed(m) ? '확인 전 문서 포함' : '사람이 확인한 것만'})` : '기록 없음'),
  },
  { label: '칸 정확도', hint: '일치한 칸 / 정답에 값이 있는 칸', read: (m) => ratio(m.fieldAccuracy?.overall) },
  { label: '지어낸 값', hint: '정답이 “없음”인데 값을 낸 칸 / 정답이 “없음”인 칸', read: (m) => ratio(m.fabricated?.overall) },
  { label: '전부 맞은 문서', hint: '모든 칸이 맞은 문서 / 전체 문서', read: (m) => ratio(m.docsAllCorrect) },
  { label: '바로 승인 줄', hint: '표시 0개인 문서 / 전체 문서', read: (m) => (m.autoApprove ? ratio(m.autoApprove.ready) : NONE) },
  { label: '그 안의 틀린 것', hint: '표시 0개인데 틀린 칸이 있는 문서 / 표시 0개인 문서', read: (m) => (m.autoApprove ? ratio(m.autoApprove.readyWithError) : NONE) },
  { label: '검사기 포착', hint: '표시가 붙은 틀린 칸 / 틀린 칸', read: (m) => (m.checker ? ratio(m.checker.caught) : NONE) },
  { label: '검사기 헛경보', hint: '표시가 붙은 맞은 칸 / 맞은 칸', read: (m) => (m.checker ? ratio(m.checker.falseAlarm) : NONE) },
  {
    label: '건당 비용',
    hint: '호출 비용 합 / 문서 수',
    read: (m) => (m.costTime ? `${usd(m.costTime.costUsdPerDoc)} (합 ${usd(m.costTime.costUsdTotal)}${m.costTime.fromRecording ? ', 녹화본에 적힌 값' : ''})` : '호출 없음'),
  },
  {
    label: '건당 시간',
    hint: '가운데값 · 95번째',
    read: (m) => (m.costTime ? `${seconds(m.costTime.latencyMsP50)} · ${seconds(m.costTime.latencyMsP95)}${m.costTime.fromRecording ? ' (녹화할 때 잰 값)' : ''}` : '호출 없음'),
  },
  { label: '종류 정확도', hint: '종류를 맞힌 문서 / 전체 문서', read: (m) => ratio(m.typeAccuracy) },
  { label: '갈래 정확도', hint: '갈래를 맞힌 문서 / 정답이 상품인 문서', read: (m) => ratio(m.subtypeAccuracy) },
  { label: '놓친 값', hint: '못 낸 칸 / 정답에 값이 있는 칸', read: (m) => ratio(m.missed) },
];

function WrongDocs({ run }: { run: Run }) {
  const [detail, setDetail] = useState<EvalRunDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (detail) return;
    try {
      setDetail(await call<EvalRunDetailResponse>('GET', `/api/eval/runs/${run.id}`, { label: `평가 실행 #${run.id}의 건별 결과` }));
    } catch (err) {
      setError(failureMessage(err));
    }
  };

  const wrong = detail?.docs.filter((d) => !d.allCorrect) ?? [];
  return (
    <div className="wrong">
      <button type="button" className="btn small" aria-expanded={open} onClick={toggle}>
        {METHOD_LABELS[run.method]} — 틀린 건 {open ? '접기' : '보기'}
      </button>
      {open && error ? <Notice kind="error">{error}</Notice> : null}
      {open && !detail && !error ? <p className="muted">읽어 오는 중…</p> : null}
      {open && detail ? (
        wrong.length === 0 ? (
          <p className="muted">틀린 칸이 있는 문서가 없습니다({detail.docs.length}건 가운데).</p>
        ) : (
          <>
            <p className="muted small">
              틀린 칸이 있는 문서 {wrong.length}건 / 전체 {detail.docs.length}건
              {run.split === 'real' ? ' · 실제 자료 묶음은 값을 싣지 않습니다.' : ''}
            </p>
            <ul className="cards">
              {wrong.map((doc) => (
                <li key={doc.goldDocId} className="card">
                  <strong>{doc.goldDocId}</strong> <span className="muted small">{doc.flagged ? '확인 필요로 감' : '표시 없이 통과함'}</span>
                  <ul className="plain">
                    {doc.cells
                      .filter((c) => c.verdict === 'wrong' || c.verdict === 'missed' || c.verdict === 'fabricated')
                      .map((c) => (
                        <li key={c.field}>
                          {fieldLabel(c.field)}: {VERDICT_LABELS[c.verdict]}
                          {run.split === 'real' ? '' : ` — 정답 ${formatValue(c.field, c.expected)} / 낸 값 ${formatValue(c.field, c.actual)}`}
                          {c.flagged ? <span className="flag"> 표시 붙음</span> : null}
                        </li>
                      ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
    </div>
  );
}

function SplitBlock({ split, runs, currentGoldVersion }: { split: GoldSplit; runs: Run[]; currentGoldVersion: number | null }) {
  // 방식마다 가장 새 실행 하나.
  const latest = new Map<EvalMethod, Run>();
  for (const run of runs) if (!latest.has(run.method)) latest.set(run.method, run);
  const methods = EVAL_METHODS.filter((m) => latest.has(m));
  const versions = new Set(methods.map((m) => latest.get(m)?.goldVersion));

  return (
    <section className="space-block" aria-label={`${SPLIT_LABELS[split]} 묶음`}>
      <h2>
        {SPLIT_LABELS[split]} <span className="count">{SPLIT_SIZES[split]}건 묶음</span>
      </h2>
      <p className="muted small">{SPLIT_NOTES[split]}</p>
      {methods.length === 0 ? (
        <p className="empty">아직 잰 것이 없습니다.</p>
      ) : (
        <>
          {methods.some((m) => {
            const docs = (latest.get(m)?.metrics as Partial<EvalMetrics> | undefined)?.docs;
            return typeof docs === 'number' && docs < SPLIT_SIZES[split];
          }) ? (
            <Notice kind="warn">묶음 {SPLIT_SIZES[split]}건을 다 채점한 실행이 아닙니다. 채점한 문서 수를 표의 첫 줄에서 확인해 주세요.</Notice>
          ) : null}
          {versions.size > 1 ? <Notice kind="warn">방식마다 정답 버전이 다릅니다. 아래 숫자를 나란히 견주면 안 됩니다.</Notice> : null}
          {methods.some((m) => hasUnreviewed(latest.get(m)?.metrics)) ? (
            <Notice kind="warn">사람이 확인하지 않은 문서가 채점에 든 실행입니다. 정답이 틀렸을 수 있어, 이 숫자는 고칠 때 보는 참고값입니다.</Notice>
          ) : null}
          {currentGoldVersion !== null && methods.some((m) => (latest.get(m)?.goldVersion ?? currentGoldVersion) < currentGoldVersion) ? (
            <Notice kind="warn">옛 정답으로 잰 값입니다. 지금 정답은 버전 {currentGoldVersion}입니다. 다시 재기 전까지 이 숫자는 지금 정답과 맞지 않습니다.</Notice>
          ) : null}
          {methods.some((m) => latest.get(m)?.gitCommit.endsWith('-dirty')) ? (
            <Notice kind="warn">커밋하지 않은 변경이 있는 코드로 잰 실행입니다. 적힌 커밋만으로는 같은 결과를 다시 낼 수 없습니다.</Notice>
          ) : null}
          <div className="table-wrap" tabIndex={0} role="region" aria-label={`${SPLIT_LABELS[split]} 방식별 비교표`}>
            <table>
              <thead>
                <tr>
                  <th scope="col">지표 (분자 / 분모)</th>
                  {methods.map((m) => (
                    <th scope="col" key={m}>
                      {METHOD_LABELS[m]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">
                      {row.label}
                      <span className="muted small"> {row.hint}</span>
                    </th>
                    {methods.map((m) => (
                      <td key={m}>{row.read((latest.get(m)?.metrics ?? {}) as Partial<EvalMetrics>)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details className="help">
            <summary>칸별 정확도</summary>
            <div className="table-wrap" tabIndex={0} role="region" aria-label={`${SPLIT_LABELS[split]} 칸별 정확도`}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">칸</th>
                    {methods.map((m) => (
                      <th scope="col" key={m}>
                        {METHOD_LABELS[m]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {FIELD_KEYS.filter((key) => methods.some((m) => isRatio((latest.get(m)?.metrics as Partial<EvalMetrics>).fieldAccuracy?.byField?.[key]))).map((key) => (
                    <tr key={key}>
                      <th scope="row">{fieldLabel(key)}</th>
                      {methods.map((m) => (
                        <td key={m}>{ratio((latest.get(m)?.metrics as Partial<EvalMetrics>).fieldAccuracy?.byField?.[key])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          <ul className="plain muted small">
            {methods.map((m) => {
              const run = latest.get(m);
              if (!run) return null;
              return (
                <li key={m}>
                  {METHOD_LABELS[m]}: 실행 #{run.id} · {formatTime(run.startedAt)} · 정답 버전 {run.goldVersion}
                  {run.model ? ` · 모델 ${run.model}` : ''}
                  {run.promptVersion ? ` · 프롬프트 ${run.promptVersion}` : ''} · 커밋 {commitLabel(run.gitCommit)}
                  {hasUnreviewed(run.metrics) ? ' · 확인 전 문서 포함' : ''}
                </li>
              );
            })}
          </ul>
          <div className="actions">
            {methods.map((m) => {
              const run = latest.get(m);
              return run ? <WrongDocs key={run.id} run={run} /> : null;
            })}
          </div>
        </>
      )}
    </section>
  );
}

/** CSV 한 장을 줄과 칸으로 나눈다. 큰따옴표 안의 쉼표·줄바꿈은 칸의 일부다. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function Corrections() {
  const mounted = useMounted();
  const workspace = useWorkspace();
  const [counts, setCounts] = useState<{ field: string; n: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mounted || !workspace) return;
    let alive = true;
    callText('/api/export.csv?kind=corrections')
      .then((text) => {
        if (!alive) return;
        const rows = parseCsv(text);
        const at = (rows[0] ?? []).indexOf(CORRECTION_COLUMNS[2]);
        const tally = new Map<string, number>();
        for (const row of rows.slice(1)) {
          const field = row[at];
          if (at >= 0 && field) tally.set(field, (tally.get(field) ?? 0) + 1);
        }
        setCounts([...tally].map(([field, n]) => ({ field, n })).sort((a, b) => b.n - a.n));
      })
      .catch((err: unknown) => {
        if (alive) setError(failureMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [mounted, workspace]);

  return (
    <section className="space-block" aria-label="가장 자주 고친 칸">
      <h2>가장 자주 고친 칸</h2>
      <p className="muted small">이 브라우저의 작업 공간에서 사람이 값을 고친 횟수입니다. 고친 값은 “정답 후보”로 쌓입니다(상품 화면에서 CSV로 내려받을 수 있습니다).</p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!mounted ? null : !workspace || (counts && counts.length === 0) ? (
        <p className="empty">아직 사람이 고친 값이 없습니다.</p>
      ) : counts ? (
        <ol>
          {counts.map((c) => (
            <li key={c.field}>
              {fieldLabel(c.field)} — {c.n}번
            </li>
          ))}
        </ol>
      ) : error ? null : (
        <p className="muted">읽어 오는 중…</p>
      )}
    </section>
  );
}

export function Report() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [goldVersions, setGoldVersions] = useState<EvalRunListResponse['goldVersions']>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    call<EvalRunListResponse>('GET', '/api/eval/runs')
      .then((list) => {
        if (!alive) return;
        setRuns(list.items);
        setGoldVersions(list.goldVersions);
      })
      .catch((err: unknown) => {
        if (alive) setError(failureMessage(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="page wide">
      <h1>성적표</h1>
      <p className="muted">
        평가 실행이 남긴 기록입니다. 사람이 확인한 정답으로 잰 것인지, 확인 전 문서가 든 것인지는 묶음마다 적습니다. 잰 것만 적고, 묶음별 점수는 합치지 않습니다. “규칙만”과 견준 차이를 “개선”이라고 부르지 않습니다(기준선 규칙을 대충
        짤수록 커지는 숫자입니다).
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!runs && !error ? <p className="muted">읽어 오는 중…</p> : null}
      {runs && runs.length === 0 ? <p className="empty">아직 잰 것이 없습니다. 평가는 로컬 명령(npm run eval)으로 돌리고, 돌린 결과만 여기에 나옵니다.</p> : null}
      {runs && runs.length > 0
        ? SPLIT_ORDER.filter((s) => (GOLD_SPLITS as readonly string[]).includes(s)).map((split) => (
            <SplitBlock key={split} split={split} runs={runs.filter((r) => r.split === split)} currentGoldVersion={goldVersions?.[split] ?? null} />
          ))
        : null}
      <Corrections />
      <section className="space-block" aria-label="읽을 때 알아 둘 것">
        <h2>읽을 때 알아 둘 것</h2>
        <ul>
          <li>대부분 합성 자료입니다. 원문은 AI가 썼고 읽는 것도 같은 회사의 모델입니다.</li>
          <li>사람 확인이 끝나지 않은 묶음의 숫자에는 경고가 붙습니다. 그 숫자는 바깥에 내세우는 값이 아닙니다.</li>
          <li>정답을 확인한 사람이 한 명입니다. 건수가 작아 몇 건 차이로 비율이 크게 움직입니다.</li>
          <li>녹화본으로 다시 채점한 실행의 비용과 시간은 녹화할 때 잰 값입니다.</li>
        </ul>
      </section>
    </main>
  );
}
