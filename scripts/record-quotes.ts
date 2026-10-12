// 견적 보기 문의의 녹화. 보기 문의 20건(data/seed/quote-samples.json)을 본보기 공간의 상품으로 끝까지 돌려,
// 답을 data/recordings/quote.jsonl 에 남긴다. 서버의 견적 만들기(createQuote)를 그대로 부르므로 요청이 서버와 글자 하나까지 같다.
// 돈이 드는 명령이다. 이미 녹화가 있는 요청은 다시 부르지 않는다.
//
//   npx tsx --env-file-if-exists=.env.local scripts/record-quotes.ts --dry-run
//   npx tsx --env-file-if-exists=.env.local scripts/record-quotes.ts --max-calls 40 --max-usd 0.05
//
// 먼저 npm run db:seed 로 본보기 상품이 있어야 한다(DATABASE_URL 의 DB 에서 읽는다). 녹화한 뒤에는 db:seed 를 다시 돌려 장부에 심는다.
// 오늘은 보기 문의의 기준일(SAMPLE_TODAY)로 놓는다. 견적은 임시 공간에 만들고 끝나면 그 공간을 지운다. 본보기 공간에는 쓰지 않는다.
import path from 'node:path';
import { DEFAULT_LLM_MODEL, isLlmUnavailable, type LlmCallRecord, type LlmCallStore, type LlmProvider, type LlmRequest, type LlmResult } from '../src/contract/llm-types';
import type { LlmRouter } from '../src/contract/pipeline-api';
import { costUsd, createProvider, JsonlCallStore } from '../src/llm';
import { closePool, getPool } from '../src/server/db';
import { isAppError } from '../src/server/errors';
import { createQuote } from '../src/server/quotes';
import { quoteSamples, SAMPLE_TODAY } from '../src/tools/quote';

const RECORDINGS_DIR = path.join('data', 'recordings');
const RECORDING_FILE = 'quote.jsonl';

function argNumber(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  const n = i >= 0 ? Number(process.argv[i + 1]) : fallback;
  if (!(n >= 0)) throw new Error(`${name} 은 0 이상의 수여야 한다`);
  return n;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const maxCalls = argNumber('--max-calls', 40);
  const maxUsd = argNumber('--max-usd', 0.05);
  const model = process.env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;
  if (model !== DEFAULT_LLM_MODEL) throw new Error(`녹화는 가장 작은 모델(${DEFAULT_LLM_MODEL})로만 받는다. 지금 모델: ${model}`);
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  if (!dryRun && !apiKey) throw new Error('API 키가 없다. .env.local 에 직접 넣는다(값은 어디에도 찍지 않는다)');

  const files = new JsonlCallStore(RECORDINGS_DIR, RECORDING_FILE);
  const writer: LlmCallStore = { find: (key) => files.find(key), save: (record: LlmCallRecord) => files.save({ ...record, isRecorded: true }) };
  const replay = createProvider({ kind: 'replay', model, store: files });
  const real = createProvider({ kind: 'anthropic', model, apiKey, store: writer });
  let calls = 0;
  let spent = 0;
  let missing = 0;
  /** 지금 문의에서 답장 요청을 몇 번 골랐나(2면 첫 답이 글 검사에 걸려 다시 부른 것) */
  let replyPicks = 0;
  /** 실제 호출. 쓴 돈을 센다(실패한 호출도 토큰은 나간다). */
  const live: LlmProvider = {
    name: real.name,
    model: real.model,
    async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      try {
        const result = await real.complete(req);
        spent += costUsd(model, result.usage);
        return result;
      } catch (err) {
        if (isLlmUnavailable(err) && err.usage) spent += costUsd(model, err.usage);
        throw err;
      }
    },
  };
  /** 길 고르기: 녹화가 있으면 그것, 없으면 상한 안에서 실제 호출, 그 밖에는 부르지 않는다. */
  const router: LlmRouter = {
    model,
    async pick({ cacheKey, task }) {
      if (task === 'quote_reply') replyPicks += 1;
      if ((await files.find(cacheKey)) !== null) return { route: 'replay', provider: replay };
      missing += 1;
      if (dryRun || calls >= maxCalls || spent >= maxUsd) return { route: 'rules', provider: null, cause: 'off' };
      calls += 1;
      return { route: 'anthropic', provider: live };
    },
  };

  console.log(`[견적 녹화] 모델 ${model} · 오늘 ${SAMPLE_TODAY} · 상한 ${maxCalls}번 · $${maxUsd}${dryRun ? ' · 부르지 않고 세기만 한다' : ''}`);
  let workspace: string | null = null;
  const tally = { quotes: 0, noExtract: 0, llmOk: 0, llmFlagged: 0, template: 0, noCandidate: 0, asked: 0, firstPass: 0, retried: 0 };
  try {
    for (const sample of quoteSamples()) {
      replyPicks = 0;
      try {
        const quote = await createQuote(workspace, { text: sample.text, today: SAMPLE_TODAY, catalog: 'public' }, new Date(), router);
        workspace = quote.workspace;
        tally.quotes += 1;
        const picked = quote.candidates.find((c) => c.productId === quote.selectedProductId);
        // 답장 모델을 한 번도 부르지 않고 틀 문장이 나왔으면 되묻는 글이다(종류·갈래·지역이 하나도 없는 문의. 상품을 고르지 않는다).
        const askedBack = replyPicks === 0 && quote.reply.source === 'template' && quote.llm.replySkipCause === null;
        if (askedBack) tally.asked += 1;
        if (quote.candidateCount === 0) tally.noCandidate += 1;
        if (replyPicks >= 2) tally.retried += 1;
        else if (quote.reply.source === 'llm') tally.firstPass += 1;
        if (quote.reply.source === 'template') tally.template += 1;
        else if (quote.reply.status === 'ok') tally.llmOk += 1;
        else tally.llmFlagged += 1;
        const why = askedBack ? '(되묻는 글. 모델을 부르지 않음)' : quote.llm.replySkipCause ? `(답 없음: ${quote.llm.replySkipCause})` : '(모델의 글이 글 검사에 걸림)';
        const how = quote.reply.source === 'llm' ? '모델의 글' : `틀 문장${why}`;
        console.log(`  ${sample.id}: 답장 요청 ${replyPicks}번 · 맞는 상품 ${quote.candidateCount}/${quote.productCount} · 고른 상품 ${picked ? picked.name : '없음'} · 답장 ${how}${quote.reply.failCodes.length > 0 ? ` · 걸린 검사 ${quote.reply.failCodes.join(', ')}` : ''}`);
        console.log(quote.reply.text.replace(/^/gm, '      | '));
      } catch (err) {
        if (!isAppError(err)) throw err;
        tally.noExtract += 1;
        console.log(`  ${sample.id}: 견적을 만들지 못함(${err.code})`);
      }
    }
  } finally {
    // 임시 공간을 지운다(견적이 함께 지워진다).
    if (workspace) await getPool().query('DELETE FROM workspaces WHERE id = $1', [workspace]);
  }
  console.log(`[견적 녹화] 견적 ${tally.quotes}건(조건을 못 뽑은 문의 ${tally.noExtract}) · 맞는 상품이 없던 문의 ${tally.noCandidate} · 무엇을 찾는지 몰라 되물은 문의 ${tally.asked}`);
  console.log(`  답장: 첫 답이 글 검사를 통과 ${tally.firstPass} · 걸려서 다시 부른 문의 ${tally.retried}`);
  console.log(`  답장(끝): 모델의 글이 글 검사를 통과 ${tally.llmOk} · 모델의 글인데 걸림 ${tally.llmFlagged} · 틀 문장 ${tally.template}`);
  console.log(`  녹화가 없던 요청 ${missing}건 · 이번에 실제로 부른 호출 ${calls}번 · 쓴 돈 $${spent.toFixed(4)}`);
}

main()
  .catch((err) => {
    console.error('[견적 녹화]', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
