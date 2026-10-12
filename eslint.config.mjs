import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// 시각과 난수는 인자로 받는다. 판단 코드와 작업 줄에서 직접 부르면 시험에서 시계를 못 돌린다.
const noClockOrDice = [
  { object: 'Date', property: 'now', message: '시각은 인자로 받는다.' },
  { object: 'Math', property: 'random', message: '난수 씨앗은 인자로 받는다.' },
];

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'next-env.d.ts', 'eval/results/**', 'data/**'] },
  ...nextVitals,
  ...nextTs,
  {
    files: ['src/core/**/*.ts', 'src/contract/**/*.ts', 'src/server/queue.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-properties': ['error', ...noClockOrDice] },
  },
  {
    // 판단 코드는 DB 와 네트워크를 모른다.
    files: ['src/core/**/*.ts', 'src/contract/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: ['pg', '@anthropic-ai/sdk'], patterns: ['@/server/*', '@/llm/*', 'next/*'] },
      ],
    },
  },
];

export default config;
