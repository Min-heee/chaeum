// DB 에 있는 정답(사람이 확인하며 고친 것)을 파일로 되돌려 쓴다.
//
//   npm run gold:export                       DB 에 있는 묶음 전부
//   npm run gold:export -- --split dev        한 묶음만(dev | test | hand, 쉼표로 여러 개)
//   npm run gold:export -- --target test      TEST_DATABASE_URL 에서
//
// - 파일과 달라진 문서가 하나라도 있으면 그 묶음의 정답 버전을 하나 올린다(파일과 DB 둘 다).
// - 연습·손글은 data/gold/ 에, 안 여는 세트는 저장소 밖(SEALED_GOLD_PATH)에 쓰고 해시만 data/gold/test.sha256 에 남긴다.
// - 확인 기록(판정, 고친 칸 수, 걸린 초)은 data/gold/reviews.jsonl 에 쓴다. 원문은 들어가지 않는다.
// - 실제 자료(real): 원문은 저장소 밖의 real.jsonl 로만 간다. 저장소에는 출처 목록(real-sources.json: 주소·받은 날짜·종류)과
//   사람이 칸마다 한 일의 셈(real-edits.json: 값 없음)만 쓴다. 모델 초안과 칸별 값, 그 초안을 만든 호출의 답(장부 줄)은 저장소 밖의 real-intake.jsonl 로 간다.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { GOLD_SPLITS, type GoldSplit } from '../src/contract/eval-types';
import { argValue, pickDb } from '../src/gold/cli';
import { hashLine, readJsonlFile, writeJsonlFile } from '../src/gold/files';
import { tallyLine } from '../src/gold/origins';
import { DEV_FILE, HAND_FILE, REAL_EDITS_FILE, REAL_SOURCES_FILE, REVIEWS_FILE, TEST_HASH_FILE, realGoldFile, realIntakeFile, sealedTestFile } from '../src/gold/paths';
import { dumpIntakes, realEdits, realSources } from '../src/gold/real';
import { listDocs, listReviews, planExport, setSplitVersion } from '../src/gold/store';
import { PgLlmCallStore } from '../src/server/repos/llm-calls';

async function main() {
  const argv = process.argv.slice(2);
  const { label, url } = pickDb(argv, process.env);
  const wanted = (argValue(argv, '--split') ?? GOLD_SPLITS.join(',')).split(',') as GoldSplit[];
  for (const s of wanted) if (!GOLD_SPLITS.includes(s)) throw new Error(`모르는 묶음: ${s}`);
  const fileOf: Record<GoldSplit, string> = { dev: DEV_FILE, hand: HAND_FILE, test: sealedTestFile(), real: realGoldFile() };

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const split of wanted) {
      const dbDocs = await listDocs(client, split);
      if (dbDocs.length === 0) {
        console.log(`[${label}] ${split}: DB 에 문서가 없어 건너뜀`);
        continue;
      }
      const plan = planExport(await readJsonlFile(fileOf[split]), dbDocs);
      const text = await writeJsonlFile(fileOf[split], plan.docs);
      await setSplitVersion(client, split, plan.version);
      if (split === 'test') await writeFile(TEST_HASH_FILE, hashLine(text), 'utf8');
      console.log(`[${label}] ${split}: ${plan.docs.length}건, 정답 버전 ${plan.version}, 파일과 달라진 문서 ${plan.changed.length}건`);
    }
    if (wanted.includes('real')) await exportRealRecords(client, label);
    const reviews = await listReviews(client);
    await mkdir(path.dirname(REVIEWS_FILE), { recursive: true });
    await writeFile(REVIEWS_FILE, reviews.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
    console.log(`[${label}] 확인 기록 ${reviews.length}줄 → ${REVIEWS_FILE}`);
  } finally {
    await client.end();
  }
}

/** 실제 자료를 넣은 기록. 넣은 글의 표(이행 0006)가 없거나 비었으면 아무것도 쓰지 않는다. */
async function exportRealRecords(client: Client, label: string) {
  let lines;
  try {
    lines = await dumpIntakes(client, new PgLlmCallStore({ db: client as never }));
  } catch (err) {
    if ((err as { code?: string }).code !== '42P01') throw err;
    console.log(`[${label}] real: 넣은 글의 표가 없다(npm run db:migrate). 출처 목록을 쓰지 않았다`);
    return;
  }
  if (lines.length === 0) return;
  const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(REAL_SOURCES_FILE), { recursive: true });
  await writeFile(REAL_SOURCES_FILE, pretty(await realSources(client)), 'utf8');
  const edits = await realEdits(client);
  await writeFile(REAL_EDITS_FILE, pretty(edits), 'utf8');
  // 값이 든 줄은 저장소 밖으로만.
  const outside = realIntakeFile();
  await mkdir(path.dirname(outside), { recursive: true });
  await writeFile(outside, lines.map((l) => `${JSON.stringify(l)}\n`).join(''), 'utf8');
  console.log(`[${label}] real: 출처 ${lines.filter((l) => l.status !== 'open').length}건 → ${REAL_SOURCES_FILE}, 사람이 한 일의 셈 → ${REAL_EDITS_FILE}, 넣은 글의 기록 ${lines.length}줄(초안 호출의 답 ${lines.filter((l) => l.call).length}건 포함) → (저장소 밖)`);
  console.log(`[${label}] real: ${tallyLine(edits.tally)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
