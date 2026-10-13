// 정답 파일이 놓이는 자리.
import os from 'node:os';
import path from 'node:path';

/** 저장소 안: 연습 세트와 안 여는 세트의 해시 */
export const GOLD_DIR = path.join('data', 'gold');
export const DEV_FILE = path.join(GOLD_DIR, 'dev.jsonl');
export const HAND_FILE = path.join(GOLD_DIR, 'hand.jsonl');
export const TEST_HASH_FILE = path.join(GOLD_DIR, 'test.sha256');
export const REVIEWS_FILE = path.join(GOLD_DIR, 'reviews.jsonl');
/** 실제 자료의 출처 목록(주소·받은 날짜·종류). 원문도 값도 없다. */
export const REAL_SOURCES_FILE = path.join(GOLD_DIR, 'real-sources.json');
/** 실제 자료에서 사람이 칸마다 한 일(그대로·고침·지움·넣음)과 그 셈. 값은 없다. */
export const REAL_EDITS_FILE = path.join(GOLD_DIR, 'real-edits.json');

const fromHome = (p: string) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

/** 저장소 밖에 두기로 한 파일의 자리가 저장소 안이거나 상대 경로일 때 던진다. */
export class OutsidePathError extends Error {}

/**
 * 저장소 밖에 둘 파일의 자리를 본다. 절대 경로(또는 ~ 로 시작하는 길)여야 하고, 저장소 뿌리(root, 보통 작업 폴더) 안이면 안 된다.
 * 상대 경로를 받지 않는 까닭: 어느 폴더에서 돌리느냐에 따라 자리가 달라지고, 저장소에서 돌리면 저장소 안에 쓰인다.
 */
/** 저장소 뿌리. 견주기만 한다(파일을 읽지 않는다). 묶을 때 이 길을 따라 저장소를 싣지 않게 표시해 둔다. */
const repoRoot = () => /* turbopackIgnore: true */ process.cwd();

export function outsideRepo(file: string, root: string = repoRoot()): string {
  if (!path.isAbsolute(file)) throw new OutsidePathError('SEALED_GOLD_PATH 는 절대 경로나 ~ 로 시작하는 길이어야 한다(상대 경로는 저장소 안에 쓰일 수 있다).');
  const full = path.resolve(file);
  const base = path.resolve(root);
  if (full === base || full.startsWith(base + path.sep)) throw new OutsidePathError('SEALED_GOLD_PATH 가 저장소 안을 가리킨다. 안 여는 세트와 실제 자료의 원문은 저장소 밖에 둔다.');
  return full;
}

/**
 * 원문을 쓰는 동안만 쓰는 작업 폴더. 안 여는 세트의 정답 설계도와 원문이 들어 있으므로 저장소 밖에 둔다
 * (저장소 안에 두면 커밋되지 않아도 저장소를 훑는 도구에 그대로 읽힌다).
 * GOLD_WORK_DIR 로 바꿀 수 있다. 없으면 홈 아래 chaeum-gold-work.
 */
export function workDir(env: NodeJS.ProcessEnv = process.env): string {
  return fromHome(env.GOLD_WORK_DIR?.trim() || path.join(os.homedir(), 'chaeum-gold-work'));
}

/** 원문을 쓰는 차례. 표기 틀을 넓혀 원문을 새로 쓰는 것이 둘째 차례(v2)다. 첫 차례의 파일은 작업 폴더 바로 아래에 그대로 있다. */
export const WORK_ROUND = 'v2';

/** 이번 차례의 설계도·묶음·안내·써 온 원문이 놓이는 폴더. 정답 만들기와 조립이 둘 다 이 자리를 쓴다. */
export function roundDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(workDir(env), WORK_ROUND);
}

/**
 * 안 여는 세트의 파일. 저장소 밖에 둔다.
 * SEALED_GOLD_PATH 가 폴더면 그 안의 test.jsonl, 파일이면 그 파일이다. 없으면 홈 아래 chaeum-sealed.
 * 상대 경로이거나 저장소(root) 안이면 OutsidePathError 를 던진다. 실제 자료의 두 파일도 이 자리를 따르므로 함께 막힌다.
 */
export function sealedTestFile(env: NodeJS.ProcessEnv = process.env, root: string = repoRoot()): string {
  const p = fromHome(env.SEALED_GOLD_PATH?.trim() || path.join(os.homedir(), 'chaeum-sealed'));
  return outsideRepo(p.endsWith('.jsonl') ? p : path.join(p, 'test.jsonl'), root);
}

/** 실제 자료 묶음의 파일. 남이 쓴 글이라 원문을 저장소에 넣지 않는다. 안 여는 세트와 같은 폴더에 둔다. */
export function realGoldFile(env: NodeJS.ProcessEnv = process.env, root: string = repoRoot()): string {
  return path.join(path.dirname(sealedTestFile(env, root)), 'real.jsonl');
}

/** 실제 자료를 넣은 기록(모델 초안과 칸별 견줌이 값째로 들어 있다). 원문에서 온 값이라 저장소 밖, 실제 자료 파일 옆에 둔다. */
export function realIntakeFile(env: NodeJS.ProcessEnv = process.env, root: string = repoRoot()): string {
  return path.join(path.dirname(sealedTestFile(env, root)), 'real-intake.jsonl');
}
