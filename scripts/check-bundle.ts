// 빌드 뒤 검사: 브라우저로 가는 코드(.next/static)에 키 이름이나 키처럼 생긴 글자가 없는지 본다.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const STATIC_DIR = path.resolve('.next/static');
const FORBIDDEN = [/ANTHROPIC_/, /sk-ant-/, /postgres(ql)?:\/\//];

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function main() {
  const exists = await stat(STATIC_DIR).then(() => true, () => false);
  if (!exists) {
    console.error('.next/static 이 없다. 먼저 npm run build 를 돌린다.');
    process.exit(1);
  }
  const files = await walk(STATIC_DIR);
  const hits: string[] = [];
  for (const file of files) {
    const body = await readFile(file, 'utf8');
    for (const pattern of FORBIDDEN) {
      if (pattern.test(body)) hits.push(`${path.relative('.', file)} ← ${pattern.source}`);
    }
  }
  if (hits.length > 0) {
    console.error('브라우저로 가는 코드에 비밀 값의 흔적이 있다:');
    for (const hit of hits) console.error(`  ${hit}`);
    process.exit(1);
  }
  console.log(`브라우저 코드 ${files.length}개 파일에 비밀 값의 흔적 없음`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
