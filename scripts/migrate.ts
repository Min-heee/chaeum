// DB 이행. db/migrations 의 .sql 을 번호순으로 한 번씩만 적용한다. 두 번 돌려도 안전하다.
//
//   npm run db:migrate                    DATABASE_URL 에 적용
//   npm run db:migrate -- --target test   TEST_DATABASE_URL 에 적용
//   MIGRATE_DATABASE_URL=… npm run db:migrate   주소를 직접 줌(배포 DB 에 한 번 돌릴 때)
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations');
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/** 아직 적용하지 않은 파일만 번호순으로 적용한다. 파일 하나가 트랜잭션 하나다. */
export async function migrate(connectionString: string, log: (line: string) => void = () => undefined): Promise<MigrateResult> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => FILE_PATTERN.test(f)).sort();
  const client = new Client({ connectionString });
  await client.connect();
  const result: MigrateResult = { applied: [], skipped: [] };

  try {
    // 두 곳에서 동시에 돌려도 한 번에 하나만 적용한다.
    await client.query("SELECT pg_advisory_lock(hashtext('chaeum_migrate'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) {
        result.skipped.push(file);
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`${file} 적용 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
      result.applied.push(file);
      log(`적용: ${file}`);
    }
  } finally {
    await client.end();
  }
  return result;
}

/** 어느 DB 에 돌릴지 정한다. 주소 값은 어디에도 찍지 않는다. */
function pickTarget(argv: string[], env: NodeJS.ProcessEnv): { label: string; url: string } {
  const i = argv.indexOf('--target');
  const target = i >= 0 ? argv[i + 1] : 'main';
  if (target !== 'main' && target !== 'test') throw new Error('--target 은 main 또는 test');

  const name = env.MIGRATE_DATABASE_URL ? 'MIGRATE_DATABASE_URL' : target === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
  const url = env[name];
  if (!url) throw new Error(`${name} 이 없다. .env.local 을 확인한다.`);
  return { label: name, url };
}

async function main() {
  const { label, url } = pickTarget(process.argv.slice(2), process.env);
  const result = await migrate(url, (line) => console.log(line));
  console.log(`[${label}] 새로 적용 ${result.applied.length}개, 이미 적용 ${result.skipped.length}개`);
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
