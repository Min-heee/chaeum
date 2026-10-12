// DB 시험의 준비(전체에서 한 번). 시험용 DB 에 이행을 적용한다.
import { config } from 'dotenv';
import { migrate } from '../../scripts/migrate';

export default async function setup() {
  config({ path: '.env.local', quiet: true });
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL 이 없다. .env.local 을 확인한다.');
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) throw new Error('시험은 이름이 _test 로 끝나는 DB 에서만 돈다');
  await migrate(url);
}
