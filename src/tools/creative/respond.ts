// 시안 검사의 응답을 짓는다. 경로 파일이 얇게 남도록 여기에 둔다(DB 도 요청도 모른다).
import type { ApiErrorCode } from '@/contract/api';
import { cleanOriginName } from '@/contract/pipeline-api';
import type { ProductType } from '@/contract/fields';
import { CREATIVE_LIMITS, type CreativeCheckResponse, type CreativeFacts, type CreativeReadResult } from '@/contract/tools/creative';
import { checkCreative } from './check';
import type { Rotation } from './mp4';
import { readCreative, type CreativeRead } from './read';

/** 파일을 견주지 못하는 까닭 넷. 앞의 셋은 읽다가, 마지막은 읽기 전에(크기) 안다. */
export type CreativeProblem = Extract<CreativeReadResult, { ok: false }>['problem'] | 'too_large';

/** 파일을 읽지 못했을 때 사람에게 보이는 말. 서버의 오류 본문과 화면이 같은 말을 쓴다. */
export const CREATIVE_PROBLEM_MESSAGES: Record<CreativeProblem, string> = {
  empty: '파일이 비었습니다.',
  unsupported: 'JPG, PNG, WEBP 그림이나 MP4 영상만 볼 수 있습니다. 형식은 파일 이름이 아니라 내용으로 정합니다.',
  unreadable:
    '파일에서 가로·세로를 읽지 못했습니다. 파일이 중간에 잘렸거나 깨졌거나, 영상이 들어 있지 않은 파일일 수 있습니다. 값을 짐작해 내지는 않습니다.',
  too_large: `서버로 올리는 파일은 ${CREATIVE_LIMITS.fileMaxBytes / (1024 * 1024)}MB까지입니다. 더 큰 파일은 읽은 값(facts)만 JSON 으로 보내 주세요.`,
};

/** 까닭마다의 오류 코드. 상태 번호는 약속의 표(API_ERRORS)가 정한다: 400 · 415 · 422 · 413. */
export const CREATIVE_PROBLEM_CODES: Record<CreativeProblem, ApiErrorCode> = {
  empty: 'BAD_INPUT',
  unsupported: 'UNSUPPORTED_FILE',
  unreadable: 'UNREADABLE_FILE',
  too_large: 'FILE_TOO_LARGE',
};

/** 서버로 올라온 파일 하나를 읽는다. 머리를 읽기 전에 크기부터 본다. */
export function readUploadedCreative(bytes: Uint8Array): CreativeRead | { ok: false; problem: 'too_large' } {
  if (bytes.length > CREATIVE_LIMITS.fileMaxBytes) return { ok: false, problem: 'too_large' };
  return readCreative(bytes);
}

/** 견줄 상품에서 쓰는 것. 저장 층의 상품 줄이 이 꼴을 채운다. */
export interface CreativeProduct {
  id: number;
  name: string;
  type: ProductType;
  subtype: string;
  spec: Record<string, unknown>;
}

export interface CreativeCheckInput {
  facts: CreativeFacts;
  /** 누가 파일을 읽었나. client 면 서버는 파일을 보지 못했다. */
  readBy: 'server' | 'client';
  fileName?: string | null;
  /** 서버가 읽었을 때만 안다. 화면이 읽은 값만 보낸 길에서는 비어 있다(약속의 사실 꼴에 회전이 없다). */
  rotation?: Rotation;
  /** 파일 전체의 길이(초). 서버가 읽었고 영상 트랙보다 길 때만 있다. */
  wholeSeconds?: number;
}

/** 상품의 규격과 읽은 사실로 응답을 짓는다. 파일도 결과도 저장하지 않는다(stored 는 늘 거짓). */
export function creativeCheckResponse(product: CreativeProduct, input: CreativeCheckInput): CreativeCheckResponse {
  const name = cleanOriginName(input.fileName);
  const { items, verdict } = checkCreative(input.facts, product.spec, { fileName: name, rotation: input.rotation, wholeSeconds: input.wholeSeconds });
  return {
    product: { id: product.id, name: product.name, type: product.type, subtype: product.subtype },
    file: { ...input.facts, name },
    readBy: input.readBy,
    items,
    verdict,
    stored: false,
  };
}
