// 경로 파일이 함께 쓰는 것: 오류를 약속의 본문으로 바꾸기, 요청 읽기, 공간 헤더 읽기.
// 판단은 여기에 없다. 입력의 꼴만 보고 src/server 의 묶음 함수에 넘긴다.
import { NextResponse } from 'next/server';
import { ZodError, type ZodType } from 'zod';
import { API_ERRORS, WORKSPACE_HEADER, type ApiErrorBody } from '@/contract/api';
import { AppError, isAppError } from '@/server/errors';
import { parseWorkspaceId, workspaceForRead } from '@/server/workspace';

/** JSON 요청 본문의 상한(바이트). 여러 건 50건 × 글 4,000자가 들어가고도 남는다. */
export const JSON_BODY_MAX_BYTES = 1024 * 1024;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function errorResponse(body: ApiErrorBody): NextResponse {
  return json(body, API_ERRORS[body.code]);
}

/** 어느 칸이 틀렸는지 한 줄로. 넣은 값 자체는 싣지 않는다. */
function zodMessage(err: ZodError): string {
  const first = err.issues[0];
  const where = first && first.path.length > 0 ? ` (${first.path.join('.')})` : '';
  return `요청의 꼴이 틀렸습니다${where}.`;
}

/**
 * 경로 함수를 감싼다. 던져진 오류를 { code, message } 본문과 상태 번호로 바꾼다.
 * 예상 못 한 오류는 500 이고, 내부 글은 응답에 싣지 않는다(서버 로그에만 이름을 남긴다).
 */
export function route<A extends unknown[]>(name: string, fn: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (isAppError(err)) return errorResponse(err.toBody());
      if (err instanceof ZodError) return errorResponse({ code: 'BAD_INPUT', message: zodMessage(err) });
      console.error(`[api] ${name} 실패:`, err instanceof Error ? err.name : 'unknown');
      return errorResponse({ code: 'INTERNAL', message: '서버에서 처리하지 못했습니다. 잠시 뒤 다시 해 주세요.' });
    }
  };
}

/** 본문을 상한까지만 읽는다. 넘으면 null. 길이 헤더가 없거나 틀려도 실제로 읽은 만큼만 본다. */
export async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // 더 읽지 않고 손을 뗀다. 남은 본문은 받지 않는다.
      reader.releaseLock();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** JSON 본문을 읽어 약속의 꼴로 본다. JSON 이 아니거나 꼴이 다르면 BAD_INPUT, 너무 크면 FILE_TOO_LARGE. */
export async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const bytes = await readBytes(request, JSON_BODY_MAX_BYTES);
  if (!bytes) throw new AppError('FILE_TOO_LARGE', '요청 본문이 너무 큽니다.');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AppError('BAD_INPUT', '요청 본문이 JSON 이 아닙니다.');
  }
  return schema.parse(raw);
}

/** 주소 값을 약속의 꼴로 본다. 같은 이름이 여러 번 오면 첫 값만 본다. */
export function readQuery<T>(request: Request, schema: ZodType<T>): T {
  const params = new URL(request.url).searchParams;
  const raw: Record<string, string> = {};
  for (const [key, value] of params) if (!(key in raw)) raw[key] = value;
  return schema.parse(raw);
}

/** 주소의 번호. 번호 꼴이 아니면 그런 것은 없으므로 NOT_FOUND. */
export function readId(raw: string, what: string): number {
  if (!/^[1-9][0-9]{0,14}$/.test(raw)) throw new AppError('NOT_FOUND', `${what}이 없습니다.`);
  return Number(raw);
}

export type IdParams = { params: Promise<{ id: string }> };

/** 읽을 공간. 헤더가 없으면 본보기 공간. */
export function readWorkspace(request: Request): string {
  return workspaceForRead(request.headers.get(WORKSPACE_HEADER));
}

/** 접수할 공간. 헤더가 없으면 null 이고, 접수 함수가 그때 새 공간을 만든다. */
export function intakeWorkspace(request: Request): string | null {
  return parseWorkspaceId(request.headers.get(WORKSPACE_HEADER));
}
