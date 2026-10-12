// 정답 만들기. 정답이 먼저고 원문은 나중이다.
//
//   npm run gold:gen                     정답 100건의 설계도와 묶음 4개, 안내 글을 작업 폴더에 쓴다
//                                        (작업 폴더는 저장소 밖이다: GOLD_WORK_DIR, 없으면 홈 아래 chaeum-gold-work)
//   npm run gold:gen -- --seed 7         씨앗을 바꿔서
//   npm run gold:gen -- assemble         써 온 원문(작업 폴더의 out)과 정답을 합쳐 정답 파일을 만든다
//                                        연습 40건 → data/gold/dev.jsonl
//                                        안 여는 60건 → 저장소 밖(SEALED_GOLD_PATH), 해시만 data/gold/test.sha256
//   npm run gold:gen -- assemble --keep-work   작업 폴더를 안 여는 세트 옆으로 옮기지 않는다
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assemble, readWritten, writeAssembled } from '../src/gold/assemble';
import { batchInputName, splitBatches, writerGuide } from '../src/gold/batches';
import { argValue, hasFlag } from '../src/gold/cli';
import { generateSpecs } from '../src/gold/generate';
import { DEV_FILE, TEST_HASH_FILE, sealedTestFile, workDir } from '../src/gold/paths';
import { DEFAULT_SEED, type GoldSpec } from '../src/gold/spec';

const WORK_DIR = workDir();
const SPECS_FILE = path.join(WORK_DIR, 'specs.json');
const GUIDE_FILE = path.join(WORK_DIR, 'WRITER-GUIDE.md');

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

  const count = (pred: (s: GoldSpec) => boolean) => specs.filter(pred).length;
  console.log(`씨앗 ${seed}: 정답 ${specs.length}건 (연습 ${count((s) => s.split === 'dev')}, 안 여는 세트 ${count((s) => s.split === 'test')})`);
  console.log(`종류: 광고 지면 ${count((s) => s.type === 'ad')}, 케이터링 ${count((s) => s.type === 'catering')}, 굿즈 ${count((s) => s.type === 'goods')}, 등록 대상 아님 ${count((s) => s.type === 'not_product')}`);
  console.log(`묶음 ${batches.length}개(${batches.map((b) => b.docs.length).join(', ')}건)와 안내 글을 작업 폴더(저장소 밖)에 썼다`);
}

/** 작업 폴더에는 안 여는 세트의 정답과 원문이 들어 있다. 조립이 끝나면 안 여는 세트 옆으로 옮긴다. */
async function moveWorkOut(sealedDir: string): Promise<string> {
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
    await rename(WORK_DIR, target);
  } catch {
    // 다른 디스크면 이름 바꾸기가 안 된다. 복사한 뒤 지운다.
    await cp(WORK_DIR, target, { recursive: true });
    await rm(WORK_DIR, { recursive: true });
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
  else await writeSpecs(argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
