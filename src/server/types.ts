// 저장 층이 함께 쓰는 작은 타입.
import type { Pool, PoolClient } from 'pg';

/** 쿼리를 보낼 수 있는 것. 풀이면 한 문장이 한 트랜잭션, 클라이언트면 열어 둔 트랜잭션 안이다. */
export type Db = Pool | PoolClient;

/** bigserial 은 글자로 온다. 번호는 2^53 을 넘지 않으므로 수로 바꿔 쓴다. */
export function toId(value: string | number): number {
  return Number(value);
}
