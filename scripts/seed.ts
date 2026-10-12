// 씨앗 심기. 두 번 돌려도 같은 결과다.
//
//   npm run db:seed
//   npm run db:seed -- --reset   본보기 공간의 보기 글 초안을 지우고 다시 만든다(녹화본을 새로 받은 뒤에 쓴다)
//
//  1. 읽기 전용 본보기 공간을 만든다(있으면 그대로).
//  2. 녹화본(data/recordings/*.jsonl)을 장부(llm_calls)에 심는다. 같은 키의 녹화가 이미 있으면 건너뛴다.
//  3. 보기 글(data/seed/samples.json)을 본보기 공간에 접수하고, 녹화본으로 초안까지 만든다.
//     녹화가 없는 글은 규칙만으로 뽑히고 그렇게 표시된다. 여기서는 실제 호출을 하지 않는다(돈이 들지 않는다).
// 평가 결과(eval_runs·eval_results)는 평가 실행(npm run eval)이 같은 DB 에 직접 쓴다. 여기서는 건드리지 않는다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PUBLIC_WORKSPACE_ID } from '../src/contract/api';
import { parseRecordingLines } from '../src/llm/stores';
import { closePool, getPool, withTx } from '../src/server/db';
import { saveExtraction } from '../src/server/job-handlers';
import { prepareText } from '../src/server/limits';
import { createLlmRouter } from '../src/server/llm-router';
import { extract } from '../src/server/pipeline/extract';
import { PgLlmCallStore } from '../src/server/repos/llm-calls';
import { receiveDoc } from '../src/server/repos/source-docs';
import { seedSamples } from '../src/server/samples';
import { ensurePublicWorkspace } from '../src/server/workspace';

const RECORDINGS_DIR = path.join('data', 'recordings');

/** 녹화본 파일들을 장부에 심는다. 심은 수와 건너뛴 수를 돌려준다. */
async function seedRecordings(): Promise<{ added: number; skipped: number }> {
  const pool = getPool();
  const store = new PgLlmCallStore();
  let added = 0;
  let skipped = 0;
  if (!existsSync(RECORDINGS_DIR)) return { added, skipped };
  for (const file of readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const record of parseRecordingLines(readFileSync(path.join(RECORDINGS_DIR, file), 'utf8'), file)) {
      // 시험용 구현이 적은 줄은 녹화가 아니다.
      if (record.provider === 'fake') continue;
      const has = await pool.query('SELECT 1 FROM llm_calls WHERE cache_key = $1 AND is_recorded LIMIT 1', [record.cacheKey]);
      if ((has.rowCount ?? 0) > 0) {
        skipped += 1;
        continue;
      }
      await store.save({ ...record, isRecorded: true });
      added += 1;
    }
  }
  return { added, skipped };
}

async function main() {
  const now = new Date();
  await ensurePublicWorkspace(getPool(), now);

  if (process.argv.includes('--reset')) {
    const pool = getPool();
    // 작업 줄은 공간에 묶여 있지 않아 먼저 지운다. 원문을 지우면 초안·칸·기록·상품이 함께 지워진다.
    await pool.query(
      `DELETE FROM jobs j
        WHERE (j.kind = 'extract' AND j.ref_id IN (SELECT id FROM drafts WHERE workspace_id = $1))
           OR (j.kind = 'content' AND j.ref_id IN (SELECT id FROM products WHERE workspace_id = $1))`,
      [PUBLIC_WORKSPACE_ID],
    );
    const gone = await pool.query('DELETE FROM source_docs WHERE workspace_id = $1', [PUBLIC_WORKSPACE_ID]);
    console.log(`[seed] 본보기 공간을 비웠다: 원문 ${gone.rowCount ?? 0}건`);
  }

  const recordings = await seedRecordings();
  console.log(`[seed] 녹화본: 심음 ${recordings.added} · 이미 있음 ${recordings.skipped}`);

  // 녹화 재생만 하는 길. 키가 있어도 여기서는 부르지 않는다.
  const router = createLlmRouter({ providerKind: 'replay', dailyCap: 0, model: process.env.LLM_MODEL });
  let made = 0;
  let kept = 0;
  const byRoute = { llm: 0, rules: 0 };
  for (const sample of seedSamples()) {
    const { clean, hash } = prepareText(sample.text);
    // 본보기 공간은 방문자에게 읽기 전용이다. 씨앗만 저장 함수로 직접 쓴다.
    const doc = await withTx((client) => receiveDoc(client, { workspaceId: PUBLIC_WORKSPACE_ID, clean, hash, now }));
    if (doc.duplicate && doc.status !== 'PROCESSING') {
      kept += 1;
      continue;
    }
    const outcome = await extract({ sourceText: clean, transcribed: false, attempt: 1, now }, router);
    await withTx(async (client) => {
      await saveExtraction(doc.draftId, outcome)(client, now);
      // 이 초안의 뽑기 작업은 여기서 끝냈다. 작업자가 다시 집지 않게 한다(집어도 두 번 쓰이지는 않는다).
      await client.query(`UPDATE jobs SET status = 'done', leased_until = NULL WHERE kind = 'extract' AND ref_id = $1 AND status = 'queued'`, [doc.draftId]);
    });
    byRoute[outcome.extractedBy] += 1;
    made += 1;
    console.log(`[seed] ${sample.id} → ${outcome.evaluation.route} (${outcome.extractedBy === 'llm' ? '녹화본' : `규칙만: ${outcome.skipCause}`})`);
  }
  console.log(`[seed] 보기 글: 새 초안 ${made}(녹화본 ${byRoute.llm} · 규칙만 ${byRoute.rules}) · 이미 있음 ${kept}`);
}

main()
  .catch((err) => {
    console.error('[seed]', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
