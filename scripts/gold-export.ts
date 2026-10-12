// DB 에 있는 정답(사람이 확인하며 고친 것)을 파일로 되돌려 쓴다.
//
//   npm run gold:export                       DB 에 있는 묶음 전부
//   npm run gold:export -- --split dev        한 묶음만(dev | test | hand, 쉼표로 여러 개)
//   npm run gold:export -- --target test      TEST_DATABASE_URL 에서
//
// - 파일과 달라진 문서가 하나라도 있으면 그 묶음의 정답 버전을 하나 올린다(파일과 DB 둘 다).
// - 연습·손글은 data/gold/ 에, 안 여는 세트는 저장소 밖(SEALED_GOLD_PATH)에 쓰고 해시만 data/gold/test.sha256 에 남긴다.
// - 확인 기록(판정, 고친 칸 수, 걸린 초)은 data/gold/reviews.jsonl 에 쓴다. 원문은 들어가지 않는다.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { GOLD_SPLITS, type GoldSplit } from '../src/contract/eval-types';
import { argValue, pickDb } from '../src/gold/cli';
import { hashLine, readJsonlFile, writeJsonlFile } from '../src/gold/files';
import { DEV_FILE, HAND_FILE, REVIEWS_FILE, TEST_HASH_FILE, realGoldFile, sealedTestFile } from '../src/gold/paths';
import { listDocs, listReviews, planExport, setSplitVersion } from '../src/gold/store';

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
    const reviews = await listReviews(client);
    await mkdir(path.dirname(REVIEWS_FILE), { recursive: true });
    await writeFile(REVIEWS_FILE, reviews.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
    console.log(`[${label}] 확인 기록 ${reviews.length}줄 → ${REVIEWS_FILE}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
