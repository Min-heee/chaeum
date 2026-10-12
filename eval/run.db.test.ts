// 평가 실행이 DB 에 남기는 것을 본다. 시험용 DB 가 필요하다(이름이 .db.test.ts 로 끝난다).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GoldDoc, GoldSplit } from '@/contract/eval-types';
import type { Extraction } from '@/contract/fields';
import type { LlmCallStore, LlmProvider, LlmRequest, LlmResult } from '@/contract/llm-types';
import { cacheKeyFor, costUsd } from '@/llm';
import { buildExtractRequestV1 } from '@/llm/prompts/extract.v1';
import { closePool, getPool } from '@/server/db';
import { compareRuns } from './compare';
import { executeRun, type ExecuteParams } from './run';
import { countRuns, loadRunCells } from './store';

const MODEL = 'claude-haiku-5-5';
const USAGE = { inputTokens: 10_000, outputTokens: 2_000 };
const COMMIT = 'evaltest';

const nameOf = (n: number) => `평가 시험용 엽서 ${n}호`;
const contentOf = (n: number) => `${nameOf(n)}\n사이즈 100x148mm\n판매가 15,000원`;

function doc(n: number, split: GoldSplit): GoldDoc {
  return {
    id: `${split}-90${n}`,
    split,
    goldVersion: 1,
    content: contentOf(n),
    author: 'ai',
    traps: [],
    truth: {
      type: 'goods',
      subtype: '인쇄물',
      fields: {
        name: nameOf(n), price_krw: 15000, list_price_krw: null, vat_included: null,
        size_mm: { width: 100, height: 148 }, material: null, lead_time_days: null, min_order_qty: null,
      },
    },
  };
}

function answer(text: string, price: number): Extraction {
  const name = text.split('\n')[0]!;
  return {
    type: 'goods',
    subtype: '인쇄물',
    fields: [
      { field: 'name', raw: name, value: name, evidence: name },
      { field: 'price_krw', raw: null, value: price, evidence: '판매가 15,000원' },
      { field: 'size_mm', raw: '100x148mm', value: { width: 100, height: 148 }, evidence: '사이즈 100x148mm' },
    ],
  };
}

/** 실제 공급자처럼 장부에 적는 가짜. 2호 문서의 값은 priceFor2 로 낸다. */
function makeLive(priceFor2: number, asked: string[]) {
  return (store: LlmCallStore): LlmProvider => ({
    name: 'anthropic',
    model: MODEL,
    async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      const text = (req.input as { text: string }).text;
      asked.push(text);
      const out = answer(text, text.includes('2호') ? priceFor2 : 15000);
      await store.save({
        task: req.task, provider: 'anthropic', model: MODEL, promptVersion: req.promptVersion,
        cacheKey: cacheKeyFor(req as LlmRequest<unknown>, MODEL), response: out, stopReason: 'end_turn',
        inputTokens: USAGE.inputTokens, outputTokens: USAGE.outputTokens, costUsd: costUsd(MODEL, USAGE), latencyMs: 900, isRecorded: false,
      });
      return { output: req.schema.parse(out), stopReason: 'end_turn', usage: USAGE, latencyMs: 900, recorded: false };
    },
  });
}

let dir: string;

async function cleanUp(): Promise<void> {
  const db = getPool();
  // 이 시험이 만든 줄만 지운다.
  await db.query(`DELETE FROM llm_calls WHERE eval_run_id IN (SELECT id FROM eval_runs WHERE git_commit = $1)`, [COMMIT]);
  await db.query(`DELETE FROM eval_runs WHERE git_commit = $1`, [COMMIT]);
}

const params = (split: GoldSplit, over: Partial<ExecuteParams>): ExecuteParams => ({
  split,
  docs: [1, 2, 3].map((n) => doc(n, split)),
  selection: { excludedUnreviewed: 4, excludedDropped: 1, includesUnreviewed: false },
  limit: null,
  model: MODEL,
  build: buildExtractRequestV1,
  db: getPool(),
  extraReaders: [],
  extraWriter: null,
  makeLive: null,
  maxUsd: null,
  startedAt: new Date('2026-10-12T01:02:03Z'),
  gitCommit: COMMIT,
  resultsDir: dir,
  ...over,
});

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'chaeum-eval-'));
  await cleanUp();
});

afterAll(async () => {
  await cleanUp();
  rmSync(dir, { recursive: true, force: true });
  await closePool();
});

describe('평가 실행을 DB 와 파일에 남기기', () => {
  it('한 번 돌리면 eval_runs 3줄과 결과 줄이 남고, 장부 줄에 실행 번호가 붙는다', async () => {
    const asked: string[] = [];
    const { file, paths } = await executeRun(params('dev', { makeLive: makeLive(99000, asked), limit: 3 }));
    expect(asked).toHaveLength(3);

    const db = getPool();
    const runs = await db.query('SELECT id, split, method, model, prompt_version, gold_version, git_commit, metrics, cost_usd FROM eval_runs WHERE git_commit = $1 ORDER BY id', [COMMIT]);
    expect(runs.rows.map((r) => r.method)).toEqual(['rules', 'llm_only', 'llm_code']);
    expect(runs.rows.map((r) => r.model)).toEqual([null, MODEL, MODEL]);
    expect(runs.rows.map((r) => r.prompt_version)).toEqual([null, 'extract-v1', 'extract-v1']);
    expect(runs.rows.map((r) => Number(r.cost_usd))).toEqual([0, 0, 0.006]);
    const llmCode = runs.rows[2];
    expect(llmCode.metrics.docs).toBe(3);
    expect(llmCode.metrics.docsAllCorrect).toEqual({ num: 2, den: 3 });
    expect(llmCode.metrics.runInfo).toMatchObject({ includeUnreviewed: false, excludedUnreviewed: 4, excludedDropped: 1, limit: 3, stoppedByBudget: false });

    // 문서 3 × (type + subtype + 굿즈 칸 8) = 30줄씩
    const counts = await db.query('SELECT run_id, count(*)::int AS n FROM eval_results WHERE run_id = ANY($1) GROUP BY run_id', [runs.rows.map((r) => r.id)]);
    expect(counts.rows.map((r) => r.n)).toEqual([30, 30, 30]);
    const wrong = await db.query(`SELECT expected, actual, verdict FROM eval_results WHERE run_id = $1 AND gold_doc_id = 'dev-902' AND field = 'price_krw'`, [llmCode.id]);
    expect(wrong.rows[0]).toEqual({ expected: 15000, actual: 99000, verdict: 'wrong' });

    const ledger = await db.query('SELECT count(*)::int AS n FROM llm_calls WHERE eval_run_id = $1', [llmCode.id]);
    expect(ledger.rows[0].n).toBe(3);

    expect(file.runs.llm_code.runId).toBe(Number(llmCode.id));
    expect(existsSync(paths.json)).toBe(true);
    const summary = readFileSync(paths.summary, 'utf8');
    expect(summary).toContain('dev-902');
    expect(summary).toContain('`price_krw` wrong');
    expect(summary).toContain('연습 세트의 점수다');
    expect(summary).toContain(COMMIT);
  });

  it('다시 돌리면 장부에서 읽어 돈이 들지 않고, 두 실행을 건별로 견줄 수 있다', async () => {
    const asked: string[] = [];
    const again = await executeRun(params('dev', { makeLive: makeLive(15000, asked), startedAt: new Date('2026-10-12T02:00:00Z') }));
    expect(asked).toHaveLength(0);
    expect(again.file.costUsd).toBe(0);
    expect(again.file.runs.llm_code.metrics.costTime).toMatchObject({ costUsdTotal: 0.006, latencyMsP50: 900, fromRecording: true });

    const db = getPool();
    const ids = (await db.query(`SELECT id FROM eval_runs WHERE git_commit = $1 AND method = 'llm_code' ORDER BY id`, [COMMIT])).rows.map((r) => Number(r.id));
    const [base, other] = await Promise.all(ids.map((id) => loadRunCells(db, id)));
    const cmp = compareRuns(base!, other!);
    expect(cmp).toMatchObject({ improved: [], regressed: [], unchanged: 3, onlyInBase: [], onlyInOther: [] });
    expect(await loadRunCells(db, 2_000_000_000)).toBeNull();
  });

  it('fresh 로 돌리면 장부에 답이 있어도 모두 다시 부르고, 장부에는 아무것도 적지 않는다', async () => {
    const db = getPool();
    const ledgerRows = async () => (await db.query(`SELECT count(*)::int AS n FROM llm_calls WHERE eval_run_id IN (SELECT id FROM eval_runs WHERE git_commit = $1)`, [COMMIT])).rows[0].n as number;
    const before = await ledgerRows();
    const asked: string[] = [];
    const written: unknown[] = [];
    const extraWriter: LlmCallStore = { find: async () => null, save: async (r) => void written.push(r) };
    const { file, paths } = await executeRun(
      params('dev', { makeLive: makeLive(15000, asked), fresh: true, extraWriter, maxUsd: 0.01, startedAt: new Date('2026-10-12T02:30:00Z') }),
    );
    // 앞 시험들이 같은 요청의 답을 장부에 남겼지만 읽지 않는다.
    expect(asked).toHaveLength(3);
    expect(file.costUsd).toBe(0.006);
    expect(file.calls.every((c) => !c.recorded)).toBe(true);
    expect(file.runs.llm_code.metrics.docsAllCorrect).toEqual({ num: 3, den: 3 });
    expect(file.info.fresh).toBe(true);
    expect(await ledgerRows()).toBe(before);
    expect(written).toEqual([]);
    const row = await db.query('SELECT metrics, cost_usd FROM eval_runs WHERE id = $1', [file.runs.llm_code.runId]);
    expect(row.rows[0].metrics.runInfo.fresh).toBe(true);
    expect(Number(row.rows[0].cost_usd)).toBe(0.006);
    expect(readFileSync(paths.summary, 'utf8')).toContain('--fresh');
    // 그 뒤에 평소처럼 돌리면 먼저 남긴 녹화본(2호 문서의 값 99000)을 그대로 읽는다.
    const later = await executeRun(params('dev', { makeLive: makeLive(15000, asked), startedAt: new Date('2026-10-12T02:40:00Z') }));
    expect(asked).toHaveLength(3);
    expect(later.file.info.fresh).toBeUndefined();
    expect(later.file.runs.llm_code.metrics.docsAllCorrect).toEqual({ num: 2, den: 3 });
  });

  it('확인 전 문서를 넣고 돌리면 실행 기록에 남는다', async () => {
    const { file } = await executeRun(
      params('dev', { selection: { excludedUnreviewed: 0, excludedDropped: 0, includesUnreviewed: true }, startedAt: new Date('2026-10-12T03:00:00Z') }),
    );
    expect(file.info.includeUnreviewed).toBe(true);
    const row = await getPool().query('SELECT metrics FROM eval_runs WHERE id = $1', [file.runs.rules.runId]);
    expect(row.rows[0].metrics.runInfo.includeUnreviewed).toBe(true);
    expect(readFileSync(path.join(dir, '20261012T030000Z-dev-extract-v1.md'), 'utf8')).toContain('확인 전 포함');
  });

  it('실제 자료 묶음은 값을 DB 에도 파일에도 싣지 않는다(판정만)', async () => {
    const before = await countRuns(getPool(), 'real');
    const { file, paths } = await executeRun(params('real', { makeLive: makeLive(99000, []), startedAt: new Date('2026-10-12T04:00:00Z') }));
    expect(await countRuns(getPool(), 'real')).toBe(before + 1);
    const rows = await getPool().query('SELECT expected, actual, verdict FROM eval_results WHERE run_id = $1', [file.runs.llm_code.runId]);
    expect(rows.rows).toHaveLength(30);
    expect(rows.rows.every((r) => r.expected === null && r.actual === null)).toBe(true);
    expect(rows.rows.some((r) => r.verdict === 'wrong')).toBe(true);
    const json = readFileSync(paths.json, 'utf8');
    expect(json).not.toContain('평가 시험용 엽서');
    expect(json).not.toContain('99000');
    expect(readFileSync(paths.summary, 'utf8')).not.toContain('99000');
  });

  it('상한에 걸리면 끝난 데까지 저장한다', async () => {
    const fresh = [4, 5, 6].map((n) => doc(n, 'hand'));
    const { file } = await executeRun(params('hand', { docs: fresh, makeLive: makeLive(15000, []), maxUsd: 0.003, startedAt: new Date('2026-10-12T05:00:00Z') }));
    expect(file.stoppedByBudget).toBe(true);
    expect(file.docIds).toEqual(['hand-904']);
    expect(file.notRun).toEqual(['hand-905', 'hand-906']);
    const row = await getPool().query('SELECT metrics, cost_usd FROM eval_runs WHERE id = $1', [file.runs.llm_code.runId]);
    expect(row.rows[0].metrics.docs).toBe(1);
    expect(row.rows[0].metrics.runInfo.stoppedByBudget).toBe(true);
    expect(Number(row.rows[0].cost_usd)).toBe(0.002);
  });
});
