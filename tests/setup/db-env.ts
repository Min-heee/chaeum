// DB 시험의 준비(시험 파일마다). 앱이 읽는 주소를 시험용 DB 로 바꾼다.
import { config } from 'dotenv';

config({ path: '.env.local', quiet: true });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL 이 없다. .env.local 을 확인한다.');

// 이름이 _test 로 끝나는 DB 에서만 돈다. 시험이 진짜 자료를 지우는 일을 막는다.
const dbName = new URL(url).pathname.replace(/^\//, '');
if (!/_test(_[a-z0-9]+)?$/.test(dbName)) throw new Error('시험은 이름이 _test 로 끝나는 DB 에서만 돈다(_test_b 처럼 꼬리가 하나 더 붙은 것도 된다)');

process.env.DATABASE_URL = url;
