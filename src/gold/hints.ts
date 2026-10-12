// 표기 지시 읽기. 정답을 만들 때 "어느 칸의 값을 원문에 어떤 글자로 적을지" 정해 둔 파일(설계도)에서
// 확인 화면이 강조할 조각만 꺼낸다. 서버에서만 읽는다. 화면에는 요청한 문서의 조각만 내려 준다.
// 파일이 없거나 꼴이 다르면 강조 없이 돈다(오류를 내지 않는다).
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isFieldKey, type FieldKey } from '@/contract/fields';

/** 칸 하나의 표기. 화면으로 내려가는 꼴이다. */
export interface FieldHint {
  field: FieldKey;
  /** 원문에 글자 그대로 들어간 조각들 */
  tokens: string[];
  /** 수 옆에 단위를 붙이지 않는 표기에서 그 수의 단위 */
  unit?: string;
  /** 그 단위를 글 다른 곳에 밝혔는가 */
  declareUnit?: boolean;
}

export interface DocHints {
  /** 글 꼴(공지, 메신저 …). 파일에 없으면 null */
  style: string | null;
  hints: FieldHint[];
}

export type HintFile = Map<string, DocHints>;

/** 표기 지시 파일의 자리. LABEL_HINTS_PATH 가 없으면 홈 아래 chaeum-gold-work/v2/specs.json. */
export function hintsPath(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.LABEL_HINTS_PATH?.trim();
  if (!set) return path.join(os.homedir(), 'chaeum-gold-work', 'v2', 'specs.json');
  return set === '~' || set.startsWith('~/') ? path.join(os.homedir(), set.slice(1)) : set;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 파일 글을 읽어 문서 번호 → 표기로 바꾼다. 꼴이 다른 줄은 건너뛴다. 통째로 꼴이 다르면 null. */
export function parseHintFile(text: string): HintFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const specs = isRecord(raw) ? raw.specs : raw;
  if (!Array.isArray(specs)) return null;

  const out: HintFile = new Map();
  for (const spec of specs) {
    if (!isRecord(spec) || typeof spec.id !== 'string') continue;
    const hints: FieldHint[] = [];
    for (const h of Array.isArray(spec.surface_hints) ? spec.surface_hints : []) {
      if (!isRecord(h) || typeof h.field !== 'string' || !isFieldKey(h.field) || !Array.isArray(h.tokens)) continue;
      const tokens = h.tokens.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
      if (tokens.length === 0) continue;
      hints.push({
        field: h.field,
        tokens,
        ...(typeof h.unit === 'string' ? { unit: h.unit } : {}),
        ...(typeof h.declare_unit === 'boolean' ? { declareUnit: h.declare_unit } : {}),
      });
    }
    out.set(spec.id, { style: typeof spec.style === 'string' ? spec.style : null, hints });
  }
  return out;
}

/** 표기 지시 파일을 읽는다. 없거나 못 읽으면 null. */
export async function readHintFile(env: NodeJS.ProcessEnv = process.env): Promise<HintFile | null> {
  try {
    return parseHintFile(await readFile(hintsPath(env), 'utf8'));
  } catch {
    return null;
  }
}

/** 요청한 문서의 조각만 고른다. 파일에 없는 문서는 빠진다. */
export function hintsFor(file: HintFile | null, ids: readonly string[]): Record<string, FieldHint[]> {
  const out: Record<string, FieldHint[]> = {};
  if (!file) return out;
  for (const id of ids) {
    const doc = file.get(id);
    if (doc) out[id] = doc.hints;
  }
  return out;
}
