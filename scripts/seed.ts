// 씨앗 심기. 두 번 돌려도 같은 결과다.
//
//   npm run db:seed
//   npm run db:seed -- --reset   본보기 공간의 보기 글 초안을 지우고 다시 만든다(녹화본을 새로 받은 뒤에 쓴다)
//
//  1. 읽기 전용 본보기 공간을 만든다(있으면 그대로). 용어 사전의 공용 줄(data/seed/glossary.json)을 승인 상태로 싣는다.
//  2. 녹화본(data/recordings/*.jsonl)을 장부(llm_calls)에 심는다. 같은 키의 녹화가 이미 있으면 건너뛴다.
//  3. 보기 글(data/seed/samples.json)을 본보기 공간에 접수하고, 녹화본으로 초안까지 만든다.
//     녹화가 없는 글은 규칙만으로 뽑히고 그렇게 표시된다. 여기서는 실제 호출을 하지 않는다(돈이 들지 않는다).
//  4. 보기 글 가운데 일곱(DEMO_APPROVED)은 씨앗이 운영자 자리에서 승인까지 해서 본보기 상품으로 둔다.
//     딸린 도구(점검·견적·시안 검사·달력)가 본보기 공간만으로 무엇인가 보여 주게 하려는 것이다. 글은 녹화본으로 만든다.
//  5. 공공 자료의 작은 본보기 묶음(data/seed/collected-sample.json)을 본보기 공간의 모은 줄로 싣는다.
// 평가 결과(eval_runs·eval_results)는 평가 실행(npm run eval)이 같은 DB 에 직접 쓴다. 여기서는 건드리지 않는다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PUBLIC_WORKSPACE_ID } from '../src/contract/api';
import type { LlmRouter } from '../src/contract/pipeline-api';
import { parseRecordingLines } from '../src/llm/stores';
import { closePool, getPool, withTx } from '../src/server/db';
import { contentApi } from '../src/server/content-api';
import { contentInputOf } from '../src/server/content-input';
import { seedCollectedSample } from '../src/server/imports';
import { saveExtraction } from '../src/server/job-handlers';
import { prepareText } from '../src/server/limits';
import { createLlmRouter } from '../src/server/llm-router';
import { createContentStep } from '../src/server/pipeline/content';
import { extract } from '../src/server/pipeline/extract';
import { getDraftById, listFields, transitionDraft } from '../src/server/repos/drafts';
import { seedGlossaryTerms } from '../src/server/repos/glossary-terms';
import { approvedGlossary } from '../src/server/repos/glossary-terms';
import { PgLlmCallStore } from '../src/server/repos/llm-calls';
import { buildProduct, getProductById, insertProduct, ProductInvalid, saveProductTexts } from '../src/server/repos/products';
import { receiveDoc } from '../src/server/repos/source-docs';
import { seedSamples } from '../src/server/samples';
import { ensurePublicWorkspace } from '../src/server/workspace';

const RECORDINGS_DIR = path.join('data', 'recordings');

/**
 * 씨앗이 승인까지 해 두는 보기 글. 상품이 될 수 있는 여덟 가운데 지시문이 섞인 글(sample-08)은 사람이 볼 것으로 남긴다.
 * 값이 빠진 글 둘과 등록 대상이 아닌 글 둘도 검수함에 그대로 남는다.
 */
const DEMO_APPROVED = ['sample-01', 'sample-02', 'sample-03', 'sample-05', 'sample-09', 'sample-10', 'sample-11'];

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

/**
 * 본보기 초안 하나를 승인해 상품으로 만들고 글을 붙인다. 이미 되어 있으면 그대로 둔다.
 * 본보기 공간은 방문자에게 읽기 전용이라 검수 API 가 아니라 저장 함수로 직접 쓴다. 변경 기록에는 운영자의 승인으로 남는다.
 */
async function approveForDemo(draftId: number, router: LlmRouter, now: Date): Promise<'made' | 'kept' | string> {
  const pool = getPool();
  const draft = await getDraftById(pool, draftId);
  if (!draft) return '초안 없음';
  let productId: number;
  let made = false;
  if (draft.status === 'APPROVED') {
    const found = await pool.query<{ id: string }>('SELECT id FROM products WHERE draft_id = $1', [draftId]);
    if (!found.rows[0]) return '승인됐는데 상품이 없음';
    productId = Number(found.rows[0].id);
  } else if (draft.status === 'READY' || draft.status === 'NEEDS_REVIEW') {
    try {
      productId = await withTx(async (client) => {
        const approved = await transitionDraft(client, {
          workspaceId: PUBLIC_WORKSPACE_ID, draftId, to: 'APPROVED', expectedVersion: draft.version, actor: 'admin', now,
        });
        return insertProduct(client, PUBLIC_WORKSPACE_ID, draftId, buildProduct(approved.type, approved.subtype, await listFields(client, draftId)), now);
      });
      made = true;
    } catch (err) {
      if (err instanceof ProductInvalid) return `상품이 될 수 없음: ${err.issues.join(' ')}`;
      throw err;
    }
  } else {
    return `승인할 수 없는 상태(${draft.status})`;
  }

  // 글. 녹화본이 있으면 그것으로, 없으면 틀 문장으로 만들고 그렇게 표시된다. 이미 있으면 건드리지 않는다.
  const has = await pool.query('SELECT 1 FROM product_texts WHERE product_id = $1 LIMIT 1', [productId]);
  if ((has.rowCount ?? 0) === 0 && contentApi) {
    const product = await getProductById(pool, productId);
    if (product) {
      const glossary = await approvedGlossary(pool, PUBLIC_WORKSPACE_ID);
      // 마지막 시도로 부른다. 녹화가 없거나 어긋나도 기다렸다 다시 하지 않고 틀 문장으로 내려간다.
      const generated = await createContentStep(contentApi)(
        { generate: contentInputOf(product, glossary, contentApi.pickGlossary), attempt: 3, now },
        router,
      );
      await saveProductTexts(
        pool,
        productId,
        generated.texts.map((t) => ({ field: t.field, lang: t.lang, text: t.text, source: t.source, status: t.status, failCodes: t.failCodes })),
      );
    }
  }
  return made ? 'made' : 'kept';
}

async function main() {
  const now = new Date();
  await ensurePublicWorkspace(getPool(), now);

  // 용어 사전의 공용 줄. 씨앗 파일(data/seed/glossary.json)을 승인 상태로 싣는다.
  const terms = await seedGlossaryTerms(getPool(), now);
  console.log(`[seed] 용어 사전(공용 줄): 새로 실음 ${terms.added} · 이미 있음 ${terms.kept}`);

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
  const draftOf = new Map<string, number>();
  for (const sample of seedSamples()) {
    const { clean, hash } = prepareText(sample.text);
    // 본보기 공간은 방문자에게 읽기 전용이다. 씨앗만 저장 함수로 직접 쓴다.
    const doc = await withTx((client) => receiveDoc(client, { workspaceId: PUBLIC_WORKSPACE_ID, clean, hash, now }));
    draftOf.set(sample.id, doc.draftId);
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

  // 본보기 상품. 씨앗이 운영자 자리에서 승인한다.
  const approved = { made: 0, kept: 0, skipped: 0 };
  for (const id of DEMO_APPROVED) {
    const draftId = draftOf.get(id);
    const outcome = draftId === undefined ? '보기 글 없음' : await approveForDemo(draftId, router, now);
    if (outcome === 'made') approved.made += 1;
    else if (outcome === 'kept') approved.kept += 1;
    else {
      approved.skipped += 1;
      console.log(`[seed] ${id} 는 본보기 상품으로 두지 못했다: ${outcome}`);
    }
  }
  console.log(`[seed] 본보기 상품: 새로 승인 ${approved.made} · 이미 있음 ${approved.kept} · 못 함 ${approved.skipped}`);

  // 공공 자료의 본보기 묶음.
  const collected = await seedCollectedSample(getPool(), now);
  console.log(`[seed] 모은 줄(본보기 묶음): 새로 실음 ${collected.added} · 이미 있음 ${collected.kept}`);
}

main()
  .catch((err) => {
    console.error('[seed]', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
