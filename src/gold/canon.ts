// 값 안의 열쇠를 가나다순으로 줄 세운다. 순수 함수라 브라우저에서도 돈다(files.ts 는 파일을 읽어 브라우저에 실을 수 없다).

/** DB(jsonb)를 다녀오면 열쇠 순서가 바뀌므로, 견주거나 적기 전에 맞춘다. */
export function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = canon((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}
