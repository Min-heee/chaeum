// 정답 만들기. 정답이 먼저고 원문은 나중이다.
//
//   npm run gold:gen                     정답 100건의 설계도와 묶음 4개, 안내 글, 칸별 꼴 분포표를 이번 차례의 작업 폴더에 쓴다
//                                        (작업 폴더는 저장소 밖이다: GOLD_WORK_DIR, 없으면 홈 아래 chaeum-gold-work. 이번 차례는 그 안의 v2)
//   npm run gold:gen -- --seed 7         씨앗을 바꿔서
//   npm run gold:gen -- check-truth 파일   떠 둔 정답(파일)과 지금 생성기의 정답이 100건 모두 같은지 견준다. 읽기만 한다
//   npm run gold:gen -- assemble         써 온 원문(이번 차례 작업 폴더의 out/batch-N.json)과 정답을 합쳐 정답 파일을 만든다
//                                        연습 40건 → data/gold/dev.jsonl
//                                        안 여는 60건 → 저장소 밖(SEALED_GOLD_PATH), 해시만 data/gold/test.sha256
//   npm run gold:gen -- assemble --keep-work   작업 폴더를 안 여는 세트 옆으로 옮기지 않는다
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assemble, readWritten, writeAssembled } from '../src/gold/assemble';
import { GUIDE_NAME, batchInputName, splitBatches, writerGuide } from '../src/gold/batches';
import { argValue, hasFlag } from '../src/gold/cli';
import { canon } from '../src/gold/files';
import { generateSpecs } from '../src/gold/generate';
import { DEV_FILE, TEST_HASH_FILE, roundDir, sealedTestFile, workDir } from '../src/gold/paths';
import { formsReport, summarizeForms } from '../src/gold/report';
import { DEFAULT_SEED, type GoldSpec } from '../src/gold/spec';

/** 이번 차례의 폴더. 설계도·묶음·안내·써 온 원문이 모두 여기 있다. */
const WORK_DIR = roundDir();
const SPECS_FILE = path.join(WORK_DIR, 'specs.json');
const GUIDE_FILE = path.join(WORK_DIR, GUIDE_NAME);
const REPORT_FILE = path.join(WORK_DIR, 'forms-report.md');

/** 표기를 바꿔도 달라지면 안 되는 것 */
const FROZEN_KEYS = ['id', 'split', 'type', 'subtype', 'style', 'traps', 'truth'] as const;

async function writeSpecs(argv: string[]) {
  const seedText = argValue(argv, '--seed');
  const seed = seedText === undefined ? DEFAULT_SEED : Number(seedText);
  if (!Number.isInteger(seed)) throw new Error('--seed 는 정수');

  const specs = generateSpecs(seed);
  await mkdir(path.join(WORK_DIR, 'out'), { recursive: true });
  await writeFile(SPECS_FILE, `${JSON.stringify({ seed, specs }, null, 1)}\n`, 'utf8');
  const batches = splitBatches(specs, WORK_DIR);
  for (const b of batches) {
    await writeFile(path.join(WORK_DIR, batchInputName(b.batch)), `${JSON.stringify(b, null, 1)}\n`, 'utf8');
  }
  await writeFile(GUIDE_FILE, writerGuide(WORK_DIR), 'utf8');
  await writeFile(REPORT_FILE, formsReport(specs, seed), 'utf8');

  const count = (pred: (s: GoldSpec) => boolean) => specs.filter(pred).length;
  console.log(`씨앗 ${seed}: 정답 ${specs.length}건 (연습 ${count((s) => s.split === 'dev')}, 안 여는 세트 ${count((s) => s.split === 'test')})`);
  console.log(`종류: 광고 지면 ${count((s) => s.type === 'ad')}, 케이터링 ${count((s) => s.type === 'catering')}, 굿즈 ${count((s) => s.type === 'goods')}, 등록 대상 아님 ${count((s) => s.type === 'not_product')}`);
  console.log(`묶음 ${batches.length}개(${batches.map((b) => b.docs.length).join(', ')}건)와 안내 글, 꼴 분포표를 작업 폴더(저장소 밖)에 썼다`);
  for (const f of summarizeForms(specs)) {
    console.log(`  ${f.field}: 문서 ${f.dev + f.test}건, 쓴 꼴 ${f.used}가지(마련 ${f.defined}), 가장 많은 꼴 ${f.top}건(상한 ${f.cap}), 안 여는 세트에만 ${f.testOnly}가지`);
  }
}

/** 떠 둔 정답과 지금 생성기의 정답을 건마다 견준다. 값은 찍지 않고 번호와 달라진 열쇠만 찍는다. */
async function checkTruth(argv: string[]) {
  const file = argv[0];
  if (!file) throw new Error('견줄 파일을 준다: check-truth 길/파일.json');
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
  const before = (Array.isArray(raw) ? raw : (raw as { specs: unknown[] }).specs) as Record<string, unknown>[];
  const seedText = argValue(argv, '--seed');
  const now = new Map(generateSpecs(seedText === undefined ? DEFAULT_SEED : Number(seedText)).map((s) => [s.id, s as unknown as Record<string, unknown>]));
  const same = (a: unknown, b: unknown) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));
  let differ = 0;
  for (const b of before) {
    const n = now.get(b.id as string);
    const keys = n ? FROZEN_KEYS.filter((k) => !same(b[k], n[k])) : ['(지금은 없는 번호)'];
    if (keys.length > 0) {
      differ += 1;
      console.log(` - ${String(b.id)}: ${keys.join(', ')}`);
    }
  }
  const missing = [...now.keys()].filter((id) => !before.some((b) => b.id === id));
  for (const id of missing) console.log(` - ${id}: (떠 둔 파일에 없는 번호)`);
  console.log(`견준 것: ${FROZEN_KEYS.join(', ')}`);
  console.log(`떠 둔 정답 ${before.length}건 가운데 같은 건 ${before.length - differ}건, 다른 건 ${differ + missing.length}건`);
  if (differ + missing.length > 0) process.exit(1);
}

/** 작업 폴더(모든 차례)에는 안 여는 세트의 정답과 원문이 들어 있다. 조립이 끝나면 통째로 안 여는 세트 옆으로 옮긴다. */
async function moveWorkOut(sealedDir: string): Promise<string> {
  const base = workDir();
  let target = path.join(sealedDir, 'work');
  for (let n = 2; ; n += 1) {
    try {
      await stat(target);
      target = path.join(sealedDir, `work-${n}`);
    } catch {
      break;
    }
  }
  try {
    await rename(base, target);
  } catch {
    // 다른 디스크면 이름 바꾸기가 안 된다. 복사한 뒤 지운다.
    await cp(base, target, { recursive: true });
    await rm(base, { recursive: true });
  }
  return target;
}

async function runAssemble(argv: string[]) {
  const { specs } = JSON.parse(await readFile(SPECS_FILE, 'utf8')) as { specs: GoldSpec[] };
  const { written, problems: readProblems } = await readWritten(WORK_DIR);
  const { docs, problems } = assemble(specs, written);
  const all = [...readProblems, ...problems];
  if (all.length > 0) {
    // 안 여는 세트의 원문은 화면에 찍지 않는다. 번호와 까닭만 찍는다.
    console.error(`고칠 것 ${all.length}개. 파일을 쓰지 않았다.`);
    for (const p of all) console.error(` - ${p}`);
    process.exit(1);
  }
  const sealedFile = sealedTestFile();
  const result = await writeAssembled(docs, { devFile: DEV_FILE, sealedFile, hashFile: TEST_HASH_FILE });
  console.log(`연습 ${result.dev}건 → ${DEV_FILE}`);
  console.log(`안 여는 세트 ${result.test}건 → 저장소 밖. 해시 → ${TEST_HASH_FILE}`);
  if (!hasFlag(argv, '--keep-work')) {
    await moveWorkOut(path.dirname(sealedFile));
    console.log('작업 폴더를 안 여는 세트 옆으로 옮겼다');
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'assemble') await runAssemble(argv.slice(1));
  else if (argv[0] === 'check-truth') await checkTruth(argv.slice(1));
  else await writeSpecs(argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
