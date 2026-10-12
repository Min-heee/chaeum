// PostgreSQL 연결 풀 하나. SQL 은 직접 쓴다.
import { Pool, type PoolClient } from 'pg';

const globalForPool = globalThis as unknown as { __chaeumPool?: Pool };

/**
 * 풀을 처음 쓸 때 만든다(빌드할 때는 DB 가 없어도 된다).
 * 서버리스에서는 함수 하나가 풀 하나를 가지므로 연결 수를 작게 잡는다.
 */
export function getPool(): Pool {
  if (globalForPool.__chaeumPool) return globalForPool.__chaeumPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL 이 없다');

  const max = Number(process.env.PG_POOL_MAX) || 3;
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  // 쉬는 연결이 끊겨도 서버가 죽지 않게 한다.
  pool.on('error', (err) => console.error('[db] 쉬는 연결 오류:', err.message));

  globalForPool.__chaeumPool = pool;
  return pool;
}

/** 트랜잭션 하나. 오류가 나면 되돌린다. 이 안에서 LLM 을 부르지 않는다. */
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 풀을 닫는다. 스크립트와 시험이 끝날 때 부른다. */
export async function closePool(): Promise<void> {
  const pool = globalForPool.__chaeumPool;
  globalForPool.__chaeumPool = undefined;
  if (pool) await pool.end();
}
