// 정답 확인 화면이 쓰는 것. 화면은 로컬 전용이다.
import path from 'node:path';
import { DEV_FILE, HAND_FILE, REVIEWS_FILE, realGoldFile, sealedTestFile } from './paths';
import { syncFiles, type SyncReport } from './sync';
import { FIRST_PASS_PER_DOC, type Db } from './store';

/** LABEL_ENABLED=1 일 때만 화면과 그 API 가 열린다. 아니면 404. */
export const labelEnabled = (env: NodeJS.ProcessEnv = process.env) => env.LABEL_ENABLED === '1';

/** 한 번에 보는 건수 */
export const LABEL_BATCH = 30;
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
