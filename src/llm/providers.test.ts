import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Extraction } from '@/contract/fields';
import { DEFAULT_LLM_MODEL, isLlmUnavailable, type LlmCallRecord } from '@/contract/llm-types';
import api, { buildContentRequest, buildExtractRequest, cacheKeyFor, createProvider, JsonlCallStore, MemoryCallStore, providerFromEnv } from './index';
import { parseRecordingLines } from './stores';

const answer: Extraction = {
  type: 'catering',
  subtype: '커피차',
  fields: [
    { field: 'name', raw: '달보드레 커피차', value: '달보드레 커피차', evidence: '달보드레 커피차' },
    { field: 'quantity_options', raw: '100잔 80만원', value: [{ qty: 100, price_krw: 800000 }], evidence: '100잔 80만원' },
  ],
};
const contentInput = { type: 'catering' as const, subtype: '커피차', name: '달보드레 커피차', region: '서울', glossary: [], placeholders: ['price' as const] };

/** 실제 호출이 적은 것과 같은 꼴의 장부 한 줄. */
const recordedCall = (req: ReturnType<typeof buildExtractRequest> | ReturnType<typeof buildContentRequest>, response: unknown, model = DEFAULT_LLM_MODEL): LlmCallRecord => ({
  task: req.task, provider: 'anthropic', model, promptVersion: req.promptVersion,
  cacheKey: cacheKeyFor(req as Parameters<typeof cacheKeyFor>[0], model), response, stopReason: 'end_turn',
  inputTokens: 1800, outputTokens: 600, costUsd: 0.00048, latencyMs: 2100, isRecorded: true,
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (isLlmUnavailable(err)) return `${err.code}:${err.retryable}`;
    throw err;
  }
  return 'ok';
}

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'llm-rec-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('시험용 구현(fake)', () => {
  it('정해 둔 답을 스키마로 검사해 돌려준다', async () => {
    const llm = createProvider({ kind: 'fake', fakeAnswer: () => answer });
    const res = await llm.complete(buildExtractRequest('아무 글'));
    expect(llm).toMatchObject({ name: 'fake', model: DEFAULT_LLM_MODEL });
    expect(res).toEqual({ output: answer, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0, recorded: false });
  });
  it('답을 정하지 않으면 기본 답: 뽑기는 "등록 대상 아님", 글은 자리표시가 든 두 언어 글', async () => {
    const llm = createProvider({ kind: 'fake' });
    expect((await llm.complete(buildExtractRequest('글'))).output).toEqual({ type: 'not_product', subtype: null, fields: [] });
    const draft = (await llm.complete(buildContentRequest(contentInput))).output;
    expect(draft.en.title).toBe('달보드레 커피차');
    expect(draft['zh-Hans'].summary).toContain('{price}');
  });
  it('요청을 보고 답을 정할 수 있다', async () => {
    const llm = createProvider({ kind: 'fake', fakeAnswer: (req) => ({ type: 'not_product', subtype: null, fields: [], seen: req.input }) });
    expect((await llm.complete(buildExtractRequest('글'))).output.type).toBe('not_product');
  });
  it('정해 둔 답이 스키마와 다르면 BAD_OUTPUT(다시 하지 않는다)', async () => {
    const llm = createProvider({ kind: 'fake', fakeAnswer: () => ({ type: 'ad', subtype: null, fields: [{ field: 'price_krw', raw: 'x', value: 'x', evidence: null }] }) });
    expect(await codeOf(llm.complete(buildExtractRequest('글')))).toBe('BAD_OUTPUT:false');
  });
});

describe('녹화 재생(replay)', () => {
  it('장부가 없거나 녹화가 없으면 CACHE_MISS(다시 하지 않는다)', async () => {
    expect(await codeOf(createProvider({ kind: 'replay' }).complete(buildExtractRequest('글')))).toBe('CACHE_MISS:false');
    expect(await codeOf(createProvider({ kind: 'replay', store: new MemoryCallStore() }).complete(buildExtractRequest('글')))).toBe('CACHE_MISS:false');
  });
  it('장부에 적힌 실제 호출의 답을 같은 요청으로 찾는다', async () => {
    const store = new MemoryCallStore([recordedCall(buildExtractRequest('달보드레 커피차 100잔 80만원'), answer)]);
    const res = await createProvider({ kind: 'replay', store }).complete(buildExtractRequest('달보드레 커피차 100잔 80만원'));
    expect(res.output).toEqual(answer);
    expect(res.recorded).toBe(true);
  });
  it('시험용 구현이 장부에 적은 답은 녹화가 아니다(가짜 답을 녹화본이라며 내주지 않는다)', async () => {
    const store = new MemoryCallStore();
    const req = buildExtractRequest('달보드레 커피차 100잔 80만원');
    await createProvider({ kind: 'fake', store, fakeAnswer: () => answer }).complete(req);
    expect(store.size).toBe(1);
    expect(await codeOf(createProvider({ kind: 'replay', store }).complete(req))).toBe('CACHE_MISS:false');
  });
  it('시스템 글이나 답의 꼴이 바뀌면 버전 이름이 같아도 찾지 못한다', async () => {
    const req = buildExtractRequest('가나다');
    const store = new MemoryCallStore([recordedCall(req, answer)]);
    const replay = createProvider({ kind: 'replay', store });
    expect(await codeOf(replay.complete(req))).toBe('ok');
    expect(await codeOf(replay.complete({ ...req, system: `${req.system}\n- 새 규칙 하나.` }))).toBe('CACHE_MISS:false');
  });
  it('원문이 한 글자만 달라도, 모델이 달라도 찾지 못한다', async () => {
    const store = new MemoryCallStore([recordedCall(buildExtractRequest('가나다'), answer)]);
    expect(await codeOf(createProvider({ kind: 'replay', store }).complete(buildExtractRequest('가나다')))).toBe('ok');
    expect(await codeOf(createProvider({ kind: 'replay', store }).complete(buildExtractRequest('가나다.')))).toBe('CACHE_MISS:false');
    expect(await codeOf(createProvider({ kind: 'replay', store, model: 'other-model' }).complete(buildExtractRequest('가나다')))).toBe('CACHE_MISS:false');
  });
  it('녹화할 때 잰 토큰과 시간을 돌려준다', async () => {
    const req = buildExtractRequest('글');
    const record: LlmCallRecord = {
      task: 'extract', provider: 'anthropic', model: DEFAULT_LLM_MODEL, promptVersion: req.promptVersion,
      cacheKey: cacheKeyFor(req, DEFAULT_LLM_MODEL), response: answer, stopReason: 'end_turn',
      inputTokens: 1800, outputTokens: 600, costUsd: 0.00048, latencyMs: 2100, isRecorded: true,
    };
    const res = await createProvider({ kind: 'replay', store: new MemoryCallStore([record]) }).complete(req);
    expect(res).toMatchObject({ stopReason: 'end_turn', usage: { inputTokens: 1800, outputTokens: 600 }, latencyMs: 2100, recorded: true });
  });
  it('녹화된 답이 지금 스키마와 다르면 BAD_OUTPUT', async () => {
    const req = buildExtractRequest('글');
    const store = new MemoryCallStore([{
      task: 'extract', provider: 'anthropic', model: DEFAULT_LLM_MODEL, promptVersion: req.promptVersion,
      cacheKey: cacheKeyFor(req, DEFAULT_LLM_MODEL), response: { type: 'ad' }, stopReason: 'end_turn',
      inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, isRecorded: true,
    }]);
    expect(await codeOf(createProvider({ kind: 'replay', store }).complete(req))).toBe('BAD_OUTPUT:false');
  });
});

describe('jsonl 장부', () => {
  it('없는 폴더는 빈 장부다', async () => {
    expect(await new JsonlCallStore(join(tmpDir(), 'none')).find('a'.repeat(64))).toBeNull();
  });
  it('쓴 줄을 새로 연 장부가 읽는다(파일 → replay 왕복)', async () => {
    const dir = tmpDir();
    const req = buildContentRequest(contentInput);
    const first = await createProvider({ kind: 'fake' }).complete(req);
    await new JsonlCallStore(dir).save(recordedCall(req, first.output));
    expect(readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);

    const again = await createProvider({ kind: 'replay', store: new JsonlCallStore(dir) }).complete(buildContentRequest(contentInput));
    expect(again.output).toEqual(first.output);
    expect(again.recorded).toBe(true);
  });
  it('같은 키가 여러 번 나오면 뒤에 나온 줄이 이긴다', async () => {
    const dir = tmpDir();
    const line = (n: number, costUsd: number) => JSON.stringify({
      task: 'extract', provider: 'anthropic', model: 'm', promptVersion: 'extract-v1', cacheKey: 'c'.repeat(64),
      response: { n }, stopReason: 'end_turn', inputTokens: 1, outputTokens: 1, costUsd, latencyMs: 1, isRecorded: true,
    });
    writeFileSync(join(dir, 'a.jsonl'), `${line(1, 0)}\n${line(2, 0)}\n`);
    writeFileSync(join(dir, 'b.jsonl'), `\n${line(3, 0)}\n`);
    writeFileSync(join(dir, 'memo.txt'), '장부가 아닌 파일');
    expect((await new JsonlCallStore(dir).find('c'.repeat(64)))?.response).toEqual({ n: 3 });
  });
  it('꼴이 다른 줄은 몇째 줄인지 알리고 멈춘다', () => {
    expect(() => parseRecordingLines('{"task":"extract"}\n', 'x.jsonl')).toThrow('x.jsonl 1째 줄');
    expect(() => parseRecordingLines('\n{아님\n', 'x.jsonl')).toThrow('x.jsonl 2째 줄');
  });
});

describe('구현 고르기', () => {
  it('LLM_PROVIDER 와 LLM_MODEL 을 따른다', () => {
    expect(providerFromEnv({ LLM_PROVIDER: 'fake', LLM_MODEL: 'claude-sonnet-5-5' })).toMatchObject({ name: 'fake', model: 'claude-sonnet-5-5' });
    expect(providerFromEnv({ LLM_PROVIDER: 'replay', ANTHROPIC_API_KEY: 'k' })).toMatchObject({ name: 'replay', model: DEFAULT_LLM_MODEL });
  });
  it('방식을 비우면 키가 있을 때 anthropic, 없을 때 replay. 모델을 비우면 가장 작은 모델', () => {
    expect(providerFromEnv({ ANTHROPIC_API_KEY: 'k' })).toMatchObject({ name: 'anthropic', model: 'claude-haiku-5-5' });
    expect(providerFromEnv({})).toMatchObject({ name: 'replay', model: 'claude-haiku-5-5' });
    expect(providerFromEnv({ LLM_MODEL: '  ' }).model).toBe('claude-haiku-5-5');
  });
  it('모르는 방식이면 오류', () => {
    expect(() => providerFromEnv({ LLM_PROVIDER: 'other' })).toThrow();
  });
  it('문 파일이 약속한 함수 일곱을 내보낸다', () => {
    expect(Object.keys(api).sort()).toEqual(['buildContentRequest', 'buildExtractRequest', 'buildTranscribeRequest', 'cacheKeyFor', 'costUsd', 'createProvider', 'priceOf']);
  });
});
