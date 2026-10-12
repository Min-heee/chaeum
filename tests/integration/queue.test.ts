// 작업 줄: 중복 없이 넣기, 집기, 임대 만료, 재시도, dead. 시계는 인자로 돌린다.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QUEUE } from '@/contract/api';
import { closePool, getPool } from '@/server/db';
import { intakeOne } from '@/server/intake';
import { claim, complete, drain, enqueue, fail, getJob, queueDepth, reclaimExpired, requeue, retryDelayMs, type Job, type JobHandler } from '@/server/queue';
import { listEvents } from '@/server/repos/draft-events';
import { getDraft } from '@/server/repos/drafts';
import { failDraftIfProcessing, reprocessDraft } from '@/server/review';
import { at, dropWorkspaces, newWorkspace, sampleText, T0 } from './helpers';

const pool = () => getPool();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 손으로 돌리는 시계. */
function clock(startMs = 0) {
  let ms = startMs;
  return { now: () => at(ms), set: (v: number) => (ms = v), add: (v: number) => (ms += v) };
}

async function seedJobs(n: number, runAt: Date = T0): Promise<void> {
  for (let i = 1; i <= n; i += 1) await enqueue(pool(), 'extract', i, runAt);
}

beforeEach(async () => {
  await pool().query('TRUNCATE jobs RESTART IDENTITY');
});

afterAll(async () => {
  await dropWorkspaces();
  await closePool();
});

describe('넣기', () => {
  it('같은 일은 두 번 들어가지 않는다. 종류가 다르면 다른 일이다', async () => {
    const first = await enqueue(pool(), 'extract', 7, T0);
    const second = await enqueue(pool(), 'extract', 7, at(5000));
    const other = await enqueue(pool(), 'content', 7, T0);

    expect(first.created).toBe(true);
    expect(second).toEqual({ jobId: first.jobId, created: false });
    expect(other.created).toBe(true);
    expect(await queueDepth(pool())).toEqual({ queued: 2, running: 0, done: 0, dead: 0 });
    expect((await getJob(pool(), 'extract', 7))?.runAt).toEqual(T0);
  });

  it('다시 줄 세우기는 끝났거나 죽은 작업만 처음으로 돌린다', async () => {
    await enqueue(pool(), 'extract', 1, T0);
    expect(await requeue(pool(), 'extract', 1, at(1000))).toBe(false);

    const [job] = await claim(pool(), T0, 1);
    expect(await requeue(pool(), 'extract', 1, at(1000))).toBe(false);
    await complete(pool(), job as Job);
    expect(await requeue(pool(), 'extract', 1, at(1000))).toBe(true);
    expect(await getJob(pool(), 'extract', 1)).toMatchObject({ status: 'queued', attempts: 0, runAt: at(1000) });

    expect(await requeue(pool(), 'extract', 2, T0)).toBe(true); // 없으면 새로 넣는다
  });
});

describe('집기', () => {
  it('차례가 된 것만, 오래된 것부터, 달라는 만큼만 집고 60초 임대를 건다', async () => {
    await enqueue(pool(), 'extract', 1, at(3000));
    await enqueue(pool(), 'extract', 2, at(1000));
    await enqueue(pool(), 'extract', 3, at(2000));
    await enqueue(pool(), 'extract', 4, at(9000));

    expect(await claim(pool(), at(999), 10)).toEqual([]);
    const got = await claim(pool(), at(3000), 2);
    expect(got.map((j) => j.refId)).toEqual([2, 3]);
    expect(got[0]).toMatchObject({ status: 'running', attempts: 1, leasedUntil: at(3000 + QUEUE.leaseMs) });
    expect((await claim(pool(), at(3000), 10)).map((j) => j.refId)).toEqual([1]);
  });

  it('종류를 주면 그 종류만 집는다', async () => {
    await enqueue(pool(), 'extract', 1, T0);
    await enqueue(pool(), 'content', 1, T0);
    expect(await claim(pool(), T0, 10, [])).toEqual([]);
    expect((await claim(pool(), T0, 10, ['content'])).map((j) => j.kind)).toEqual(['content']);
  });

  it('넷이 동시에 10건씩 집어도 20건이 겹치지 않게 나뉜다', async () => {
    await seedJobs(20);
    const batches = await Promise.all([1, 2, 3, 4].map(() => claim(pool(), T0, 10)));
    const ids = batches.flat().map((j) => j.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });
});

describe('작업자 둘', () => {
  it('둘이 동시에 20건을 굴려도 두 번 처리되는 작업이 없다', async () => {
    await seedJobs(20);
    const worked: number[] = [];
    const saved: number[] = [];
    const handler: JobHandler = {
      work: async (job) => {
        await sleep(3);
        worked.push(job.refId);
        return async () => {
          saved.push(job.refId);
        };
      },
    };
    const run = () => drain({ handlers: { extract: handler }, now: () => T0, maxJobs: 20, budgetMs: 60_000 });
    const [a, b] = await Promise.all([run(), run()]);

    expect(a.done + b.done).toBe(20);
    expect(worked).toHaveLength(20);
    expect(new Set(worked).size).toBe(20);
    expect([...saved].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await queueDepth(pool())).toEqual({ queued: 0, running: 0, done: 20, dead: 0 });
    const { rows } = await pool().query<{ attempts: number }>('SELECT DISTINCT attempts FROM jobs');
    expect(rows).toEqual([{ attempts: 1 }]);
  });
});

describe('임대', () => {
  it('임대가 끝난 작업을 다른 작업자가 가져가 끝낸다. 늦게 온 첫 작업자의 끝내기는 먹지 않는다', async () => {
    await enqueue(pool(), 'extract', 1, T0);
    const [mineA] = await claim(pool(), T0, 1);

    // 임대 중(60초까지)에는 아무도 못 가져간다.
    expect((await reclaimExpired(pool(), at(QUEUE.leaseMs))).requeued).toEqual([]);
    expect(await claim(pool(), at(QUEUE.leaseMs), 1)).toEqual([]);

    // 60초가 넘으면 회수되고 다른 작업자가 집는다.
    const later = at(QUEUE.leaseMs + 1);
    expect((await reclaimExpired(pool(), later)).requeued.map((j) => j.refId)).toEqual([1]);
    const [mineB] = await claim(pool(), later, 1);
    expect(mineB).toMatchObject({ id: mineA?.id, attempts: 2 });

    expect(await complete(pool(), mineA as Job)).toBe(false);
    expect(await fail(pool(), mineA as Job, '늦게 옴', later)).toBe('lost');
    expect(await getJob(pool(), 'extract', 1)).toMatchObject({ status: 'running', attempts: 2 });

    expect(await complete(pool(), mineB as Job)).toBe(true);
    expect(await getJob(pool(), 'extract', 1)).toMatchObject({ status: 'done', leasedUntil: null });
  });

  it('굴리는 중에 임대를 잃으면 그 작업자의 결과는 저장되지 않는다', async () => {
    await enqueue(pool(), 'extract', 1, T0);
    const time = clock();
    const saved: string[] = [];

    const second: JobHandler = { work: async () => async () => void saved.push('둘째') };
    const first: JobHandler = {
      work: async () => {
        // 첫 작업자가 일하는 동안 61초가 흐르고, 둘째 작업자가 줄을 굴린다.
        time.add(QUEUE.leaseMs + 1000);
        const other = await drain({ handlers: { extract: second }, now: time.now, maxJobs: 5 });
        expect(other).toMatchObject({ reclaimed: 1, done: 1 });
        return async () => void saved.push('첫째');
      },
    };

    const mine = await drain({ handlers: { extract: first }, now: time.now, maxJobs: 1 });
    expect(mine).toMatchObject({ done: 0, lost: 1 });
    expect(saved).toEqual(['둘째']);
    expect(await getJob(pool(), 'extract', 1)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('세 번 집히고도 임대만 끝나는 작업은 줄로 돌아가지 않고 dead 가 된다', async () => {
    await enqueue(pool(), 'extract', 1, T0);
    const time = clock();
    for (let i = 0; i < QUEUE.maxAttempts; i += 1) {
      await reclaimExpired(pool(), time.now());
      expect(await claim(pool(), time.now(), 1)).toHaveLength(1);
      time.add(QUEUE.leaseMs + 1);
    }
    const died: number[] = [];
    const result = await drain({
      handlers: { extract: { work: async () => undefined, onDead: async (_c, job) => void died.push(job.refId) } },
      now: time.now,
    });
    expect(result).toMatchObject({ dead: 1, done: 0, reclaimed: 0 });
    expect(died).toEqual([1]);
    expect(await getJob(pool(), 'extract', 1)).toMatchObject({ status: 'dead', attempts: 3 });
  });
});

describe('늦게 온 끝내기', () => {
  it('회수로 dead 가 된 작업에 늦게 온 끝내기는 먹지 않는다', async () => {
    await enqueue(pool(), 'extract', 1, T0);
    let mine: Job | undefined;
    for (let i = 0; i < QUEUE.maxAttempts; i += 1) {
      const t = at(i * (QUEUE.leaseMs + 1000));
      await reclaimExpired(pool(), t);
      [mine] = await claim(pool(), t, 1);
    }
    const later = at(QUEUE.maxAttempts * (QUEUE.leaseMs + 1000));
    expect((await reclaimExpired(pool(), later)).dead).toHaveLength(1);

    expect(await complete(pool(), mine as Job)).toBe(false);
    expect(await fail(pool(), mine as Job, '늦은 실패', later)).toBe('lost');
    expect(await getJob(pool(), 'extract', 1)).toMatchObject({ status: 'dead' });
  });

  it('다시 줄 세운 뒤 새로 집힌 작업을 옛 임대의 끝내기가 가로채지 못한다', async () => {
    await enqueue(pool(), 'extract', 1, T0);
    const [a] = await claim(pool(), T0, 1);
    const t1 = at(QUEUE.leaseMs + 1000);
    await reclaimExpired(pool(), t1);
    const [b] = await claim(pool(), t1, 1);
    expect(await complete(pool(), b as Job)).toBe(true);

    // 반려 뒤 다시 돌리기: attempts 가 0 으로 돌아가 새 임대도 attempts 1 이다.
    expect(await requeue(pool(), 'extract', 1, at(QUEUE.leaseMs + 5000))).toBe(true);
    const [c] = await claim(pool(), at(QUEUE.leaseMs + 6000), 1);
    expect([a?.attempts, c?.attempts]).toEqual([1, 1]);

    expect(await complete(pool(), a as Job)).toBe(false);
    expect(await getJob(pool(), 'extract', 1)).toMatchObject({ status: 'running' });
    expect(await complete(pool(), c as Job)).toBe(true);
  });
});

describe('dead 뒷일이 던질 때', () => {
  const throwing: JobHandler = {
    work: async () => undefined,
    onDead: async () => {
      throw new Error('초안 상태를 못 바꿨다');
    },
  };

  it('회수에서 뒷일이 던져도 줄은 멈추지 않고 다음 작업을 처리한다', async () => {
    await enqueue(pool(), 'extract', 1, T0);
    for (let i = 0; i < QUEUE.maxAttempts; i += 1) {
      const t = at(i * (QUEUE.leaseMs + 1000));
      await reclaimExpired(pool(), t);
      await claim(pool(), t, 1);
    }
    const later = QUEUE.maxAttempts * (QUEUE.leaseMs + 1000);
    await enqueue(pool(), 'extract', 2, at(later));

    const c = clock(later);
    const result = await drain({ handlers: { extract: throwing }, now: c.now });
    expect(result).toMatchObject({ done: 1, dead: 1 });
    expect(await getJob(pool(), 'extract', 2)).toMatchObject({ status: 'done' });
    const dead = await getJob(pool(), 'extract', 1);
    expect(dead?.status).toBe('dead');
    expect(dead?.lastError).toContain('dead 뒷일 실패');
  });

  it('일이 실패해 dead 가 될 때 뒷일이 던져도 dead 표시는 남는다', async () => {
    await enqueue(pool(), 'extract', 1, T0);
    await enqueue(pool(), 'extract', 2, T0);
    const handler: JobHandler = {
      ...throwing,
      work: async (job) => {
        if (job.refId === 1) throw Object.assign(new Error('고칠 수 없는 오류'), { retryable: false });
      },
    };
    const result = await drain({ handlers: { extract: handler }, now: clock().now });
    expect(result).toMatchObject({ done: 1, dead: 1 });
    expect(await getJob(pool(), 'extract', 1)).toMatchObject({ status: 'dead', lastError: expect.stringContaining('dead 뒷일 실패') });
  });
});

describe('실패와 재시도', () => {
  it('기다리는 시간은 5초, 10초다', () => {
    expect([1, 2].map(retryDelayMs)).toEqual([5000, 10000]);
  });

  it('세 번 실패하면 dead 가 되고 초안은 처리 실패가 된다. 그 전에는 5초, 10초 뒤에만 다시 집힌다', async () => {
    const ws = await newWorkspace();
    const { draftId } = await intakeOne(sampleText(), { workspaceId: ws, now: T0 });
    const time = clock();
    let tries = 0;
    const handlers = {
      extract: {
        work: async () => {
          tries += 1;
          throw new Error(`잠깐의 오류 ${tries}`);
        },
        onDead: async (client, job, now) => void (await failDraftIfProcessing(client, job.refId, now)),
      } satisfies JobHandler,
    };
    const run = () => drain({ handlers, now: time.now });

    expect(await run()).toMatchObject({ retried: 1, dead: 0 });
    expect(await getJob(pool(), 'extract', draftId)).toMatchObject({ status: 'queued', attempts: 1, runAt: at(5000), lastError: '잠깐의 오류 1' });

    time.set(4999);
    expect(await run()).toMatchObject({ retried: 0, dead: 0 });
    time.set(5000);
    expect(await run()).toMatchObject({ retried: 1 });
    expect(await getJob(pool(), 'extract', draftId)).toMatchObject({ attempts: 2, runAt: at(15_000) });
    expect(await getDraft(pool(), ws, draftId)).toMatchObject({ status: 'PROCESSING' });

    time.set(14_999);
    expect(await run()).toMatchObject({ retried: 0, dead: 0 });
    time.set(15_000);
    expect(await run()).toMatchObject({ retried: 0, dead: 1 });
    expect(tries).toBe(3);
    expect(await getJob(pool(), 'extract', draftId)).toMatchObject({ status: 'dead', attempts: 3, lastError: '잠깐의 오류 3' });

    const failed = await getDraft(pool(), ws, draftId);
    expect(failed).toMatchObject({ status: 'FAILED', version: 2 });
    expect((await listEvents(pool(), draftId)).at(-1)).toMatchObject({ actor: 'system', from: 'PROCESSING', to: 'FAILED', reasonCode: 'JOB_DEAD' });

    // 죽은 작업은 다시 집히지 않는다. 사람이 다시 돌리면 처음부터 선다.
    time.set(999_000);
    expect(await run()).toMatchObject({ retried: 0, dead: 0, done: 0 });
    await reprocessDraft({ workspaceId: ws, draftId, version: 2, now: time.now() });
    expect(await getJob(pool(), 'extract', draftId)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('다시 해도 소용없는 오류(retryable: false)는 바로 dead 다', async () => {
    await enqueue(pool(), 'extract', 1, T0);
    const work = async () => {
      throw Object.assign(new Error('고칠 수 없음'), { retryable: false });
    };
    expect(await drain({ handlers: { extract: { work } }, now: () => T0 })).toMatchObject({ dead: 1, retried: 0 });
    expect(await getJob(pool(), 'extract', 1)).toMatchObject({ status: 'dead', attempts: 1 });
  });

  it('저장이 실패하면 done 표시도 함께 되돌아가고 작업은 다시 줄에 선다', async () => {
    await enqueue(pool(), 'extract', 1, T0);
    const work = async () => async () => {
      throw new Error('저장 실패');
    };
    expect(await drain({ handlers: { extract: { work } }, now: () => T0 })).toMatchObject({ done: 0, retried: 1 });
    expect(await getJob(pool(), 'extract', 1)).toMatchObject({ status: 'queued', attempts: 1, lastError: '저장 실패' });
  });
});

describe('굴리기의 한도', () => {
  it('최대 건수에서 멈춘다', async () => {
    await seedJobs(8);
    const result = await drain({ handlers: { extract: { work: async () => undefined } }, now: () => T0, maxJobs: 5 });
    expect(result.done).toBe(5);
    expect(await queueDepth(pool())).toMatchObject({ queued: 3, done: 5 });
  });

  it('시간 예산이 지나면 새 작업을 집지 않는다', async () => {
    await seedJobs(5);
    const time = clock();
    const work = async () => void time.add(4000);
    const result = await drain({ handlers: { extract: { work } }, now: time.now, budgetMs: 6000, maxJobs: 5 });
    expect(result.done).toBe(2);
    expect(await queueDepth(pool())).toMatchObject({ queued: 3, running: 0 });
  });

  it('처리기가 없는 종류는 집지 않는다', async () => {
    await enqueue(pool(), 'extract', 1, T0);
    await enqueue(pool(), 'content', 1, T0);
    expect(await drain({ handlers: {}, now: () => T0 })).toMatchObject({ done: 0 });
    expect(await drain({ handlers: { content: { work: async () => undefined } }, now: () => T0 })).toMatchObject({ done: 1 });
    expect(await getJob(pool(), 'extract', 1)).toMatchObject({ status: 'queued', attempts: 0 });
  });
});
