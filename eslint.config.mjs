import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// 시각과 난수는 인자로 받는다. 판단 코드와 작업 줄에서 직접 부르면 시험에서 시계를 못 돌린다.
const noClockOrDice = [
  { object: 'Date', property: 'now', message: '시각은 인자로 받는다.' },
  { object: 'Math', property: 'random', message: '난수 씨앗은 인자로 받는다.' },
];

const config = [
  // collector/ 는 파이썬 수집기다. 이쪽 도구(타입 검사, 린트, 시험, 빌드)는 그 폴더를 보지 않는다.
  { ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'next-env.d.ts', 'eval/results/**', 'data/**', '.gold-work/**', 'collector/**'] },
  ...nextVitals,
  ...nextTs,
  {
    // src/tools 는 딸린 도구의 판단 코드다. 오늘 날짜도 인자로 받는다.
    files: ['src/core/**/*.ts', 'src/contract/**/*.ts', 'src/tools/**/*.ts', 'src/server/queue.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-properties': ['error', ...noClockOrDice],
      // 인자 없는 new Date() 도 지금 시각을 읽는다.
      'no-restricted-syntax': ['error', { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: '시각은 인자로 받는다.' }],
    },
  },
  {
    // 판단 코드는 DB 와 네트워크를 모른다.
    files: ['src/core/**/*.ts', 'src/contract/**/*.ts', 'src/tools/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: ['pg', '@anthropic-ai/sdk'], patterns: ['@/server/*', '@/llm/*', 'next/*'] },
      ],
    },
  },
];

export default config;
