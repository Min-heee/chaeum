// 브라우저에서 API 를 부르는 한 곳. 작업 공간 번호와 보는 사람(셀러·운영자)을 브라우저에 저장하고,
// 부른 요청을 기억해 두었다가 API 탭이 같은 일을 하는 curl 로 보여 준다.
// 서버 전용 모듈은 여기서 가져오지 않는다.
import { useSyncExternalStore } from 'react';
import { WORKSPACE_HEADER, type ApiErrorCode, type DrainResponse, type DraftDetailResponse } from '@/contract/api';
import type { LlmSkipCause } from '@/contract/reasons';

const WORKSPACE_KEY = 'chaeum.workspace';
const ROLE_KEY = 'chaeum.role';
const CALLS_KEY = 'chaeum.calls';
const CHANGED = 'chaeum:changed';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Role = 'seller' | 'admin';
export const ROLE_LABELS: Record<Role, string> = { seller: '셀러', admin: '운영자' };

// ── 브라우저 저장 ──────────────────────────────────────────

function read(storage: 'local' | 'session', key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return (storage === 'local' ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function write(storage: 'local' | 'session', key: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    const box = storage === 'local' ? window.localStorage : window.sessionStorage;
    if (value === null) box.removeItem(key);
    else box.setItem(key, value);
  } catch {
    // 저장이 막힌 브라우저에서도 화면은 돈다. 다만 새로 고치면 공간 번호를 잊는다.
  }
  window.dispatchEvent(new Event(CHANGED));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener('storage', onChange);
  };
}

export function getWorkspace(): string | null {
  const value = read('local', WORKSPACE_KEY);
  return value && UUID.test(value) ? value : null;
}

export function setWorkspace(value: string | null): void {
  write('local', WORKSPACE_KEY, value);
}

export function getRole(): Role {
  return read('local', ROLE_KEY) === 'seller' ? 'seller' : 'admin';
}

export function setRole(role: Role): void {
  write('local', ROLE_KEY, role);
}

/** 작업 공간 번호. 서버에서 그릴 때와 첫 그리기에서는 null 이다. */
export function useWorkspace(): string | null {
  return useSyncExternalStore(subscribe, getWorkspace, () => null);
}

export function useRole(): Role {
  return useSyncExternalStore(subscribe, getRole, () => 'admin' as const);
}

/** 브라우저에서 그리는 중인가(첫 그리기가 끝났는가). 저장된 값을 읽어야 하는 화면이 쓴다. */
export function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

// ── 부른 요청의 기록 (API 탭) ───────────────────────────────

export interface CallRecord {
  id: number;
  at: string;
  label: string;
  method: string;
  path: string;
  /** JSON 본문. 파일 올리기면 없다. */
  body?: unknown;
  /** 올린 파일 이름(파일 올리기일 때만) */
  fileName?: string;
  /** 파일과 함께 실은 글자 칸(시안 검사의 productId 같은 것) */
  fields?: Record<string, string>;
  /** 본보기 공간을 읽은 요청(공간 헤더 없이 부름) */
  publicSpace: boolean;
  status: number;
}

const CALLS_MAX = 30;
let callsCache: { raw: string | null; list: CallRecord[] } = { raw: null, list: [] };

export function getCalls(): CallRecord[] {
  const raw = read('session', CALLS_KEY);
  if (raw === callsCache.raw) return callsCache.list;
  let list: CallRecord[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) list = parsed as CallRecord[];
  } catch {
    list = [];
  }
  callsCache = { raw, list };
  return list;
}

const NO_CALLS: CallRecord[] = [];

export function useCalls(): CallRecord[] {
  return useSyncExternalStore(subscribe, getCalls, () => NO_CALLS);
}

export function clearCalls(): void {
  write('session', CALLS_KEY, null);
}

function remember(call: Omit<CallRecord, 'id' | 'at'>): void {
  const list = getCalls();
  const next: CallRecord = { ...call, id: (list[0]?.id ?? 0) + 1, at: new Date().toISOString() };
  // 글이 길면 저장이 넘칠 수 있다. 그래도 화면은 멈추지 않는다.
  write('session', CALLS_KEY, JSON.stringify([next, ...list].slice(0, CALLS_MAX)));
}

// ── 요청 ───────────────────────────────────────────────────

/** API 가 오류로 답했을 때 던지는 것. 본문의 code·message 를 그대로 든다. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'NETWORK',
    message: string,
    readonly current?: { status: string; version: number },
    readonly skipCause?: LlmSkipCause,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}

/** 상품 화면의 주소. 본보기 공간의 상품은 pub=1 을 붙여 공간 헤더 없이 읽게 한다(내 공간 번호로는 열리지 않는다). */
export const productHref = (productId: number, publicSpace: boolean): string => `/products/${productId}${publicSpace ? '?pub=1' : ''}`;

export function failureMessage(err: unknown): string {
  if (err instanceof ApiFailure) return err.message;
  return '요청을 보내지 못했습니다. 잠시 뒤 다시 해 주세요.';
}

export interface CallOptions {
  /** JSON 본문 */
  body?: unknown;
  /** 파일 올리기 */
  file?: File;
  /** 파일과 함께 싣는 글자 칸(multipart). file 이 있을 때만 쓴다. */
  fields?: Record<string, string>;
  /** API 탭에 남길 이름. 주면 기록한다. */
  label?: string;
  /** 본보기 공간을 읽는다(공간 헤더를 싣지 않는다) */
  publicSpace?: boolean;
}

async function send(method: string, path: string, options: CallOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  const workspace = options.publicSpace ? null : getWorkspace();
  if (workspace) headers[WORKSPACE_HEADER] = workspace;
  let body: BodyInit | undefined;
  if (options.file) {
    const form = new FormData();
    for (const [name, value] of Object.entries(options.fields ?? {})) form.append(name, value);
    form.append('file', options.file);
    body = form;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(path, { method, headers, body, cache: 'no-store' });
  } catch {
    throw new ApiFailure(0, 'NETWORK', '서버에 닿지 못했습니다. 연결을 확인해 주세요.');
  }
  if (options.label) {
    remember({
      label: options.label,
      method,
      path,
      body: options.file ? undefined : options.body,
      fileName: options.file?.name,
      fields: options.file ? options.fields : undefined,
      publicSpace: options.publicSpace === true,
      status: response.status,
    });
  }
  if (!response.ok) {
    let parsed: { code?: ApiErrorCode; message?: string; current?: { status: string; version: number }; skipCause?: LlmSkipCause } = {};
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch {
      // 본문이 JSON 이 아니면 상태 번호만으로 말한다.
    }
    throw new ApiFailure(
      response.status,
      parsed.code ?? 'INTERNAL',
      parsed.message ?? `요청이 실패했습니다(${response.status}).`,
      parsed.current,
      parsed.skipCause,
    );
  }
  return response;
}

/** JSON 을 주고받는 요청. 응답에 workspace 가 있으면 브라우저에 저장한다(첫 쓰기 때 받는다). */
export async function call<T>(method: string, path: string, options: CallOptions = {}): Promise<T> {
  const response = await send(method, path, options);
  const data = (await response.json()) as T;
  const workspace = (data as { workspace?: unknown } | null)?.workspace;
  if (typeof workspace === 'string' && UUID.test(workspace) && workspace !== getWorkspace()) setWorkspace(workspace);
  return data;
}

/** 글자로 받는 요청(CSV). */
export async function callText(path: string, options: CallOptions = {}): Promise<string> {
  const response = await send('GET', path, options);
  return response.text();
}

/** 파일 바이트로 받는 요청(XLSX). */
export async function callBlob(path: string, options: CallOptions = {}): Promise<Blob> {
  const response = await send('GET', path, options);
  return response.blob();
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 줄을 한 번 굴린다. 이 사이트에는 따로 도는 작업자가 없어서 화면이 굴린다. */
export function drainOnce(label?: string): Promise<DrainResponse> {
  return call<DrainResponse>('POST', '/api/jobs/drain', { label });
}

/**
 * 초안이 '처리 중'을 벗어날 때까지 줄을 굴리고 다시 읽는다.
 * 오래 걸리면(약 1분) 그때의 초안을 그대로 돌려준다. 부르는 쪽이 '아직 처리 중'이라고 보여 준다.
 */
export async function waitForDraft(draftId: number, options: { publicSpace?: boolean; label?: string } = {}): Promise<DraftDetailResponse> {
  const read = () => call<DraftDetailResponse>('GET', `/api/drafts/${draftId}`, { publicSpace: options.publicSpace });
  let draft = await read();
  for (let turn = 0; turn < 40 && draft.status === 'PROCESSING'; turn += 1) {
    try {
      await drainOnce(turn === 0 ? options.label : undefined);
    } catch {
      // 굴리기가 한 번 실패해도 다시 읽어 본다.
    }
    draft = await read();
    if (draft.status === 'PROCESSING') await sleep(Math.min(300 + turn * 150, 1500));
  }
  return draft;
}

/** 조건이 맞을 때까지 줄을 굴리며 다시 읽는다(상품의 글이 붙을 때까지 등). */
export async function pollUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, turns = 30): Promise<T> {
  let value = await read();
  for (let turn = 0; turn < turns && !done(value); turn += 1) {
    try {
      await drainOnce();
    } catch {
      // 다시 읽어 본다.
    }
    value = await read();
    if (!done(value)) await sleep(Math.min(300 + turn * 150, 1500));
  }
  return value;
}

/** 지금 주소의 앞부분(https://…). curl 예시에 쓴다. */
export function useOrigin(): string {
  return useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => '',
  );
}
