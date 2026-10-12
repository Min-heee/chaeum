// 호출 장부(= 캐시 = 녹화본). 약속의 LlmCallStore 자리를 PostgreSQL 로 채운다.
// src/llm 은 DB 를 모른다. 공급자를 만들 때 이 장부를 넘겨준다.
import type { LlmCallRecord, LlmCallStore, LlmProviderName, LlmTask } from '@/contract/llm-types';
import { getPool } from '../db';
import type { Db } from '../types';

interface CallRow {
  task: LlmTask;
  provider: LlmProviderName;
  model: string;
  prompt_version: string;
  cache_key: string;
  response: unknown;
  stop_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | null;
  latency_ms: number | null;
  is_recorded: boolean;
}

const toRecord = (r: CallRow): LlmCallRecord => ({
  task: r.task,
  provider: r.provider,
  model: r.model,
  promptVersion: r.prompt_version,
  cacheKey: r.cache_key,
  response: r.response,
  stopReason: r.stop_reason ?? '',
  inputTokens: r.input_tokens ?? 0,
  outputTokens: r.output_tokens ?? 0,
  costUsd: Number(r.cost_usd ?? 0),
  latencyMs: r.latency_ms ?? 0,
  isRecorded: r.is_recorded,
});

export class PgLlmCallStore implements LlmCallStore {
  private readonly db: Db | undefined;
  private readonly evalRunId: number | null;

  /** db 를 안 주면 풀을 쓴다. evalRunId 를 주면 쓰는 줄마다 그 평가 실행 번호가 붙는다. */
  constructor(options: { db?: Db; evalRunId?: number | null } = {}) {
    this.db = options.db;
    this.evalRunId = options.evalRunId ?? null;
  }

  private get conn(): Db {
    return this.db ?? getPool();
  }

  /** 같은 키의 가장 최근 줄. 답이 없는 줄과 시험용 구현이 적은 줄은 건너뛴다. */
  async find(cacheKey: string): Promise<LlmCallRecord | null> {
    const { rows } = await this.conn.query<CallRow>(
      `SELECT * FROM llm_calls WHERE cache_key = $1 AND response IS NOT NULL AND provider <> 'fake' ORDER BY id DESC LIMIT 1`,
      [cacheKey],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async save(record: LlmCallRecord): Promise<void> {
    await this.conn.query(
      `INSERT INTO llm_calls (task, provider, model, prompt_version, cache_key, response, stop_reason,
                              input_tokens, output_tokens, cost_usd, latency_ms, is_recorded, eval_run_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)`,
      [
        record.task, record.provider, record.model, record.promptVersion, record.cacheKey,
        record.response === undefined ? null : JSON.stringify(record.response),
        record.stopReason, record.inputTokens, record.outputTokens, record.costUsd, record.latencyMs,
        record.isRecorded, this.evalRunId,
      ],
    );
  }
}
