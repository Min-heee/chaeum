// 정답 확인 화면이 쓰는 것. 화면은 로컬 전용이다.
import path from 'node:path';
import type { GoldSplit } from '@/contract/eval-types';
import type { HintFile } from './hints';
import { DEV_FILE, HAND_FILE, REVIEWS_FILE, realGoldFile, sealedTestFile } from './paths';
import { syncFiles, type SyncReport } from './sync';
import { FIRST_PASS_PER_DOC, type Db } from './store';
import { pickTarget } from './target';

/** LABEL_ENABLED=1 일 때만 화면과 그 API 가 열린다. 아니면 404. */
export const labelEnabled = (env: NodeJS.ProcessEnv = process.env) => env.LABEL_ENABLED === '1';

/** 한 번에 보는 건수. 한 묶음이 끝나면 쉬어 가라고 알린다. */
export const LABEL_BATCH = 10;
/** 다시 보기 건수 */
export const RECHECK_COUNT = 10;

/**
 * 화면을 열 때 파일의 정답을 DB 에 맞춰 싣는다.
 * 안 여는 세트와 실제 자료는 저장소 밖(SEALED_GOLD_PATH)에서 읽는다. 사람이 화면으로 확인하기 위해서다.
 * 그 뒤로 DB 의 gold_docs 에도 그 묶음이 실려 있다. 고치는 동안에는 split 이 test·real 인 줄을 조회하지 않는다.
 */
export async function syncForLabel(db: Db): Promise<SyncReport> {
  // 로컬에서만 도는 길이다. 묶을 때 이 파일 길을 따라 저장소 전체를 싣지 않게 표시해 둔다.
  const at = (file: string) => path.join(/* turbopackIgnore: true */ process.cwd(), file);
  return syncFiles(db, [at(DEV_FILE), at(HAND_FILE), sealedTestFile(), realGoldFile()], at(REVIEWS_FILE));
}

export interface DocStatus {
  id: string;
  split: string;
  type: string;
  verdict: string | null;
  seconds: number | null;
}

/**
 * 문서별 첫 확인 상태. 같은 문서를 여러 번 확인했으면 요약(summarize)과 같은 셈법을 쓴다:
 * 한 번이라도 고쳤으면 "고침"(마지막이 버림이면 버림), 걸린 초는 모두 더한다.
 */
export async function listStatus(db: Db): Promise<DocStatus[]> {
  const { rows } = await db.query(
    `SELECT d.id, d.split, d.truth->>'type' AS type, l.verdict, l.seconds
       FROM gold_docs d
       LEFT JOIN (${FIRST_PASS_PER_DOC}) l ON l.gold_doc_id = d.id
      ORDER BY d.split, d.id`,
  );
  return rows as DocStatus[];
}

// ── 이번에 확인할 문서(목표) ───────────────────────────────

/** 묶음마다 이번에 확인하기로 한 건수의 기본값. 여기 없는 묶음은 전부 확인한다. */
export const TARGET_DEFAULTS: Partial<Record<GoldSplit, number>> = { dev: 20, test: 40 };
/** 확인할 문서를 고르는 씨앗. 바꾸면 고르는 문서가 달라진다. */
export const TARGET_SEED = 20261012;

/** 그 묶음에서 확인하기로 한 건수. LABEL_TARGET_DEV, LABEL_TARGET_TEST 로 바꾼다. 목표가 없는 묶음은 null. */
export function targetCount(split: GoldSplit, env: NodeJS.ProcessEnv = process.env): number | null {
  const base = TARGET_DEFAULTS[split];
  if (base === undefined) return null;
  const set = Number(env[`LABEL_TARGET_${split.toUpperCase()}`]?.trim() || NaN);
  return Number.isInteger(set) && set >= 1 ? set : base;
}

/**
 * 그 묶음에서 이번에 확인할 문서 번호. 목표가 없는 묶음은 null(전부 확인).
 * 종류와 글 꼴이 고르게 섞이도록 씨앗으로 고르고, 이미 확인한 문서(버림 아님)는 반드시 넣는다.
 * 글 꼴은 표기 지시 파일에서 읽는다. 파일이 없으면 종류만으로 고른다.
 */
export async function labelTarget(db: Db, split: GoldSplit, hints: HintFile | null, env: NodeJS.ProcessEnv = process.env): Promise<string[] | null> {
  const count = targetCount(split, env);
  if (count === null) return null;
  const { rows } = await db.query(
    `SELECT d.id, d.truth->>'type' AS type, l.verdict
       FROM gold_docs d
       LEFT JOIN (${FIRST_PASS_PER_DOC}) l ON l.gold_doc_id = d.id
      WHERE d.split = $1 ORDER BY d.id`,
    [split],
  );
  const docs = rows as { id: string; type: string; verdict: string | null }[];
  const items = docs.map((d) => ({ id: d.id, type: d.type, style: hints?.get(d.id)?.style ?? null }));
  const keep = docs.filter((d) => d.verdict !== null && d.verdict !== 'dropped').map((d) => d.id);
  return pickTarget(items, count, TARGET_SEED, keep);
}
