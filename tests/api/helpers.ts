// API 시험이 함께 쓰는 것: 경로 함수를 진짜 요청처럼 부르기, 오늘의 하루 세기 비우기.
// 경로 함수는 시계를 직접 읽는다(지금 시각). 그래서 헤더 없이 만든 공간은 꼭 track 으로 적어 두고 끝에 지운다.
import { kstDay, WORKSPACE_HEADER } from '@/contract/api';
import { getPool } from '@/server/db';

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

export interface CallOptions {
  /** 공간 헤더. 비우면 헤더 없이 부른다. */
  ws?: string | null;
  /** JSON 본문. 글자를 주면 그대로 보낸다(JSON 이 아닌 본문 시험용). */
  body?: unknown;
  /** 주소의 번호(:id) */
  id?: number | string;
  headers?: Record<string, string>;
}

export interface Called<T = Record<string, unknown>> {
  status: number;
  body: T;
  response: Response;
}

/** 경로 함수를 부른다. path 는 '/api/drafts?status=READY' 처럼 적는다. */
export async function call<T = Record<string, unknown>>(
  handler: (...args: never[]) => Promise<Response>,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Called<T>> {
  const headers = new Headers(options.headers);
  if (options.ws) headers.set(WORKSPACE_HEADER, options.ws);
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) body = options.body;
  else if (typeof options.body === 'string') body = options.body;
  else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set('content-type', 'application/json');
  }
  const request = new Request(`http://chaeum.test${path}`, { method, headers, body });
  const response = await (handler as unknown as Handler)(request, { params: Promise.resolve({ id: String(options.id ?? '') }) });
  const clone = response.clone();
  const parsed = (response.headers.get('content-type') ?? '').includes('json') ? await clone.json() : await clone.text();
  return { status: response.status, body: parsed as T, response };
}

/** 오늘의 하루 세기를 비운다. 시험을 여러 번 돌려도 접수 상한에 닿지 않게 한다. 다른 시험은 정해 둔 옛 날짜를 쓴다. */
export async function resetToday(): Promise<void> {
  await getPool().query('DELETE FROM daily_counters WHERE day = $1', [kstDay(new Date())]);
}

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
let serial = 0;

/** 머리 바이트만 PNG 인 서로 다른 파일. size 를 주면 그 크기로 채운다. */
export function pngBytes(size = 0): Uint8Array<ArrayBuffer> {
  serial += 1;
  const bytes = new Uint8Array(Math.max(size, PNG_HEAD.length + 8));
  bytes.set(PNG_HEAD);
  bytes.set([serial % 256, Math.floor(serial / 256) % 256, 7], PNG_HEAD.length);
  return bytes;
}

/** 파일 하나를 실은 올리기 본문. */
export function fileForm(bytes: Uint8Array<ArrayBuffer>, name = '단가표.png', field = 'file'): FormData {
  const form = new FormData();
  form.append(field, new File([bytes], name));
  return form;
}
