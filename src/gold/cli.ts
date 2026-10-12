// 정답 스크립트 셋이 함께 쓰는 작은 도구.

/** "--이름 값" 꼴에서 값을 읽는다. 없으면 undefined. */
export function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

/** "--이름 값" 이 여러 번 올 때 전부. */
export function argValues(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    const value = argv[i + 1];
    if (a === name && value && !value.startsWith('--')) out.push(value);
  });
  return out;
}

export const hasFlag = (argv: readonly string[], name: string) => argv.includes(name);

/** 어느 DB 에 할지 정한다. 주소 값은 어디에도 찍지 않는다. */
export function pickDb(argv: readonly string[], env: NodeJS.ProcessEnv): { label: string; url: string } {
  const target = argValue(argv, '--target') ?? 'main';
  if (target !== 'main' && target !== 'test') throw new Error('--target 은 main 또는 test');
  const label = target === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
  const url = env[label];
  if (!url) throw new Error(`${label} 이 없다. .env.local 을 확인한다.`);
  return { label, url };
}
