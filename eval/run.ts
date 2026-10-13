// 평가 실행. 묶음을 읽어 문서마다 뽑기 1회 → 같은 호출에서 세 방식(rules / llm_only / llm_code)을 채점한다.
//
//   npm run eval -- --split dev --dry-run        대상 건수, 장부에 있는 건수, 어림 비용. 키도 DB 도 없어도 된다
//   npm run eval -- --split dev --limit 3        3건만
//   npm run eval -- --split dev --max-usd 0.3    넘을 것 같으면 멈추고 끝난 데까지 저장
//   npm run eval -- --split dev --prompts v1,current   프롬프트 판 견주기
//   npm run eval -- --split dev --prompts v2 --fresh   장부를 읽지도 쓰지도 않고 모든 문서를 다시 부른다(같은 판을 두 번 재 볼 때)
//   npm run eval -- --split dev --prompts v2 --fresh --keep-answers   위와 같되 받은 답을 실행별 파일(data/recordings/runs)에 따로 남긴다
//
// 기본으로 도는 것은 연습 세트(dev)뿐이다. 안 여는 묶음(test·real)은 긴 깃발과 --sealed 경로가 함께 있어야 열린다.
// 사람 확인 기록이 없는 문서는 채점에서 뺀다(--include-unreviewed 로만 넣고, 기록에 "확인 전 포함"이 남는다).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { EVAL_METHODS, SPLIT_LABELS, type EvalMethod, type GoldDoc, type GoldSplit } from '@/contract/eval-types';
import { DEFAULT_LLM_MODEL, type LlmCallStore, type LlmProvider } from '@/contract/llm-types';
import { costUsd, createProvider, JsonlCallStore, priceOf } from '@/llm';
import { closePool, getPool } from '@/server/db';
import { PgLlmCallStore } from '@/server/repos/llm-calls';
import { compareRuns, formatComparison, type RunCells } from './compare';
import {
  ChainStore,
  gitCommit,
  goldVersionOf,
  loadReviews,
  loadSplit,
  parseArgs,
  parseSplits,
  RECORDINGS_DIR,
  RESULTS_DIR,
  RUN_ANSWERS_DIR,
  SEALED_FLAG,
  SEALED_SPLITS,
  stampOf,
  usd,
  type SplitSource,
} from './io';
import { formatRatio } from './metrics';
import { pickPrompts, type ExtractBuilder } from './prompts';
import { stripValues, writeRunFiles, type EvalRunFile } from './report';
import { estimateRun, metricsByMethod, runDocs, selectDocs, type Selection } from './runner';
import { countRuns, createRuns, finishRun, saveCells, type RunInfo } from './store';

export interface ExecuteParams {
  split: GoldSplit;
  /** 고르고 자른 뒤의 문서 */
  docs: readonly GoldDoc[];
  selection: Pick<Selection, 'excludedUnreviewed' | 'excludedDropped' | 'includesUnreviewed'>;
  limit: number | null;
  model: string;
  build: ExtractBuilder;
  db: Pool;
  /** DB 장부보다 먼저 보는 장부(녹화 파일) */
  extraReaders: readonly LlmCallStore[];
  /** 실제 호출의 답을 DB 말고 더 적어 둘 곳(연습 세트의 녹화 파일). 없으면 DB 에만 적는다. */
  extraWriter: LlmCallStore | null;
  /** 장부를 받아 실제 공급자를 만든다. null 이면 장부에 있는 것만 쓴다. */
  makeLive: ((store: LlmCallStore) => LlmProvider) | null;
  /**
   * 참이면 장부를 읽지도 쓰지도 않는다. 모든 문서를 실제로 다시 부른다.
   * 같은 프롬프트라도 답이 달라질 수 있어 한 판을 두 번 잴 때 쓴다. 먼저 돌린 실행의 녹화본은 그대로 남는다.
   * 채점 결과(eval_runs, eval_results, 기록 파일)는 평소처럼 남는다.
   */
  fresh?: boolean;
  /**
   * fresh 일 때만 본다. 받은 답을 따로 적어 둘 곳과 그 파일 이름(기록에 남긴다).
   * 장부(DB, 녹화 파일)가 아니므로 다음 실행이 이 답을 읽지 않는다. 나중에 원문 표현과 읽은 값을 들여다볼 때 쓴다.
   */
  freshAnswers?: { store: LlmCallStore; file: string } | null;
  maxUsd: number | null;
  startedAt: Date;
  gitCommit: string;
  resultsDir?: string;
  log?: (line: string) => void;
}

/** 묶음 하나, 프롬프트 판 하나를 돌려 DB(eval_runs 3줄 + eval_results)와 파일에 남긴다. */
export async function executeRun(p: ExecuteParams): Promise<{ file: EvalRunFile; paths: { json: string; summary: string } }> {
  const log = p.log ?? (() => undefined);
  const promptVersion = p.build('').promptVersion;
  const goldVersion = goldVersionOf(p.docs);
  const runIds = await createRuns(p.db, {
    split: p.split,
    model: p.model,
    promptVersion,
    goldVersion,
    gitCommit: p.gitCommit,
    startedAt: p.startedAt,
  });

  // 이번 실행이 적는 장부 줄에는 llm_code 실행 번호가 붙는다.
  const pg = new PgLlmCallStore({ db: p.db, evalRunId: runIds.llm_code });
  const kept = p.fresh ? (p.freshAnswers ?? null) : null;
  const store = p.fresh ? new ChainStore([], kept ? [kept.store] : []) : new ChainStore([...p.extraReaders, pg], p.extraWriter ? [pg, p.extraWriter] : [pg]);
  const outcome = await runDocs(p.docs, {
    model: p.model,
    buildRequest: p.build,
    store,
    live: p.makeLive ? p.makeLive(store) : null,
    maxUsd: p.maxUsd,
    priceUsd: (usage) => costUsd(p.model, usage),
    onDoc: log,
  });

  const metrics = metricsByMethod(outcome);
  const info: RunInfo = {
    includeUnreviewed: p.selection.includesUnreviewed,
    excludedUnreviewed: p.selection.excludedUnreviewed,
    excludedDropped: p.selection.excludedDropped,
    limit: p.limit,
    stoppedByBudget: outcome.stoppedByBudget,
    replayOnly: p.makeLive === null,
    callFailures: outcome.failures.length,
    ...(p.fresh ? { fresh: true } : {}),
    ...(kept ? { answersFile: kept.file } : {}),
  };
  // 실제 자료 묶음은 원문에서 온 값을 DB 에도 파일에도 싣지 않는다.
  const strip = p.split === 'real';
  for (const method of EVAL_METHODS) {
    await saveCells(p.db, runIds[method], outcome.cells[method], { stripValues: strip });
    // 돈은 뽑기 호출 한 번에 쓴 것이다. 방식 셋에 나눠 적지 않고 llm_code 줄에만 적는다(더하면 두 번 세게 된다).
    await finishRun(p.db, runIds[method], metrics[method], method === 'llm_code' ? outcome.spentUsd : 0, info);
  }

  const file: EvalRunFile = {
    split: p.split,
    goldVersion,
    model: p.model,
    promptVersion,
    gitCommit: p.gitCommit,
    startedAt: p.startedAt.toISOString(),
    replayOnly: p.makeLive === null,
    stoppedByBudget: outcome.stoppedByBudget,
    runs: Object.fromEntries(EVAL_METHODS.map((m) => [m, { runId: runIds[m], metrics: metrics[m] }])) as EvalRunFile['runs'],
    costUsd: outcome.spentUsd,
    info,
    docIds: outcome.docIds,
    notRun: outcome.notRun,
    failures: outcome.failures,
    calls: outcome.calls,
    cells: Object.fromEntries(EVAL_METHODS.map((m) => [m, strip ? stripValues(outcome.cells[m]) : outcome.cells[m]])) as EvalRunFile['cells'],
  };
  return { file, paths: writeRunFiles(file, p.resultsDir ?? RESULTS_DIR) };
}

function printRun(file: EvalRunFile, paths: { json: string; summary: string }): void {
  const real = file.calls.filter((c) => !c.recorded);
  console.log(`\n[${SPLIT_LABELS[file.split]} · ${file.promptVersion} · ${file.model}] 채점 ${file.docIds.length}건, 커밋 ${file.gitCommit}`);
  if (file.info.includeUnreviewed) console.log('  ※ 확인 전 포함: 사람이 확인하지 않은 문서가 들어 있다.');
  if (file.stoppedByBudget) console.log(`  ※ 상한에 걸려 멈춤: ${file.notRun.length}건을 돌리지 못했다.`);
  if (file.failures.length > 0) console.log(`  ※ 답을 못 받은 문서 ${file.failures.length}건: ${file.failures.map((f) => `${f.goldDocId}(${f.code})`).join(', ')}`);
  for (const method of EVAL_METHODS) {
    const m = file.runs[method].metrics;
    const graded = m.fieldAccuracy.overall.den + m.fabricated.overall.den;
    console.log(
      `  ${method.padEnd(8)} 실행 ${file.runs[method].runId}: 채점한 칸 ${graded}` +
        ` · 칸 정확도 ${formatRatio(m.fieldAccuracy.overall)} · 지어낸 값 ${formatRatio(m.fabricated.overall)}` +
        ` · 전부 맞은 문서 ${formatRatio(m.docsAllCorrect)}`,
    );
  }
  const tokens = real.reduce((sum, c) => ({ i: sum.i + c.inputTokens, o: sum.o + c.outputTokens }), { i: 0, o: 0 });
  console.log(`  실제 호출 ${real.length}건(입력 ${tokens.i} + 출력 ${tokens.o} 토큰), 장부에서 읽음 ${file.calls.length - real.length}건, 쓴 돈 ${usd(file.costUsd)}`);
  const time = file.runs.llm_code.metrics.costTime;
  if (time) console.log(`  시간: 가운데값 ${time.latencyMsP50}ms, 95번째 ${time.latencyMsP95}ms${time.fromRecording ? ' (녹화 때 잰 값이 섞여 있다)' : ''}`);
  console.log(`  기록: ${paths.json}\n  요약: ${paths.summary}`);
  if (file.split === 'dev') console.log('  연습 세트의 점수는 고칠 때 보는 숫자다. 바깥 문서에 옮기지 않는다.');
}

const toRunCells = (file: EvalRunFile, method: EvalMethod): RunCells => ({
  runId: file.runs[method].runId,
  split: file.split,
  method,
  goldVersion: file.goldVersion,
  cells: file.cells[method],
});

async function dbReachable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(
    argv,
    ['--split', '--limit', '--max-usd', '--prompts', '--model', '--sealed'],
    ['--dry-run', '--include-unreviewed', '--replay-only', '--no-record-file', '--fresh', '--keep-answers', SEALED_FLAG],
  );
  const splits = parseSplits(args.values.get('--split'));
  const prompts = pickPrompts(args.values.get('--prompts'));
  const model = args.values.get('--model') ?? (process.env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL);
  const price = priceOf(model); // 단가를 모르는 모델이면 여기서 멈춘다
  const dryRun = args.flags.has('--dry-run');
  const fresh = args.flags.has('--fresh');
  if (fresh && args.flags.has('--replay-only')) throw new Error('--fresh 와 --replay-only 는 함께 쓰지 않는다(하나는 장부를 안 읽고, 하나는 장부만 읽는다)');

  const keepAnswers = args.flags.has('--keep-answers');
  if (keepAnswers && !fresh) throw new Error('--keep-answers 는 --fresh 와 함께 쓴다(평소 실행은 답을 장부에 적는다)');

  const limit = args.values.has('--limit') ? Number(args.values.get('--limit')) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit 은 1 이상의 정수다');
  const maxUsd = args.values.has('--max-usd') ? Number(args.values.get('--max-usd')) : null;
  if (maxUsd !== null && !(maxUsd > 0)) throw new Error('--max-usd 는 0 보다 큰 수다');

  const source: SplitSource = { sealedPath: args.values.get('--sealed') ?? null, sealedFlag: args.flags.has(SEALED_FLAG) };
  const reviews = await loadReviews();

  // 묶음을 모두 읽고 고른 뒤에 돌린다. 인자가 틀렸으면 한 건도 부르기 전에 멈춘다.
  const plans = [];
  for (const split of splits) {
    const all = await loadSplit(split, source);
    const selection = selectDocs(all, reviews, { includeUnreviewed: args.flags.has('--include-unreviewed') });
    const docs = limit !== null ? selection.docs.slice(0, limit) : selection.docs;
    console.log(
      `[${SPLIT_LABELS[split]}] 전체 ${all.length}건 → 채점 ${docs.length}건` +
        ` (확인 기록 없어 뺌 ${selection.excludedUnreviewed}건, 버림 판정으로 뺌 ${selection.excludedDropped}건` +
        `${limit !== null ? `, --limit ${limit}` : ''})`,
    );
    if (selection.includesUnreviewed) console.log('  ※ 확인 전 포함: 사람이 확인하지 않은 문서가 채점에 들어간다. 실행 기록에 남는다.');
    if (selection.excludedUnreviewed > 0 && docs.length === 0) {
      console.log('  확인한 문서가 없다. /label 에서 확인하고 npm run gold:export 로 확인 기록을 파일에 쓴 뒤 다시 돌린다.');
    }
    plans.push({ split, selection, docs });
  }

  const hasDb = await dbReachable();
  const files = new JsonlCallStore(RECORDINGS_DIR);
  const priceUsd = (usage: { inputTokens: number; outputTokens: number }) => costUsd(model, usage);

  try {
    if (dryRun) {
      if (!hasDb) console.log('DB 에 닿지 않는다. 녹화 파일만 보고 어림한다.');
      if (fresh) console.log('--fresh: 장부를 보지 않는다. 모든 문서를 실제로 부르는 것으로 어림한다.');
      const store = fresh ? new ChainStore([], []) : new ChainStore(hasDb ? [files, new PgLlmCallStore({ db: getPool() })] : [files], []);
      console.log(`모델 ${model} · 단가 입력 ${price.inputPerMTok} / 출력 ${price.outputPerMTok} 달러(100만 토큰) · ${price.checkedOn} 확인`);
      for (const plan of plans) {
        for (const prompt of prompts) {
          const est = await estimateRun(plan.split, plan.docs, { model, buildRequest: prompt.build, store, priceUsd });
          const basis = est.basis === 'ledger_average' ? '장부에 있는 건의 평균' : '정해 둔 어림값';
          console.log(
            `[어림] ${plan.split} · ${prompt.build('').promptVersion}: 대상 ${est.docs}건, 장부에 있음 ${est.cached}건,` +
              ` 실제로 부를 것 ${est.toCall}건, 어림 비용 ${usd(est.estCostUsd)} (근거: ${basis})`,
          );
        }
      }
      console.log('어림일 뿐이다. 아무것도 부르지 않았고 아무것도 적지 않았다.');
      return 0;
    }

    if (!hasDb) throw new Error('DB 에 닿지 않는다. 평가 실행은 eval_runs 에 남겨야 하므로 DATABASE_URL 이 필요하다.');
    const db = getPool();
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
    const replayOnly = args.flags.has('--replay-only') || process.env.LLM_PROVIDER?.trim() === 'replay' || !apiKey;
    if (fresh && replayOnly) throw new Error('--fresh 는 실제 호출이 필요하다. API 키가 없거나 LLM_PROVIDER 가 replay 다.');
    if (fresh) console.log('--fresh: 장부를 읽지도 쓰지도 않고 모든 문서를 다시 부른다.');
    if (keepAnswers) console.log(`--keep-answers: 받은 답을 ${RUN_ANSWERS_DIR} 아래 실행별 파일에 따로 남긴다(장부가 아니다. 다음 실행이 읽지 않는다).`);
    if (replayOnly) console.log(apiKey ? '녹화본만으로 돈다(실제 호출 없음).' : 'API 키가 없다. 장부에 있는 답만으로 돈다(없는 건은 CACHE_MISS 로 적힌다).');
    const makeLive = replayOnly ? null : (store: LlmCallStore) => createProvider({ kind: 'anthropic', model, apiKey, store });

    const commit = gitCommit();
    let left = maxUsd;
    for (const plan of plans) {
      if (plan.docs.length === 0) {
        console.log(`[${plan.split}] 채점할 문서가 없어 건너뛴다(eval_runs 에도 남기지 않는다).`);
        continue;
      }
      if (SEALED_SPLITS.includes(plan.split)) {
        console.log(`※ 안 여는 묶음(${plan.split})을 연다. 지금까지 ${await countRuns(db, plan.split)}번 돌렸다. 이번 실행도 eval_runs 에 남는다.`);
      }
      const done: EvalRunFile[] = [];
      for (const prompt of prompts) {
        // 연습 세트의 답만 저장소의 녹화 파일에 적는다. 다른 묶음의 답은 DB 장부에만 남는다.
        const recordFile = plan.split === 'dev' && !args.flags.has('--no-record-file');
        const startedAt = new Date();
        // 실행별 답 파일도 연습 세트만 남긴다. 이름은 기록 파일과 같은 머리(시각-묶음-판)다.
        const answersName = `${stampOf(startedAt)}-${plan.split}-${prompt.build('').promptVersion}.jsonl`;
        if (keepAnswers && plan.split !== 'dev') console.log(`  ※ --keep-answers 는 연습 세트에서만 답을 남긴다. ${plan.split} 묶음의 답은 남기지 않는다.`);
        const { file, paths } = await executeRun({
          split: plan.split,
          docs: plan.docs,
          selection: plan.selection,
          limit,
          model,
          build: prompt.build,
          db,
          extraReaders: [files],
          extraWriter: recordFile ? new JsonlCallStore(RECORDINGS_DIR, `eval-${plan.split}.jsonl`) : null,
          makeLive,
          fresh,
          freshAnswers:
            keepAnswers && plan.split === 'dev'
              ? { store: new JsonlCallStore(RUN_ANSWERS_DIR, answersName), file: path.posix.join('data', 'recordings', 'runs', answersName) }
              : null,
          maxUsd: left,
          startedAt,
          gitCommit: commit,
          log: (line) => console.log(line),
        });
        if (left !== null) left = Math.max(0, left - file.costUsd);
        printRun(file, paths);
        done.push(file);
      }
      // 프롬프트 판을 둘 넘게 줬으면 첫 판과 나머지를 건별로 견준다.
      for (const other of done.slice(1)) {
        for (const method of ['llm_only', 'llm_code'] as const) {
          console.log(`\n${formatComparison(compareRuns(toRunCells(done[0]!, method), toRunCells(other, method)), `${method}: ${done[0]!.promptVersion} → ${other.promptVersion}`)}`);
        }
      }
    }
    return 0;
  } finally {
    await closePool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`[eval] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
