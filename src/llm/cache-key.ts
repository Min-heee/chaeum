// 장부의 키를 만든다. 같은 요청이면 같은 키, 프롬프트 글·모델·스키마·입력이 바뀌면 다른 키.
import { createHash } from 'node:crypto';

/**
 * 입력을 한 가지 꼴의 JSON 글로 정리한다.
 * - 객체의 키는 이름순으로 적는다(적은 순서가 달라도 같은 글이 된다).
 * - undefined 인 키는 뺀다. 글자는 NFC 로 맞춘다.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sortValue(v)));
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      if (src[key] !== undefined) out[key.normalize('NFC')] = sortValue(src[key]);
    }
    return out;
  }
  return value;
}

export interface CacheKeyParts {
  task: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  /** 시스템 글 전체. 버전 이름을 안 바꾸고 글만 고쳐도 키가 달라지게 한다. */
  system: string;
  /** 모델에게 보내는 답의 꼴(JSON 스키마). 칸을 더하거나 설명을 고치면 달라진다. */
  wireSchema: unknown;
  /** 생각 깊이 설정 */
  effort: string;
  input: unknown;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * sha256(task + model + promptVersion + 스키마 버전 + 시스템 글의 해시 + 보내는 스키마의 해시 + effort + 정리한 입력).
 * 16진수 64자. 모델이 받는 것 가운데 답을 바꿀 수 있는 것은 다 들어간다(최대 토큰 수만 뺀다).
 */
export function cacheKey(parts: CacheKeyParts): string {
  // 조각을 그냥 이어 붙이면 경계가 헷갈릴 수 있어 목록으로 묶어 적는다.
  const joined = JSON.stringify([
    parts.task,
    parts.model,
    parts.promptVersion,
    parts.schemaVersion,
    sha256(parts.system),
    sha256(canonicalJson(parts.wireSchema)),
    parts.effort,
    canonicalJson(parts.input),
  ]);
  return sha256(joined);
}
