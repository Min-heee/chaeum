// 살아 있는지 보기: DB 연결, 줄 길이, LLM 방식, 오늘 남은 접수 상한.
import { NextResponse } from 'next/server';
import { COUNTER_KEYS, LIMITS, kstDay } from '@/contract/api';
import { llmKindFromEnv } from '@/contract/llm-types';
import { getPool } from '@/server/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const startedAt = performance.now();

  let llm: string;
  try {
    llm = llmKindFromEnv(process.env);
  } catch {
    llm = 'invalid';
  }

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
      [kstDay(new Date()), COUNTER_KEYS[0]],
    );
    const row = queue.rows[0];
    const usedToday = counter.rows[0]?.count ?? 0;

    return NextResponse.json({
      ok: true,
      db: true,
      dbMs: Math.round(performance.now() - startedAt),
      queue: { queued: Number(row?.queued ?? 0), running: Number(row?.running ?? 0), dead: Number(row?.dead ?? 0) },
      llm,
      intakeLeftToday: Math.max(0, LIMITS.intakePerDay - usedToday),
    });
  } catch (err) {
    // 연결 주소 같은 값이 새지 않게 오류 글은 내보내지 않는다.
    console.error('[health] DB 확인 실패:', err instanceof Error ? err.name : 'unknown');
    return NextResponse.json({ ok: false, db: false, llm }, { status: 503 });
  }
}
