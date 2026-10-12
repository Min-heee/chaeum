// 15. 살아 있는지 보기: DB 연결, 줄 길이, LLM 방식과 오늘 남은 실제 호출, 오늘 남은 접수 상한.
import { NextResponse } from 'next/server';
import { COUNTER_KEYS, LIMITS, kstDay, type HealthResponse } from '@/contract/api';
import { LIVE_LLM } from '@/contract/pipeline-api';
import { getPool } from '@/server/db';
import { llmStatus } from '@/server/service';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** LLM 칸. DB 가 죽어 오늘 쓴 수를 못 세면 실제 호출을 닫힌 것으로 답한다(자리를 잡을 수 없으니 실제로도 못 부른다). */
async function readLlm(now: Date): Promise<HealthResponse['llm']> {
  try {
    return await llmStatus(process.env, now);
  } catch {
    return llmStatus({ ...process.env, [LIVE_LLM.capEnv]: '0' }, now);
  }
}

export async function GET() {
  const startedAt = performance.now();
  const now = new Date();
  const llm = await readLlm(now);

  try {
    const pool = getPool();
    const queue = await pool.query<{ queued: string; running: string; dead: string }>(
      `SELECT count(*) FILTER (WHERE status = 'queued')  AS queued,
              count(*) FILTER (WHERE status = 'running') AS running,
              count(*) FILTER (WHERE status = 'dead')    AS dead
         FROM jobs`,
    );
    const counter = await pool.query<{ count: number }>(
      'SELECT count FROM daily_counters WHERE day = $1 AND key = $2',
      [kstDay(now), COUNTER_KEYS[0]],
    );
    const row = queue.rows[0];
    const usedToday = counter.rows[0]?.count ?? 0;

    const body: HealthResponse = {
      ok: true,
      db: true,
      dbMs: Math.round(performance.now() - startedAt),
      queue: { queued: Number(row?.queued ?? 0), running: Number(row?.running ?? 0), dead: Number(row?.dead ?? 0) },
      llm,
      intakeLeftToday: Math.max(0, LIMITS.intakePerDay - usedToday),
    };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    // 연결 주소 같은 값이 새지 않게 오류 글은 내보내지 않는다.
    console.error('[health] DB 확인 실패:', err instanceof Error ? err.name : 'unknown');
    const body: HealthResponse = { ok: false, db: false, llm };
    return NextResponse.json(body, { status: 503, headers: NO_STORE });
  }
}
