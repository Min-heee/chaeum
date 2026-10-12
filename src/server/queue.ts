// 작업 줄. PostgreSQL 표 하나(jobs)로 만든다.
//
//   넣기 → 집기(잠긴 줄은 건너뜀, 60초 임대) → 일(트랜잭션 밖) → 끝내기(결과 저장과 한 트랜잭션)
//   실패하면 5초, 10초 뒤 다시. 세 번 해도 안 되면 dead.
//   임대가 끝난 running 은 집기 전에 queued 로 돌린다(작업자가 죽은 경우).
//
// 지금 시각은 전부 인자로 받는다. 시험에서 시계를 돌려 임대 만료와 재시도를 본다.
//
// attempts 는 집을 때마다 1 늘어난다. 끝내기·실패 처리는 "내가 집었을 때의 attempts 와 임대 시각"이 그대로일 때만 먹는다.
// 임대가 끝나 남이 다시 집어 갔다면 둘 중 하나는 달라졌으므로 늦게 온 쪽의 결과는 버려진다.
// (다시 줄 세우기가 attempts 를 0 으로 돌리므로 attempts 만으로는 옛 임대와 새 임대를 가르지 못한다.)
import type { PoolClient } from 'pg';
import { QUEUE, type JobKind, type JobStatus } from '@/contract/api';
import { getPool, withTx } from './db';
import { toId, type Db } from './types';

export interface Job {
  id: number;
  kind: JobKind;
  /** extract 는 초안 번호, content 는 상품 번호 */
  refId: number;
  status: JobStatus;
  attempts: number;
  runAt: Date;
  leasedUntil: Date | null;
  lastError: string | null;
}

interface JobRow {
  id: string;
  kind: JobKind;
  ref_id: string;
  status: JobStatus;
  attempts: number;
  run_at: Date;
  leased_until: Date | null;
  last_error: string | null;
}

const toJob = (r: JobRow): Job => ({
  id: toId(r.id),
  kind: r.kind,
  refId: toId(r.ref_id),
  status: r.status,
  attempts: r.attempts,
  runAt: r.run_at,
  leasedUntil: r.leased_until,
  lastError: r.last_error,
});

const LAST_ERROR_MAX = 500;

/** 실패한 뒤 다시 하기까지 기다리는 시간. 첫 실패 5초, 둘째 10초. */
export function retryDelayMs(attempts: number): number {
  return QUEUE.retryBaseMs * 2 ** Math.max(0, attempts - 1);
}

// ── 넣기 ───────────────────────────────────────────────────

/** 작업을 넣는다. 같은 일(kind, refId)이 이미 있으면 넣지 않고 그 번호를 돌려준다. */
export async function enqueue(db: Db, kind: JobKind, refId: number, now: Date): Promise<{ jobId: number; created: boolean }> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO jobs (kind, ref_id, status, run_at) VALUES ($1, $2, 'queued', $3)
     ON CONFLICT (kind, ref_id) DO NOTHING RETURNING id`,
    [kind, refId, now],
  );
  const row = inserted.rows[0];
  if (row) return { jobId: toId(row.id), created: true };

  const existing = await db.query<{ id: string }>('SELECT id FROM jobs WHERE kind = $1 AND ref_id = $2', [kind, refId]);
  const found = existing.rows[0];
  if (!found) throw new Error('작업을 넣지도 찾지도 못했다');
  return { jobId: toId(found.id), created: false };
}

/**
 * 끝났거나 죽은 작업을 처음부터 다시 줄에 세운다(다시 돌리기). 없으면 새로 넣는다.
 * 아직 기다리거나 돌고 있는 작업은 건드리지 않고 false 를 돌려준다.
 */
export async function requeue(db: Db, kind: JobKind, refId: number, now: Date): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO jobs (kind, ref_id, status, run_at) VALUES ($1, $2, 'queued', $3)
     ON CONFLICT (kind, ref_id) DO UPDATE
       SET status = 'queued', attempts = 0, run_at = $3, leased_until = NULL, last_error = NULL
       WHERE jobs.status IN ('done', 'dead')
     RETURNING id`,
    [kind, refId, now],
  );
  return (result.rowCount ?? 0) > 0;
}

// ── 회수와 집기 ────────────────────────────────────────────

/**
 * 임대가 끝난 running 을 돌려놓는다. 이미 maxAttempts 번 집힌 작업은 dead 로 보낸다
 * (작업자를 매번 죽이는 작업이 줄을 끝없이 돌지 않게).
 */
export async function reclaimExpired(db: Db, now: Date): Promise<{ requeued: Job[]; dead: Job[] }> {
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs
        SET status = CASE WHEN attempts >= $2 THEN 'dead' ELSE 'queued' END,
            leased_until = NULL,
            last_error = '임대 시간이 지나도록 끝나지 않았다'
      WHERE status = 'running' AND leased_until < $1
      RETURNING *`,
    [now, QUEUE.maxAttempts],
  );
  const jobs = rows.map(toJob);
  return { requeued: jobs.filter((j) => j.status === 'queued'), dead: jobs.filter((j) => j.status === 'dead') };
}

/**
 * 차례가 된 작업을 limit 건까지 집는다. 한 문장이라 곧바로 커밋된다.
 * 다른 작업자가 잠근 줄은 기다리지 않고 건너뛴다. 그래서 같은 작업을 둘이 집지 않는다.
 */
export async function claim(db: Db, now: Date, limit: number, kinds?: readonly JobKind[]): Promise<Job[]> {
  if (limit <= 0 || (kinds && kinds.length === 0)) return [];
  const leasedUntil = new Date(now.getTime() + QUEUE.leaseMs);
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, leased_until = $2
      WHERE id IN (
        SELECT id FROM jobs
         WHERE status = 'queued' AND run_at <= $1 AND ($4::text[] IS NULL OR kind = ANY($4))
         ORDER BY run_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $3)
      RETURNING *`,
    [now, leasedUntil, limit, kinds ? [...kinds] : null],
  );
  return rows.map(toJob).sort((a, b) => a.runAt.getTime() - b.runAt.getTime() || a.id - b.id);
}

// ── 끝내기와 실패 ──────────────────────────────────────────

/** 집을 때 받은 것. 이 셋이 그대로여야 아직 내 임대다. */
export type Lease = Pick<Job, 'id' | 'attempts' | 'leasedUntil'>;

/**
 * 작업을 done 으로 바꾼다. 결과를 저장하는 트랜잭션 안에서 부른다.
 * false 면 임대를 잃은 것이다(남이 다시 집어 갔다). 그때는 결과를 저장하지 않는다.
 */
export async function complete(db: Db, job: Lease): Promise<boolean> {
  const result = await db.query(
    `UPDATE jobs SET status = 'done', leased_until = NULL, last_error = NULL
      WHERE id = $1 AND status = 'running' AND attempts = $2 AND leased_until = $3`,
    [job.id, job.attempts, job.leasedUntil],
  );
  return result.rowCount === 1;
}

export type FailOutcome = 'retry' | 'dead' | 'lost';

/**
 * 실패를 적는다. 아직 기회가 남았으면 뒤로 미뤄 다시 줄에 세우고(retry), 다 썼으면 dead.
 * retryable 이 false 면 기회가 남아도 바로 dead. 임대를 잃었으면 아무것도 안 바꾸고 lost.
 */
export async function fail(
  db: Db,
  job: Lease,
  message: string,
  now: Date,
  options: { retryable?: boolean } = {},
): Promise<FailOutcome> {
  const dead = options.retryable === false || job.attempts >= QUEUE.maxAttempts;
  const runAt = new Date(now.getTime() + retryDelayMs(job.attempts));
  const result = await db.query(
    `UPDATE jobs SET status = $3, run_at = CASE WHEN $3 = 'queued' THEN $4 ELSE run_at END,
            leased_until = NULL, last_error = $5
      WHERE id = $1 AND status = 'running' AND attempts = $2 AND leased_until = $6`,
    [job.id, job.attempts, dead ? 'dead' : 'queued', runAt, message.slice(0, LAST_ERROR_MAX), job.leasedUntil],
  );
  if (result.rowCount !== 1) return 'lost';
  return dead ? 'dead' : 'retry';
}

// ── 살펴보기 ───────────────────────────────────────────────

export async function getJob(db: Db, kind: JobKind, refId: number): Promise<Job | null> {
  const { rows } = await db.query<JobRow>('SELECT * FROM jobs WHERE kind = $1 AND ref_id = $2', [kind, refId]);
  return rows[0] ? toJob(rows[0]) : null;
}

/** 상태별 줄 길이. */
export async function queueDepth(db: Db): Promise<Record<JobStatus, number>> {
  const { rows } = await db.query<{ status: JobStatus; n: string }>('SELECT status, count(*) AS n FROM jobs GROUP BY status');
  const depth: Record<JobStatus, number> = { queued: 0, running: 0, done: 0, dead: 0 };
  for (const r of rows) depth[r.status] = Number(r.n);
  return depth;
}

// ── 굴리기 ─────────────────────────────────────────────────

/** 결과를 저장하는 함수. 굴리는 쪽이 "done 으로 바꾸기"와 같은 트랜잭션에서 부른다. */
export type SaveFn = (client: PoolClient, now: Date) => Promise<void>;

export interface JobHandler {
  /**
   * 일을 한다. 트랜잭션 밖에서 돈다(LLM 을 불러도 DB 연결을 붙잡지 않는다).
   * 저장할 것이 있으면 저장 함수를 돌려준다. 저장 함수는 여러 번 돌아도 결과가 한 번만 남게 쓴다.
   * 던진 오류에 retryable: false 가 있으면 다시 하지 않고 바로 dead 로 보낸다.
   */
  work(job: Job): Promise<SaveFn | void>;
  /** 작업이 dead 가 될 때 같은 트랜잭션에서 부른다(초안을 FAILED 로 바꾸는 자리). 던지면 이 뒷일만 되돌아간다. */
  onDead?(client: PoolClient, job: Job, now: Date): Promise<void>;
}

export type JobHandlers = Partial<Record<JobKind, JobHandler>>;

export interface DrainOptions {
  handlers: JobHandlers;
  /** 시계. 부르는 쪽이 준다. */
  now: () => Date;
  /** 이 시간이 지나면 새 작업을 집지 않는다. */
  budgetMs?: number;
  maxJobs?: number;
}

export interface DrainResult {
  done: number;
  retried: number;
  dead: number;
  /** 일을 마쳤지만 그사이 임대를 잃어 결과를 버린 건수 */
  lost: number;
  /** 임대가 끝나 줄로 돌려놓은 건수 */
  reclaimed: number;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isRetryable = (err: unknown) => (err as { retryable?: unknown } | null)?.retryable !== false;

/**
 * 줄을 굴린다. 한 건씩 집어 처리하고, 시간 예산이나 최대 건수에 닿으면 멈춘다.
 * 처리기가 있는 종류만 집는다.
 */
export async function drain(options: DrainOptions): Promise<DrainResult> {
  const { handlers, now } = options;
  const budgetMs = options.budgetMs ?? QUEUE.drainBudgetMs;
  const maxJobs = options.maxJobs ?? QUEUE.drainMaxJobs;
  const kinds = (Object.keys(handlers) as JobKind[]).filter((k) => handlers[k]);
  const result: DrainResult = { done: 0, retried: 0, dead: 0, lost: 0, reclaimed: 0 };
  if (kinds.length === 0) return result;

  const startedAt = now().getTime();
  let picked = 0;

  /**
   * dead 가 된 작업의 뒷일(초안을 FAILED 로)을 한다. 뒷일이 던져도 dead 표시와 다른 작업은 그대로 간다.
   * 뒷일만 되돌리고(SAVEPOINT) 까닭을 last_error 에 적는다. 하나가 던진다고 줄 전체가 멈추면 안 된다.
   */
  const afterDead = async (client: PoolClient, job: Job, at: Date) => {
    const onDead = handlers[job.kind]?.onDead;
    if (!onDead) return;
    await client.query('SAVEPOINT on_dead');
    try {
      await onDead(client, job, at);
      await client.query('RELEASE SAVEPOINT on_dead');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT on_dead');
      await client.query('UPDATE jobs SET last_error = $2 WHERE id = $1', [
        job.id,
        `dead 뒷일 실패: ${errorMessage(err)}`.slice(0, LAST_ERROR_MAX),
      ]);
      console.error(`[queue] 작업 ${job.id}(${job.kind}) dead 뒷일 실패:`, errorMessage(err));
    }
  };

  const failJob = async (job: Job, err: unknown) => {
    const outcome = await withTx(async (client) => {
      const at = now();
      const o = await fail(client, job, errorMessage(err), at, { retryable: isRetryable(err) });
      if (o === 'dead') await afterDead(client, job, at);
      return o;
    });
    if (outcome === 'retry') result.retried += 1;
    else if (outcome === 'dead') result.dead += 1;
    else result.lost += 1;
  };

  while (picked < maxJobs && now().getTime() - startedAt < budgetMs) {
    // 회수: 죽은 작업자가 붙잡고 있던 것을 돌려놓는다.
    const reclaimed = await withTx(async (client) => {
      const at = now();
      const r = await reclaimExpired(client, at);
      for (const job of r.dead) await afterDead(client, job, at);
      return r;
    });
    result.reclaimed += reclaimed.requeued.length;
    result.dead += reclaimed.dead.length;

    // 집기: 짧게.
    const [job] = await claim(getPool(), now(), 1, kinds);
    if (!job) break;
    picked += 1;
    const handler = handlers[job.kind];
    if (!handler) continue;

    // 일: 트랜잭션 밖.
    let save: SaveFn | void;
    try {
      save = await handler.work(job);
    } catch (err) {
      await failJob(job, err);
      continue;
    }

    // 저장: 짧게. done 표시와 결과 저장이 한 트랜잭션이다.
    try {
      const kept = await withTx(async (client) => {
        if (!(await complete(client, job))) return false;
        if (save) await save(client, now());
        return true;
      });
      if (kept) result.done += 1;
      else result.lost += 1;
    } catch (err) {
      await failJob(job, err);
    }
  }
  return result;
}
