// 시연 녹화. 보기 글(data/seed/samples.json)을 실제로 한 번씩 불러 답을 data/recordings/samples.jsonl 에 남긴다.
// 돈이 드는 명령이다. 먼저 --dry-run 으로 건수와 어림 비용을 보고, 돌릴 때는 --max-usd 로 상한을 준다.
//
//   npm run record -- --dry-run                     무엇을 부를지와 어림 비용만 보여 준다(키 없이 된다)
//   npm run record -- --limit 3 --max-usd 0.05      녹화가 없는 보기 글을 앞에서부터 3건까지 부른다
//   npm run record -- --only sample-01,sample-04 --max-usd 0.02   고른 보기 글만
//   npm run record -- --with-content --max-usd 0.05 뽑기에 이어 글 만들기도 녹화한다(글 검사에 걸려 다시 한 요청까지)
//
// 이미 녹화가 있는 글은 건너뛴다(같은 글에 돈을 두 번 쓰지 않는다). 프롬프트나 모델을 바꾸면 키가 달라져 다시 부르게 된다.
// 녹화한 뒤에는 npm run db:seed 로 장부에 심는다.
import path from 'node:path';
import type { GenerateContentInput } from '../src/contract/content';
import { DEFAULT_LLM_MODEL, isLlmUnavailable, LlmUnavailable, type LlmCallRecord, type LlmCallStore, type LlmProvider, type LlmRequest, type LlmResult } from '../src/contract/llm-types';
import { evaluateDraft } from '../src/core';
import { buildExtractRequest, cacheKeyFor, costUsd, createProvider, JsonlCallStore, priceOf } from '../src/llm';
import { contentApi } from '../src/server/content-api';
import { contentInputOf } from '../src/server/content-input';
import { seedGlossary } from '../src/server/job-handlers';
import { cleanText } from '../src/server/limits';
import { buildProduct } from '../src/server/repos/products';
import { seedSamples } from '../src/server/samples';

export const RECORDINGS_DIR = path.join('data', 'recordings');
export const SAMPLE_RECORDING_FILE = 'samples.jsonl';

/** 호출 하나의 어림 토큰 수. 한글은 글자 하나가 토큰 하나를 넘기도 해서 글자 수를 그대로 쓴다. 답은 넉넉히 1,200 토큰. */
function estimateUsd(model: string, req: LlmRequest<unknown>): number {
  const inputTokens = req.system.length + JSON.stringify(req.input).length + 1500;
  return costUsd(model, { inputTokens, outputTokens: 1200 });
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const withContent = process.argv.includes('--with-content');
  const limit = argValue('--limit') === undefined ? Infinity : Number(argValue('--limit'));
  const maxUsd = argValue('--max-usd') === undefined ? null : Number(argValue('--max-usd'));
  const only = argValue('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  if (!(limit > 0)) throw new Error('--limit 은 1 이상의 수여야 한다');
  if (maxUsd !== null && !(maxUsd > 0)) throw new Error('--max-usd 는 0 보다 큰 수여야 한다');
  if (!dryRun && maxUsd === null) throw new Error('돈이 드는 명령이다. --max-usd 로 상한을 주거나 --dry-run 으로 먼저 본다');
  if (withContent && !contentApi) console.log('[record] 글 만들기가 아직 끼워지지 않아 뽑기만 녹화한다.');

  const model = process.env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;
  const price = priceOf(model);
  const files = new JsonlCallStore(RECORDINGS_DIR, SAMPLE_RECORDING_FILE);
  // 실제 호출이 적는 줄을 녹화본 표시로 바꿔 파일에 덧붙인다.
  const writer: LlmCallStore = {
    find: (key) => files.find(key),
    save: (record: LlmCallRecord) => files.save({ ...record, isRecorded: true }),
  };
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  if (!dryRun && !apiKey) throw new Error('API 키가 없다. .env.local 에 직접 넣는다(값은 어디에도 찍지 않는다)');
  const provider = createProvider({ kind: 'anthropic', model, apiKey, store: writer });

  console.log(`[record] 모델 ${model} · 단가 입력 $${price.inputPerMTok}/출력 $${price.outputPerMTok} (100만 토큰, ${price.checkedOn} 확인)`);
  let called = 0;
  let spent = 0;
  let planned = 0;
  let plannedUsd = 0;
  let stopped = false;

  const replay = createProvider({ kind: 'replay', model, store: files });

  /**
   * 요청 하나를 녹화한다. 녹화가 있으면 그것을 돌려주고(돈이 들지 않는다), 없으면 부른다.
   * 미리 보기이거나 건수·돈 상한에 걸리면 부르지 않고 "녹화 없음"으로 던진다.
   */
  const complete = async <T>(label: string, req: LlmRequest<T>): Promise<LlmResult<T>> => {
    const plain = req as LlmRequest<unknown>;
    if (await files.find(cacheKeyFor(plain, model))) {
      console.log(`  ${label}: 녹화 있음(건너뜀)`);
      return replay.complete(req);
    }
    const estimate = estimateUsd(model, plain);
    if (planned >= limit) throw new LlmUnavailable('CACHE_MISS', '건수 상한');
    planned += 1;
    plannedUsd += estimate;
    if (dryRun) {
      console.log(`  ${label}: 부를 예정 · 어림 $${estimate.toFixed(4)}`);
      throw new LlmUnavailable('CACHE_MISS', '미리 보기');
    }
    if (maxUsd !== null && spent + estimate > maxUsd) {
      console.log(`  ${label}: 상한($${maxUsd})에 걸려 멈춘다. 지금까지 $${spent.toFixed(4)}`);
      stopped = true;
      throw new LlmUnavailable('CACHE_MISS', '돈 상한');
    }
    try {
      const result = await provider.complete(req);
      const cost = costUsd(model, result.usage);
      called += 1;
      spent += cost;
      console.log(`  ${label}: 녹화함 · ${result.latencyMs}ms · $${cost.toFixed(4)} · 입력 ${result.usage.inputTokens} / 출력 ${result.usage.outputTokens} 토큰`);
      return result;
    } catch (err) {
      if (!isLlmUnavailable(err)) throw err;
      called += 1;
      if (err.usage) spent += costUsd(model, err.usage);
      console.log(`  ${label}: 실패(${err.code}) — 녹화하지 않았다`);
      throw err;
    }
  };
  const orNull = async <T>(label: string, req: LlmRequest<T>): Promise<T | null> => {
    try {
      return (await complete(label, req)).output;
    } catch (err) {
      if (isLlmUnavailable(err)) return null;
      throw err;
    }
  };

  const samples = seedSamples().filter((s) => !only || only.includes(s.id));
  if (only && samples.length !== only.length) throw new Error('--only 에 모르는 보기 글 번호가 있다');
  for (const sample of samples) {
    if (stopped || planned >= limit) break;
    const clean = cleanText(sample.text);
    const extraction = await orNull(`${sample.id} 뽑기`, buildExtractRequest(clean));
    if (!extraction || !withContent || !contentApi) continue;
    // 글 만들기 요청은 뽑힌 값으로 만든 상품에서 나온다. 사람이 고치지 않고 그대로 승인했을 때의 요청이다.
    let input: GenerateContentInput;
    try {
      const evaluation = evaluateDraft({ sourceText: clean, extraction, extractedBy: 'llm' });
      const product = buildProduct(evaluation.type, evaluation.subtype, evaluation.fields);
      input = contentInputOf(product, seedGlossary(), contentApi.pickGlossary);
    } catch {
      console.log(`  ${sample.id} 글 만들기: 상품으로 만들 수 없는 초안이라 건너뜀`);
      continue;
    }
    // 실제 글 만들기와 같은 길을 탄다. 첫 답이 글 검사에 걸리면 다시 한 요청도 함께 녹화된다.
    let turn = 0;
    const recorder: LlmProvider = {
      name: 'anthropic',
      model,
      complete: (req) => complete(`${sample.id} 글 만들기${(turn += 1) > 1 ? '(다시)' : ''}`, req),
    };
    try {
      const made = await contentApi.generateContent(input, recorder);
      const fromModel = made.texts.filter((t) => t.source === 'llm').length;
      if (made.calls.length > 0) console.log(`  ${sample.id} 글 만들기: 호출 ${made.calls.length}번 · 모델 글 ${fromModel}/${made.texts.length}줄(나머지는 틀 문장)`);
    } catch (err) {
      if (!isLlmUnavailable(err)) throw err;
    }
  }

  if (dryRun) console.log(`[record] 미리 보기: 부를 호출 ${planned}건 · 어림 $${plannedUsd.toFixed(4)} (어림이다. 실제 토큰 수로 다시 센다)`);
  else console.log(`[record] 끝. 실제 호출 ${called}건 · 쓴 돈 $${spent.toFixed(4)} · 파일 ${path.join(RECORDINGS_DIR, SAMPLE_RECORDING_FILE)}`);
}

main().catch((err) => {
  console.error('[record]', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
