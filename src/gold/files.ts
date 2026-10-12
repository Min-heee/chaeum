// 정답 파일 읽기·쓰기(jsonl: 한 줄에 한 건)와 해시.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FIELDS_BY_TYPE } from '@/contract/fields';
import { GoldDocSchema, type GoldDoc } from '@/contract/eval-types';

/** 값 안의 열쇠를 가나다순으로 줄 세운다. DB(jsonb)를 다녀오면 열쇠 순서가 바뀌므로, 견주거나 적기 전에 맞춘다. */
export function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = canon((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/** 줄마다 같은 순서로 적는다. 같은 정답이면 같은 글자가 나와야 해시가 뜻이 있다. */
export function docToLine(doc: GoldDoc): string {
  const fields: Record<string, unknown> = {};
  for (const k of FIELDS_BY_TYPE[doc.truth.type]) fields[k] = canon(doc.truth.fields[k] ?? null);
  return JSON.stringify({
    id: doc.id,
    split: doc.split,
    goldVersion: doc.goldVersion,
    author: doc.author,
    ...(doc.style ? { style: doc.style } : {}),
    traps: doc.traps,
    content: doc.content,
    truth: { type: doc.truth.type, subtype: doc.truth.subtype, fields },
  });
}

export function docsToJsonl(docs: readonly GoldDoc[]): string {
  return [...docs].sort((a, b) => a.id.localeCompare(b.id)).map((d) => `${docToLine(d)}\n`).join('');
}

/** jsonl 글을 읽어 스키마로 검사한다. 한 줄이라도 틀리면 멈춘다. */
export function parseJsonl(text: string, label = 'jsonl'): GoldDoc[] {
  const docs: GoldDoc[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`${label} ${i + 1}번째 줄: JSON 이 아니다`);
    }
    const parsed = GoldDocSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new Error(`${label} ${i + 1}번째 줄: ${first?.path.join('.')} ${first?.message}`);
    }
    docs.push(parsed.data);
  });
  const ids = new Set<string>();
  for (const d of docs) {
    if (ids.has(d.id)) throw new Error(`${label}: 번호가 겹친다: ${d.id}`);
    ids.add(d.id);
  }
  return docs;
}

/** 파일이 없으면 null. */
export async function readJsonlFile(file: string): Promise<GoldDoc[] | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return parseJsonl(text, path.basename(file));
}

export async function writeJsonlFile(file: string, docs: readonly GoldDoc[]): Promise<string> {
  const text = docsToJsonl(docs);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
  return text;
}

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** sha256sum 이 읽는 꼴 한 줄. */
export const hashLine = (text: string, name = 'test.jsonl') => `${sha256(text)}  ${name}\n`;
