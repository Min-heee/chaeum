// 하루 상한 세기. 날짜 경계는 한국 시각이고, 지금 시각은 인자로 받는다.
import { kstDay, type CounterKey } from '@/contract/api';
import type { Db } from '../types';

/**
 * 오늘 수를 by 만큼 올린다. 올린 뒤가 cap 을 넘으면 올리지 않고 ok: false.
 * 한 문장이라 여럿이 동시에 올려도 상한을 넘지 않는다.
 */
export async function bumpCounter(db: Db, key: CounterKey, now: Date, by: number, cap: number): Promise<{ ok: boolean; count: number }> {
  if (by > cap) return { ok: false, count: await readCounter(db, key, now) };
  const { rows } = await db.query<{ count: number }>(
    `INSERT INTO daily_counters (day, key, count) VALUES ($1, $2, $3)
     ON CONFLICT (day, key) DO UPDATE SET count = daily_counters.count + $3
       WHERE daily_counters.count + $3 <= $4
     RETURNING count`,
    [kstDay(now), key, by, cap],
  );
  const row = rows[0];
  if (row) return { ok: true, count: row.count };
  return { ok: false, count: await readCounter(db, key, now) };
}

export async function readCounter(db: Db, key: CounterKey, now: Date): Promise<number> {
  const { rows } = await db.query<{ count: number }>('SELECT count FROM daily_counters WHERE day = $1 AND key = $2', [kstDay(now), key]);
  return rows[0]?.count ?? 0;
}
