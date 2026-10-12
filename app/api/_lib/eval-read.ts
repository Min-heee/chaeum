// 평가 실행 읽기(eval_runs, eval_results). 공간과 상관없는 공용 읽기다. 쓰지 않는다.
// 견주기 규칙은 평가기의 것(eval/compare.ts)을 그대로 쓴다.
import type { EvalRunDetailResponse, EvalRunListResponse } from '@/contract/api';
import { isDocAllCorrect, type EvalMethod, type GoldSplit, type Verdict } from '@/contract/eval-types';
import { getPool } from '@/server/db';
import { AppError } from '@/server/errors';
import { compareRuns } from '../../../eval/compare';
import { loadRunCells } from '../../../eval/store';

type Run = EvalRunListResponse['items'][number];

/** 목록 한 번에 싣는 실행 수. */
const RUN_LIST_MAX = 200;

interface RunRow {
  id: string;
  split: GoldSplit;
  method: EvalMethod;
  model: string | null;
  prompt_version: string | null;
  gold_version: number;
  git_commit: string;
  metrics: Record<string, unknown> | null;
  cost_usd: string;
  started_at: Date;
}

const RUN_COLUMNS = 'id, split, method, model, prompt_version, gold_version, git_commit, metrics, cost_usd, started_at';

const runBody = (r: RunRow): Run => ({
  id: Number(r.id),
  split: r.split,
  method: r.method,
  model: r.model,
  promptVersion: r.prompt_version,
  goldVersion: r.gold_version,
  gitCommit: r.git_commit,
  metrics: r.metrics ?? {},
  costUsd: Number(r.cost_usd),
  startedAt: r.started_at.toISOString(),
});

/** 실행 목록. 새것부터. */
export async function evalRunList(): Promise<EvalRunListResponse> {
  const pool = getPool();
  const { rows } = await pool.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM eval_runs ORDER BY id DESC LIMIT $1`, [RUN_LIST_MAX]);
  // 묶음별 지금 정답 버전. 버전 수만 읽는다(원문도 정답도 읽지 않는다).
  const versions = await pool.query<{ split: GoldSplit; version: number }>('SELECT split, max(gold_version)::int AS version FROM gold_docs GROUP BY split');
  const goldVersions: Partial<Record<GoldSplit, number>> = {};
  for (const v of versions.rows) goldVersions[v.split] = v.version;
  return { items: rows.map(runBody), goldVersions };
}

/**
 * 실행 하나의 지표와 문서별 결과.
 * against 를 주면 그 실행을 앞(base), 이 실행을 뒤(other)로 놓고 견준다.
 * 없는 번호면 NOT_FOUND, 묶음·정답 버전·방식이 달라 견줄 수 없으면 BAD_INPUT.
 */
export async function evalRunDetail(runId: number, against?: number): Promise<EvalRunDetailResponse> {
  const pool = getPool();
  const found = await pool.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM eval_runs WHERE id = $1`, [runId]);
  const row = found.rows[0];
  if (!row) throw new AppError('NOT_FOUND', '평가 실행이 없습니다.');

  const cells = await pool.query<{ gold_doc_id: string; field: string; expected: unknown; actual: unknown; verdict: Verdict; flagged: boolean }>(
    'SELECT gold_doc_id, field, expected, actual, verdict, flagged FROM eval_results WHERE run_id = $1 ORDER BY gold_doc_id, field',
    [runId],
  );
  // 실제 자료 묶음은 원문에서 온 값을 싣지 않는다. 저장할 때 이미 비우지만 여기서도 한 번 더 막는다.
  const hideValues = row.split === 'real';
  const byDoc = new Map<string, EvalRunDetailResponse['docs'][number]['cells']>();
  for (const c of cells.rows) {
    const list = byDoc.get(c.gold_doc_id) ?? [];
    list.push({
      field: c.field,
      expected: hideValues ? null : (c.expected ?? null),
      actual: hideValues ? null : (c.actual ?? null),
      verdict: c.verdict,
      flagged: c.flagged,
    });
    byDoc.set(c.gold_doc_id, list);
  }
  const docs = [...byDoc].map(([goldDocId, list]) => ({
    goldDocId,
    allCorrect: isDocAllCorrect(list),
    flagged: list.some((c) => c.flagged),
    cells: list,
  }));

  let comparison: EvalRunDetailResponse['comparison'] = null;
  if (against !== undefined) {
    const [base, other] = await Promise.all([loadRunCells(pool, against), loadRunCells(pool, runId)]);
    if (!base || !other) throw new AppError('NOT_FOUND', '견줄 평가 실행이 없습니다.');
    if (base.split !== other.split || base.goldVersion !== other.goldVersion || base.method !== other.method) {
      throw new AppError('BAD_INPUT', '묶음, 정답 버전, 방식이 같은 실행끼리만 견줄 수 있습니다.');
    }
    const cmp = compareRuns(base, other);
    comparison = {
      baseRunId: cmp.baseRunId,
      otherRunId: cmp.otherRunId,
      improved: cmp.improved,
      regressed: cmp.regressed,
      unchanged: cmp.unchanged,
      onlyInBase: cmp.onlyInBase,
      onlyInOther: cmp.onlyInOther,
    };
  }
  return { run: runBody(row), docs, comparison };
}
