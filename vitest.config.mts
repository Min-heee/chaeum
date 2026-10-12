import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

// 시험을 둘로 가른다.
// unit: DB 없이 도는 시험.  db: 시험용 PostgreSQL(이름이 _test 로 끝나는 DB)이 필요한 시험.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'eval/**/*.test.ts', 'tests/unit/**/*.test.ts'],
          // 이름이 .db.test.ts 로 끝나면 DB 가 필요한 시험이다. 아래 db 쪽에서 돈다.
          // collector/ 는 파이썬 수집기다(pytest 가 본다).
          exclude: ['**/node_modules/**', '**/collector/**', '**/*.db.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'db',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts', 'tests/api/**/*.test.ts', 'src/**/*.db.test.ts', 'eval/**/*.db.test.ts'],
          exclude: ['**/node_modules/**', '**/collector/**'],
          globalSetup: ['tests/setup/db-global.ts'],
          setupFiles: ['tests/setup/db-env.ts'],
          // 같은 DB 를 함께 쓰므로 파일을 차례로 돌린다.
          fileParallelism: false,
          testTimeout: 20_000,
        },
      },
    ],
  },
});
