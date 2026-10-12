// 정답 파일이 놓이는 자리.
import os from 'node:os';
import path from 'node:path';

/** 저장소 안: 연습 세트와 안 여는 세트의 해시 */
export const GOLD_DIR = path.join('data', 'gold');
export const DEV_FILE = path.join(GOLD_DIR, 'dev.jsonl');
export const HAND_FILE = path.join(GOLD_DIR, 'hand.jsonl');
export const TEST_HASH_FILE = path.join(GOLD_DIR, 'test.sha256');
export const REVIEWS_FILE = path.join(GOLD_DIR, 'reviews.jsonl');

const fromHome = (p: string) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

/**
 * 원문을 쓰는 동안만 쓰는 작업 폴더. 안 여는 세트의 정답 설계도와 원문이 들어 있으므로 저장소 밖에 둔다
 * (저장소 안에 두면 커밋되지 않아도 저장소를 훑는 도구에 그대로 읽힌다).
 * GOLD_WORK_DIR 로 바꿀 수 있다. 없으면 홈 아래 chaeum-gold-work.
 */
export function workDir(env: NodeJS.ProcessEnv = process.env): string {
  return fromHome(env.GOLD_WORK_DIR?.trim() || path.join(os.homedir(), 'chaeum-gold-work'));
}

/**
 * 안 여는 세트의 파일. 저장소 밖에 둔다.
 * SEALED_GOLD_PATH 가 폴더면 그 안의 test.jsonl, 파일이면 그 파일이다. 없으면 홈 아래 chaeum-sealed.
 */
export function sealedTestFile(env: NodeJS.ProcessEnv = process.env): string {
  const p = fromHome(env.SEALED_GOLD_PATH?.trim() || path.join(os.homedir(), 'chaeum-sealed'));
  return p.endsWith('.jsonl') ? p : path.join(p, 'test.jsonl');
}

/** 실제 자료 묶음의 파일. 남이 쓴 글이라 원문을 저장소에 넣지 않는다. 안 여는 세트와 같은 폴더에 둔다. */
export function realGoldFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(sealedTestFile(env)), 'real.jsonl');
}
