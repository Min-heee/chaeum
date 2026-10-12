// 호출 장부(PostgreSQL)를 LLM 자리에 끼워 본다. src/llm 은 DB 를 모르고, 장부는 src/server 가 넘긴다.
// 트랜잭션 하나 안에서 돌고 끝나면 되돌린다.
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Extraction } from '@/contract/fields';
import { buildExtractRequest, cacheKeyFor, createProvider } from '@/llm';
import { closePool, getPool } from '@/server/db';
import { PgLlmCallStore } from '@/server/repos/llm-calls';

const MODEL = 'claude-haiku-5-5';
const answer: Extraction = { type: 'goods', subtype: '잡화', fields: [{ field: 'name', raw: '응원 슬로건', value: '응원 슬로건', evidence: '응원 슬로건' }] };
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);

describe('호출 장부를 LLM 자리에 끼우기', () => {
  let client: PoolClient;

  beforeEach(async () => {
    client = await getPool().connect();
    await client.query('BEGIN');
  });
  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });
  afterAll(closePool);

  it('녹화가 없으면 재생은 CACHE_MISS 를 낸다', async () => {
    const replay = createProvider({ kind: 'replay', model: MODEL, store: new PgLlmCallStore({ db: client }) });
    expect(await codeOf(replay.complete(buildExtractRequest('장부에 없는 글')))).toBe('CACHE_MISS');
  });

  /** 실제 호출이 적은 것과 같은 꼴의 줄. */
  const liveCall = (req: ReturnType<typeof buildExtractRequest>) => ({
    task: req.task, provider: 'anthropic' as const, model: MODEL, promptVersion: req.promptVersion, cacheKey: cacheKeyFor(req, MODEL),
    response: answer, stopReason: 'end_turn', inputTokens: 1800, outputTokens: 600, costUsd: 0.00048, latencyMs: 2100, isRecorded: false,
  });

  it('장부에 적힌 실제 호출의 답을 재생 구현이 같은 키로 찾아 돌려준다', async () => {
    const store = new PgLlmCallStore({ db: client });
    const req = buildExtractRequest('응원 슬로건 200x600mm, 장당 5,000원');
    await store.save(liveCall(req));

    const replayed = await createProvider({ kind: 'replay', model: MODEL, store }).complete(req);
    expect(replayed.output).toEqual(answer);
    expect(replayed).toMatchObject({ recorded: true, latencyMs: 2100, usage: { inputTokens: 1800, outputTokens: 600 } });
  });

  it('시험용 구현이 적은 줄은 장부에 남지만 재생은 녹화로 치지 않는다', async () => {
    const store = new PgLlmCallStore({ db: client });
    const req = buildExtractRequest('응원 슬로건 200x600mm, 장당 5,000원');
    const live = await createProvider({ kind: 'fake', model: MODEL, store, fakeAnswer: () => answer }).complete(req);
    expect(live.recorded).toBe(false);

    const { rows } = await client.query('SELECT task, provider, model, prompt_version, cache_key, eval_run_id FROM llm_calls WHERE cache_key = $1', [cacheKeyFor(req, MODEL)]);
    expect(rows).toEqual([{ task: 'extract', provider: 'fake', model: MODEL, prompt_version: req.promptVersion, cache_key: cacheKeyFor(req, MODEL), eval_run_id: null }]);
    expect(await codeOf(createProvider({ kind: 'replay', model: MODEL, store }).complete(req))).toBe('CACHE_MISS');
  });

  it('모델 이름이 다르면 키가 달라 찾지 못한다', async () => {
    const store = new PgLlmCallStore({ db: client });
    const req = buildExtractRequest('응원 슬로건 200x600mm, 장당 5,000원');
    await store.save(liveCall(req));
    expect(await codeOf(createProvider({ kind: 'replay', model: 'claude-sonnet-5-5', store }).complete(req))).toBe('CACHE_MISS');
  });

  it('평가 실행 번호를 주면 적는 줄마다 그 번호가 붙는다', async () => {
    const run = await client.query<{ id: string }>(
      "INSERT INTO eval_runs (split, method, gold_version, git_commit) VALUES ('dev', 'llm_code', 1, 'test') RETURNING id",
    );
    const runId = Number(run.rows[0]?.id);
    const store = new PgLlmCallStore({ db: client, evalRunId: runId });
    const req = buildExtractRequest('평가에서 부른 글');
    await createProvider({ kind: 'fake', model: MODEL, store, fakeAnswer: () => answer }).complete(req);
    const { rows } = await client.query<{ eval_run_id: string }>('SELECT eval_run_id FROM llm_calls WHERE cache_key = $1', [cacheKeyFor(req, MODEL)]);
    expect(rows.map((r) => Number(r.eval_run_id))).toEqual([runId]);
  });
});
