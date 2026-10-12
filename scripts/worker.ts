// 로컬 작업자. 1초마다 줄을 굴린다.
//
//   npm run worker             계속 돈다(Ctrl+C 로 멈춤. 하던 일은 마치고 멈춘다)
//   npm run worker -- --once   줄이 빌 때까지 한 번 굴리고 끝낸다
import { QUEUE } from '../src/contract/api';
import { closePool } from '../src/server/db';
import { jobHandlers } from '../src/server/job-handlers';
import { drain, type DrainResult } from '../src/server/queue';

const once = process.argv.includes('--once');
let stopping = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const didWork = (r: DrainResult) => r.done + r.retried + r.dead + r.lost + r.reclaimed > 0;

async function main() {
  if (Object.keys(jobHandlers).length === 0) {
    console.error('[worker] 처리기가 아직 없다. 작업은 줄에서 기다린다.');
    process.exitCode = 1;
    return;
  }
  console.log(`[worker] 시작${once ? ' (한 번만)' : ''}`);
  while (!stopping) {
    const r = await drain({ handlers: jobHandlers, now: () => new Date(), budgetMs: 30_000, maxJobs: 20 });
    if (didWork(r)) console.log(`[worker] 끝냄 ${r.done} · 다시 ${r.retried} · 죽음 ${r.dead} · 임대 잃음 ${r.lost} · 회수 ${r.reclaimed}`);
    if (once && !didWork(r)) break;
    if (!didWork(r)) await sleep(QUEUE.workerPollMs);
  }
  console.log('[worker] 멈춤');
}

process.on('SIGINT', () => (stopping = true));
process.on('SIGTERM', () => (stopping = true));

main()
  .catch((err) => {
    console.error('[worker]', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
