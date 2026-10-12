// 조립: 정답 설계도 + 써 온 원문 → 정답 문서. 연습 40건은 저장소에, 안 여는 60건은 저장소 밖에 둔다.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GoldDocSchema, type GoldDoc } from '@/contract/eval-types';
import { BATCH_COUNT, batchOutputName, batchOutputPath } from './batches';
import { hashLine, writeJsonlFile } from './files';
import type { GoldSpec } from './spec';

export const CONTENT_MIN = 100;
export const CONTENT_MAX = 900;
/** 조립이 쓰는 정답 버전. 1판은 좁은 표기 틀의 원문, 2판은 표기 틀을 넓혀 원문을 새로 쓴 것이다(정답 값은 같다). DB 는 버전이 높을 때만 바뀐다. */
export const GOLD_VERSION = 2;

export interface WrittenDoc {
  id: string;
  content: string;
}

export interface AssembleResult {
  docs: GoldDoc[];
  /** 고쳐야 하는 것. 비어 있어야 파일을 쓴다. */
  problems: string[];
}

/** 설계도와 원문을 짝지어 정답 문서를 만든다. 원문이 약속을 어겼으면 problems 에 적는다. */
export function assemble(specs: readonly GoldSpec[], written: readonly WrittenDoc[]): AssembleResult {
  const problems: string[] = [];
  const byId = new Map<string, string>();
  const known = new Set(specs.map((s) => s.id));
  for (const w of written) {
    if (!known.has(w.id)) problems.push(`${w.id}: 설계도에 없는 번호`);
    else if (byId.has(w.id)) problems.push(`${w.id}: 원문이 두 번 왔다`);
    else byId.set(w.id, w.content);
  }

  const docs: GoldDoc[] = [];
  for (const spec of specs) {
    const content = byId.get(spec.id)?.trim();
    if (!content) {
      problems.push(`${spec.id}: 원문이 없다`);
      continue;
    }
    const length = [...content].length;
    if (length < CONTENT_MIN || length > CONTENT_MAX) problems.push(`${spec.id}: 길이 ${length}자(${CONTENT_MIN}~${CONTENT_MAX}자여야 한다)`);
    for (const hint of spec.surface_hints) {
      for (const token of hint.tokens) {
        if (!content.includes(token)) problems.push(`${spec.id}: "${hint.label}"의 표기 "${token}"이 원문에 없다`);
      }
    }
    for (const sentence of spec.must_include) {
      if (!content.includes(sentence)) problems.push(`${spec.id}: 넣기로 한 문장이 원문에 없다`);
    }

    const doc: GoldDoc = {
      id: spec.id,
      split: spec.split,
      goldVersion: GOLD_VERSION,
      content,
      truth: { type: spec.type, subtype: spec.subtype, fields: spec.truth },
      author: 'ai',
      traps: spec.traps,
      style: spec.style,
    };
    const parsed = GoldDocSchema.safeParse(doc);
    if (!parsed.success) problems.push(`${spec.id}: 정답의 꼴이 약속과 다르다(${parsed.error.issues[0]?.message})`);
    else docs.push(parsed.data);
  }
  return { docs, problems };
}

/** 묶음별 원문 파일을 읽는다(묶음 파일의 output_path 와 같은 자리). 없는 파일은 problems 에 적는다. */
export async function readWritten(workDir: string): Promise<{ written: WrittenDoc[]; problems: string[] }> {
  const written: WrittenDoc[] = [];
  const problems: string[] = [];
  for (let n = 1; n <= BATCH_COUNT; n += 1) {
    const file = batchOutputPath(workDir, n);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      problems.push(`${batchOutputName(n)}: 파일이 없거나 JSON 이 아니다`);
      continue;
    }
    if (!Array.isArray(raw)) {
      problems.push(`${batchOutputName(n)}: 배열이 아니다`);
      continue;
    }
    for (const item of raw as unknown[]) {
      const w = item as Partial<WrittenDoc>;
      if (typeof w?.id === 'string' && typeof w.content === 'string') written.push({ id: w.id, content: w.content });
      else problems.push(`${batchOutputName(n)}: {id, content} 꼴이 아닌 것이 있다`);
    }
  }
  return { written, problems };
}

export interface AssembleFiles {
  devFile: string;
  sealedFile: string;
  hashFile: string;
}

/** 정답 문서를 파일로 쓴다. 안 여는 세트는 저장소 밖에 쓰고 해시만 저장소에 남긴다. */
export async function writeAssembled(docs: readonly GoldDoc[], files: AssembleFiles): Promise<{ dev: number; test: number; hash: string }> {
  const dev = docs.filter((d) => d.split === 'dev');
  const test = docs.filter((d) => d.split === 'test');
  await writeJsonlFile(files.devFile, dev);
  const testText = await writeJsonlFile(files.sealedFile, test);
  const line = hashLine(testText);
  await mkdir(path.dirname(files.hashFile), { recursive: true });
  await writeFile(files.hashFile, line, 'utf8');
  return { dev: dev.length, test: test.length, hash: line.slice(0, 64) };
}
