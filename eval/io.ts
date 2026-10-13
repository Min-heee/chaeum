// 평가 명령들이 함께 쓰는 읽기·쓰기: 명령줄 인자, 정답 파일, 확인 기록, 장부 겹치기, 커밋 번호.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { GOLD_SPLITS, type GoldDoc, type GoldSplit } from '@/contract/eval-types';
import type { LlmCallRecord, LlmCallStore } from '@/contract/llm-types';
import { readJsonlFile } from '@/gold/files';
import { DEV_FILE, HAND_FILE, REVIEWS_FILE } from '@/gold/paths';
import { readReviewsFile } from '@/gold/sync';
import type { ReviewLine } from './runner';

export const RECORDINGS_DIR = path.join('data', 'recordings');
/**
 * --fresh --keep-answers 로 받은 답을 실행마다 한 파일씩 두는 곳.
 * 녹화 폴더의 아래 폴더라서 장부(JsonlCallStore 는 폴더 바로 아래의 *.jsonl 만 읽는다)에 섞이지 않는다.
 */
export const RUN_ANSWERS_DIR = path.join(RECORDINGS_DIR, 'runs');
export const RESULTS_DIR = path.join('eval', 'results');
export const BASELINE_FILE = path.join('eval', 'baseline.json');

/** 안 여는 묶음을 돌릴 때 꼭 있어야 하는 깃발. 길고 분명하게 지었다. */
export const SEALED_FLAG = '--i-know-this-opens-the-sealed-set';
/** 개선 동안 열지 않기로 한 묶음. */
export const SEALED_SPLITS: readonly GoldSplit[] = ['test', 'real'];

// ── 명령줄 인자 ────────────────────────────────────────────

export interface Args {
  flags: Set<string>;
  values: Map<string, string>;
}

/** "--이름 값"과 "--깃발"을 가른다. 값을 받는 이름은 valueNames 에 적는다. 모르는 인자가 있으면 오류. */
export function parseArgs(argv: readonly string[], valueNames: readonly string[], flagNames: readonly string[]): Args {
  const args: Args = { flags: new Set(), values: new Map() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (valueNames.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 뒤에 값이 없다`);
      args.values.set(arg, value);
      i += 1;
    } else if (flagNames.includes(arg)) {
      args.flags.add(arg);
    } else {
      throw new Error(`모르는 인자: ${arg}`);
    }
  }
  return args;
}

export function parseSplits(raw: string | undefined): GoldSplit[] {
  const names = (raw ?? 'dev').split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    if (!(GOLD_SPLITS as readonly string[]).includes(name)) throw new Error(`모르는 묶음: ${name} (${GOLD_SPLITS.join(' | ')})`);
  }
  return [...new Set(names)] as GoldSplit[];
}

// ── 정답 파일 ──────────────────────────────────────────────

export interface SplitSource {
  /** --sealed 로 받은 경로(파일이나 폴더). 없으면 null. */
  sealedPath: string | null;
  /** 안 여는 묶음을 연다는 깃발을 줬는가 */
  sealedFlag: boolean;
}

/**
 * 묶음의 파일 자리를 정한다. 기본으로 열리는 것은 연습 세트뿐이다.
 * - dev: 저장소의 연습 세트.
 * - hand: --sealed 경로가 있으면 그것, 없으면 저장소의 손글 파일.
 * - test·real: 깃발과 --sealed 경로가 둘 다 있어야 한다. 환경 변수로는 열리지 않는다.
 * --sealed 가 폴더면 그 안의 <묶음>.jsonl 이다.
 */
export function splitFile(split: GoldSplit, source: SplitSource): string {
  const fromSealed = (p: string) => (existsSync(p) && statSync(p).isDirectory() ? path.join(p, `${split}.jsonl`) : p);
  if (split === 'dev') return DEV_FILE;
  if (split === 'hand') return source.sealedPath ? fromSealed(source.sealedPath) : HAND_FILE;
  if (!source.sealedFlag) {
    throw new Error(`${split} 묶음은 개선 동안 열지 않는다. 정말 돌리려면 ${SEALED_FLAG} 와 --sealed <경로> 를 함께 준다. 돌릴 때마다 eval_runs 에 남는다.`);
  }
  if (!source.sealedPath) throw new Error(`${split} 묶음의 자리를 --sealed <경로> 로 준다(파일이나 폴더).`);
  return fromSealed(source.sealedPath);
}

/** 묶음의 문서를 읽는다. 파일이 없거나 다른 묶음의 문서가 섞여 있으면 오류. */
export async function loadSplit(split: GoldSplit, source: SplitSource): Promise<GoldDoc[]> {
  const file = splitFile(split, source);
  const docs = await readJsonlFile(file);
  if (!docs) throw new Error(`정답 파일이 없다: ${SEALED_SPLITS.includes(split) ? `(${split} 묶음, --sealed 로 준 자리)` : file}`);
  const mine = docs.filter((d) => d.split === split);
  if (mine.length === 0) throw new Error(`그 파일에 ${split} 묶음의 문서가 없다`);
  return mine;
}

/** 확인 기록 파일을 읽는다(원문은 없다). 없으면 빈 목록. 적힌 순서가 곧 시간 순서다. */
export async function loadReviews(file: string = REVIEWS_FILE): Promise<ReviewLine[]> {
  return (await readReviewsFile(file)).map((r) => ({ goldDocId: r.goldDocId, pass: r.pass, verdict: r.verdict }));
}

export function goldVersionOf(docs: readonly GoldDoc[]): number {
  return docs.reduce((max, d) => Math.max(max, d.goldVersion), 1);
}

// ── 장부 겹치기 ────────────────────────────────────────────

/**
 * 장부 여럿을 하나처럼 쓴다. 찾을 때는 앞에서부터, 적을 때는 writers 모두에.
 * 평가는 녹화 파일과 DB 장부를 함께 본다.
 */
export class ChainStore implements LlmCallStore {
  constructor(
    private readonly readers: readonly LlmCallStore[],
    private readonly writers: readonly LlmCallStore[],
  ) {}

  async find(cacheKey: string): Promise<LlmCallRecord | null> {
    for (const store of this.readers) {
      const hit = await store.find(cacheKey);
      if (hit && hit.provider !== 'fake') return hit;
    }
    return null;
  }

  async save(record: LlmCallRecord): Promise<void> {
    for (const store of this.writers) await store.save(record);
  }
}

// ── 그 밖 ──────────────────────────────────────────────────

/** 지금 코드의 커밋 번호. 커밋하지 않은 변경이 있으면 "-dirty" 를 붙인다. git 이 없으면 "unknown". */
export function gitCommit(): string {
  try {
    const run = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const head = run(['rev-parse', '--short', 'HEAD']);
    return run(['status', '--porcelain']) === '' ? head : `${head}-dirty`;
  } catch {
    return 'unknown';
  }
}

/** 파일 이름에 쓰는 시각 글자. 2026-10-12T01:02:03.000Z → 20261012T010203Z */
export function stampOf(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export const usd = (n: number) => `$${n.toFixed(4)}`;
