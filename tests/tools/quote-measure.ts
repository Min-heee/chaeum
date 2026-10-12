// 견적의 잼. 직접 지은 보기 문의 20건(data/seed/quote-samples.json)으로 조건 뽑기를 실제로 불러 칸별 맞은 수를 세고,
// 지어낸 상품 묶음으로 답장 초안 몇 건을 받아 글 검사 통과 수를 센다. 결과는 docs/EVALUATION-TOOLS.md 에 사람이 옮겨 적는다.
// 돈이 드는 명령이다. 받은 답은 data/recordings/quote.jsonl 에 녹화로 남고, 녹화가 있는 요청은 다시 부르지 않는다.
//
//   npx tsx --env-file-if-exists=.env.local tests/tools/quote-measure.ts --dry-run
//   npx tsx --env-file-if-exists=.env.local tests/tools/quote-measure.ts --max-extract 20 --max-reply 6
//
// 정답은 문의를 지은 쪽이 먼저 정한 것이고 사람이 확인하기 전이다. 중국어 글의 자연스러움은 판단하지 않는다.
import path from 'node:path';
import { DEFAULT_LLM_MODEL, isLlmUnavailable, type LlmCallRecord, type LlmCallStore, type LlmRequest } from '../../src/contract/llm-types';
import type { QuoteConditions } from '../../src/contract/tools/quote';
import { pickGlossary } from '../../src/content';
import { buildQuoteExtractRequest, buildQuoteReplyRequest, cacheKeyFor, costUsd, createProvider, JsonlCallStore } from '../../src/llm';
import { cleanText } from '../../src/server/limits';
import { seedGlossary } from '../../src/server/repos/glossary-terms';
import {
  checkReply, fillReply, matchQuote, quoteSamples, replyInputOf, replyValues, resolveConditions,
  SAMPLE_FIELD_LABELS, SAMPLE_FIELDS, SAMPLE_TODAY, scoreSample, type QuoteSample, type SampleField,
} from '../../src/tools/quote';
import { FIXTURE_PRODUCTS } from './quote-fixtures';

const RECORDINGS_DIR = path.join('data', 'recordings');
const RECORDING_FILE = 'quote.jsonl';
/** 답장 초안을 받아 볼 보기 문의. 언어마다 둘, 맞는 상품이 없는 경우 하나를 넣었다. */
const REPLY_SAMPLE_IDS = ['q-ko-01', 'q-ko-07', 'q-en-02', 'q-en-06', 'q-zh-01', 'q-zh-06'];

function argNumber(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  const n = i >= 0 ? Number(process.argv[i + 1]) : fallback;
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} 은 0 이상의 정수여야 한다`);
  return n;
}

/** 정답 그대로의 조건. 답장을 받아 볼 때 쓴다(뽑기가 틀려도 답장 쪽 잼이 흔들리지 않게). */
function expectedConditions(sample: QuoteSample): QuoteConditions {
  const e = sample.expected;
  return { lang: sample.lang, budgetKrw: e.budgetKrw, budgetBy: e.budgetKrw === null ? null : 'code', region: e.region,
    dateFrom: e.dateFrom, dateTo: e.dateTo, dateProblem: false, type: e.type, subtype: e.subtype, qty: e.qty, days: e.days };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const maxExtract = argNumber('--max-extract', 20);
  const maxReply = argNumber('--max-reply', 6);
  const model = process.env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  // 키가 없으면 받아 둔 답만으로 돈다(녹화가 없는 요청은 '답 없음').

  const files = new JsonlCallStore(RECORDINGS_DIR, RECORDING_FILE);
  const writer: LlmCallStore = { find: (key) => files.find(key), save: (record: LlmCallRecord) => files.save({ ...record, isRecorded: true }) };
  const live = createProvider({ kind: 'anthropic', model, apiKey, store: writer });
  const replay = createProvider({ kind: 'replay', model, store: files });
  let spent = 0;
  const called = { extract: 0, reply: 0 };

  /** 녹화가 있으면 그것을, 없으면 상한 안에서 실제로 부른다. 못 받으면 null. */
  const complete = async <T>(kind: 'extract' | 'reply', max: number, req: LlmRequest<T>): Promise<{ output: T; recorded: boolean } | null> => {
    if (await files.find(cacheKeyFor(req as LlmRequest<unknown>, model))) return { output: (await replay.complete(req)).output, recorded: true };
    if (dryRun || !apiKey || called[kind] >= max) return null;
    called[kind] += 1;
    try {
      const result = await live.complete(req);
      spent += costUsd(model, result.usage);
      return { output: result.output, recorded: false };
    } catch (err) {
      if (!isLlmUnavailable(err)) throw err;
      if (err.usage) spent += costUsd(model, err.usage);
      console.log(`  실패(${err.code})`);
      return null;
    }
  };

  // ── 조건 뽑기 ──
  const samples = quoteSamples();
  const right: Record<SampleField, number> = { lang: 0, budget: 0, region: 0, date: 0, type: 0, subtype: 0, qty: 0, days: 0 };
  let answered = 0;
  let allRight = 0;
  console.log(`[잼] 모델 ${model} · 오늘 ${SAMPLE_TODAY} · 보기 문의 ${samples.length}건`);
  for (const sample of samples) {
    const got = await complete('extract', maxExtract, buildQuoteExtractRequest(cleanText(sample.text)));
    if (!got) {
      console.log(`  ${sample.id}: 답 없음`);
      continue;
    }
    answered += 1;
    const conditions = resolveConditions(got.output, SAMPLE_TODAY);
    const score = scoreSample(sample, conditions);
    for (const f of SAMPLE_FIELDS) if (score[f]) right[f] += 1;
    const wrong = SAMPLE_FIELDS.filter((f) => !score[f]);
    if (wrong.length === 0) allRight += 1;
    console.log(`  ${sample.id}${got.recorded ? '(녹화)' : ''}: ${wrong.length === 0 ? '모두 맞음' : `틀린 칸 ${wrong.map((f) => SAMPLE_FIELD_LABELS[f]).join(', ')}`}`);
    if (wrong.length > 0) console.log(`      뽑힌 것 ${JSON.stringify(conditions)}\n      정답 ${JSON.stringify(sample.expected)}`);
  }
  console.log(`[조건 뽑기] 답을 받은 문의 ${answered}/${samples.length} · 여덟 칸이 모두 맞은 문의 ${allRight}/${answered}`);
  for (const f of SAMPLE_FIELDS) console.log(`  ${SAMPLE_FIELD_LABELS[f]}: ${right[f]}/${answered}`);

  // ── 답장 초안 ──
  const glossaryAll = seedGlossary();
  let replies = 0;
  let passed = 0;
  for (const id of REPLY_SAMPLE_IDS) {
    const sample = samples.find((s) => s.id === id);
    if (!sample) throw new Error(`보기 문의가 없다: ${id}`);
    const conditions = expectedConditions(sample);
    const { candidates } = matchQuote(conditions, FIXTURE_PRODUCTS, SAMPLE_TODAY);
    const candidate = candidates[0] ?? null;
    const glossary = candidate && sample.lang !== 'ko'
      ? pickGlossary(glossaryAll, { type: candidate.type, subtype: candidate.subtype, name: candidate.name, region: candidate.region })
      : [];
    const input = replyInputOf({ lang: sample.lang, inquiry: cleanText(sample.text), candidate, candidateCount: candidates.length, glossary });
    const got = await complete('reply', maxReply, buildQuoteReplyRequest(input));
    if (!got) {
      console.log(`  ${id} 답장: 답 없음`);
      continue;
    }
    replies += 1;
    const template = got.output.reply.trim();
    const fails = checkReply(template, input);
    if (fails.length === 0) passed += 1;
    console.log(`  ${id} 답장${got.recorded ? '(녹화)' : ''}: 고른 상품 ${candidate ? candidate.name : '없음'} · ${fails.length === 0 ? '검사 통과' : `걸림 ${fails.join(', ')}`}`);
    console.log(fillReply(template, replyValues(candidate), sample.lang, { vatIncluded: candidate?.pricing.vatIncluded ?? null }).replace(/^/gm, '      | '));
  }
  console.log(`[답장 초안] 받은 답장 ${replies}/${REPLY_SAMPLE_IDS.length} · 첫 답이 글 검사를 통과한 것 ${passed}/${replies}`);
  console.log(`[잼] 이번에 실제로 부른 호출: 조건 뽑기 ${called.extract}번 · 답장 ${called.reply}번 · 쓴 돈 $${spent.toFixed(4)}`);
}

main().catch((err) => {
  console.error('[잼]', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
