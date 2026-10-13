// 평가 실행과 결과를 DB 에 적고 읽는다(eval_runs, eval_results). SQL 은 직접 쓴다.
import { EVAL_METHODS, type EvalCell, type EvalMethod, type EvalMetrics, type GoldSplit } from '@/contract/eval-types';
import type { RunCells } from './compare';

/** 쿼리를 보낼 수 있는 것(풀이나 클라이언트). */
export interface Db {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface NewRuns {
  split: GoldSplit;
  model: string;
  promptVersion: string;
  goldVersion: number;
  gitCommit: string;
  startedAt: Date;
}

/** 실행에 딸린 메모. eval_runs.metrics 안에 runInfo 로 함께 적는다. */
export interface RunInfo {
  /** 확인 전 문서를 넣고 돌렸는가("확인 전 포함") */
  includeUnreviewed: boolean;
  /** 확인 기록이 없어 뺀 문서 수 / 버림 판정으로 뺀 문서 수 */
  excludedUnreviewed: number;
  excludedDropped: number;
  /** --limit 을 줬으면 그 값 */
  limit: number | null;
  stoppedByBudget: boolean;
  replayOnly: boolean;
  /** 답을 못 받은 문서 수(llm 방식에서 빈 답으로 채점됐다) */
  callFailures: number;
  /** --fresh: 장부를 읽지도 쓰지도 않고 모든 문서를 다시 불렀는가. 옛 기록에는 이 줄이 없다. */
  fresh?: boolean;
  /** --fresh --keep-answers: 받은 답을 따로 남긴 파일(저장소 기준 경로). 장부가 아니다. 남기지 않았으면 이 줄이 없다. */
  answersFile?: string;
}

/**
 * 방식 셋의 줄을 먼저 만든다. 지표는 끝난 뒤 채운다.
 * 먼저 만들어 두므로 중간에 죽어도 "이 묶음을 돌렸다"는 흔적이 남는다.
 * rules 줄에는 모델과 프롬프트가 없다.
 */
export async function createRuns(db: Db, run: NewRuns): Promise<Record<EvalMethod, number>> {
  const ids = {} as Record<EvalMethod, number>;
  for (const method of EVAL_METHODS) {
    const usesLlm = method !== 'rules';
    const { rows } = await db.query(
      `INSERT INTO eval_runs (split, method, model, prompt_version, gold_version, git_commit, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [run.split, method, usesLlm ? run.model : null, usesLlm ? run.promptVersion : null, run.goldVersion, run.gitCommit, run.startedAt],
    );
    ids[method] = Number((rows[0] as { id: string | number }).id);
  }
  return ids;
}

export async function finishRun(db: Db, runId: number, metrics: EvalMetrics, costUsd: number, info: RunInfo): Promise<void> {
  await db.query('UPDATE eval_runs SET metrics = $2::jsonb, cost_usd = $3 WHERE id = $1', [
    runId,
    JSON.stringify({ ...metrics, runInfo: info }),
    costUsd,
  ]);
}

/**
 * 결과 줄을 한 번에 넣는다. 같은 실행을 다시 넣으면 그 실행의 줄을 지우고 다시 쓴다.
 * stripValues: 실제 자료 묶음은 원문에서 온 값을 싣지 않는다(판정과 표시만).
 */
export async function saveCells(db: Db, runId: number, cells: readonly EvalCell[], options: { stripValues?: boolean } = {}): Promise<void> {
  await db.query('DELETE FROM eval_results WHERE run_id = $1', [runId]);
  if (cells.length === 0) return;
  const rows = cells.map((c) => ({
    gold_doc_id: c.goldDocId,
    field: c.field,
    expected: options.stripValues ? null : (c.expected ?? null),
    actual: options.stripValues ? null : (c.actual ?? null),
    verdict: c.verdict,
    flagged: c.flagged,
  }));
  await db.query(
    `INSERT INTO eval_results (run_id, gold_doc_id, field, expected, actual, verdict, flagged)
     SELECT $1, x.gold_doc_id, x.field, x.expected, x.actual, x.verdict, x.flagged
       FROM jsonb_to_recordset($2::jsonb)
         AS x(gold_doc_id text, field text, expected jsonb, actual jsonb, verdict text, flagged boolean)`,
    [runId, JSON.stringify(rows)],
  );
}

/** 견주기에 쓸 실행 하나. 없으면 null. */
export async function loadRunCells(db: Db, runId: number): Promise<RunCells | null> {
  const run = await db.query('SELECT id, split, method, gold_version FROM eval_runs WHERE id = $1', [runId]);
  const head = run.rows[0] as { id: string | number; split: GoldSplit; method: EvalMethod; gold_version: number } | undefined;
  if (!head) return null;
  const { rows } = await db.query('SELECT gold_doc_id, field, verdict FROM eval_results WHERE run_id = $1 ORDER BY gold_doc_id, field', [runId]);
  return {
    runId: Number(head.id),
    split: head.split,
    method: head.method,
    goldVersion: head.gold_version,
    cells: (rows as { gold_doc_id: string; field: string; verdict: EvalCell['verdict'] }[]).map((r) => ({
      goldDocId: r.gold_doc_id,
      field: r.field as EvalCell['field'],
      verdict: r.verdict,
    })),
  };
}

/** 이 묶음을 지금까지 몇 번 돌렸나(실행 한 번 = 방식 셋이므로 llm_code 줄만 센다). */
export async function countRuns(db: Db, split: GoldSplit): Promise<number> {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM eval_runs WHERE split = $1 AND method = 'llm_code'`, [split]);
  return (rows[0] as { n: number }).n;
}
