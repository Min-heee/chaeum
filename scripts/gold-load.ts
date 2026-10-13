// 정답 파일(jsonl)을 DB 표 gold_docs 에 싣는다.
//
//   npm run gold:load                         연습(+ 있으면 손글) 세트를 DATABASE_URL 에
//   npm run gold:load -- --target test        TEST_DATABASE_URL 에
//   npm run gold:load -- --sealed             안 여는 세트도 함께(SEALED_GOLD_PATH 또는 기본 자리에서 읽는다)
//   npm run gold:load -- --real               실제 자료도 함께(저장소 밖의 real.jsonl 과, 넣은 글의 기록 real-intake.jsonl).
//                                             기록에 실린 초안 호출의 답도 장부(llm_calls)에 다시 심는다(없는 것만)
//   npm run gold:load -- --file 길/파일.jsonl   이 파일만(여러 번 쓸 수 있다)
//   npm run gold:load -- --force              버전이 같아도 파일로 덮어쓴다(사람이 고친 정답이 사라진다)
//
// 이미 있는 문서는 파일의 정답 버전이 더 높을 때만 바뀐다. 확인 기록(data/gold/reviews.jsonl)도 있으면 싣는다.
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { argValues, hasFlag, pickDb } from '../src/gold/cli';
import { DEV_FILE, HAND_FILE, REVIEWS_FILE, realGoldFile, realIntakeFile, sealedTestFile } from '../src/gold/paths';
import { loadIntakeDump, parseIntakeDump, seedIntakeCalls } from '../src/gold/real';
import { PgLlmCallStore } from '../src/server/repos/llm-calls';
import { syncFiles } from '../src/gold/sync';

async function main() {
  const argv = process.argv.slice(2);
  const { label, url } = pickDb(argv, process.env);
  const sealed = sealedTestFile();

  const picked = argValues(argv, '--file');
  const real = realGoldFile();
  const withReal = picked.length === 0 && hasFlag(argv, '--real');
  const files = picked.length > 0 ? picked : [DEV_FILE, HAND_FILE, ...(hasFlag(argv, '--sealed') ? [sealed] : []), ...(withReal ? [real] : [])];

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    const report = await syncFiles(client, files, picked.length > 0 ? null : REVIEWS_FILE, { force: hasFlag(argv, '--force') });
    // 실제 자료를 넣은 기록(모델 초안)은 그 문서가 실린 뒤에 싣는다. 파일이 없으면 건너뛴다.
    let intakes: number | null = null;
    let seeded = 0;
    if (withReal) {
      const text = await readFile(realIntakeFile(), 'utf8').catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : Promise.reject(err)));
      if (text !== null) {
        const lines = parseIntakeDump(text);
        intakes = await loadIntakeDump(client, lines);
        // 초안을 만든 호출의 답을 장부에 다시 심는다. 안 심으면 real 평가가 그 글을 다시 불러 사람이 본 것과 다른 답을 채점할 수 있다.
        seeded = await seedIntakeCalls(new PgLlmCallStore({ db: client as never }), lines);
      }
    }
    await client.query('COMMIT');
    if (withReal) console.log(intakes === null ? `[${label}] 실제 자료를 넣은 기록: 파일이 없어 건너뜀` : `[${label}] 실제 자료를 넣은 기록 ${intakes}줄을 실었다(장부에 심은 초안 호출의 답 ${seeded}건)`);
    for (const f of report.files) {
      // 저장소 밖 파일의 길은 찍지 않는다.
      const name = f.file === sealed ? '안 여는 세트 파일' : f.file === real ? '실제 자료 파일' : f.file;
      if (!f.found) console.log(`[${label}] ${name}: 파일이 없어 건너뜀`);
      else console.log(`[${label}] ${name}: ${f.docs}건 (새로 ${f.result?.inserted}, 바뀜 ${f.result?.updated}, 그대로 ${f.result?.skipped})`);
    }
    if (report.reviews > 0) console.log(`[${label}] 확인 기록 ${report.reviews}줄을 실었다`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
