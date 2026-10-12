import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { isLlmUnavailable } from '@/contract/llm-types';
import { createAnthropicProvider, toLlmUnavailable, type MessagesClient } from './anthropic';
import { cacheKeyFor } from './keys';
import { buildExtractRequestV1 } from './prompts/extract.v1';
import { MemoryCallStore } from './stores';

const MODEL = 'claude-haiku-5-5';
const wireAnswer = {
  type: 'goods',
  subtype: '인쇄물',
  fields: [
    { field: 'name', raw: '별무리 엽서', value: '별무리 엽서', evidence: '별무리 엽서' },
    { field: 'size_mm', raw: '100x148mm', value: { width: 100, height: 148 }, evidence: '100x148mm' },
    { field: 'material', raw: null, value: null, evidence: null },
  ],
};

/** 진짜 응답의 꼴만 흉내 낸 메시지. */
function message(over: { text?: string | null; stop?: string; thinkingFirst?: boolean; input?: number; output?: number }): Anthropic.Message {
  const content: unknown[] = [];
  if (over.thinkingFirst) content.push({ type: 'thinking', thinking: '', signature: 's' });
  if (over.text !== null) content.push({ type: 'text', text: over.text ?? JSON.stringify(wireAnswer), citations: null });
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content,
    stop_reason: over.stop ?? 'end_turn', stop_sequence: null,
    usage: { input_tokens: over.input ?? 2000, output_tokens: over.output ?? 600, cache_creation_input_tokens: null, cache_read_input_tokens: null },
  } as unknown as Anthropic.Message;
}

function clientReturning(msg: Anthropic.Message) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      async create(params) {
        calls.push(params);
        return msg;
      },
    },
  };
  return { client, calls };
}

function clientThrowing(err: unknown): MessagesClient {
  return { messages: { create: async () => Promise.reject(err) } };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (isLlmUnavailable(err)) return `${err.code}:${err.retryable}`;
    throw err;
  }
  return 'ok';
}

const req = buildExtractRequestV1('별무리 엽서 100x148mm');
const httpError = (status: number, type = 'x_error') =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type, message: '본문' } }, '본문', new Headers());

describe('실제 호출 구현: 보내는 것', () => {
  it('키가 없으면 부르지 않고 NO_KEY', async () => {
    expect(await codeOf(createAnthropicProvider({ model: MODEL }).complete(req))).toBe('NO_KEY:false');
  });
  it('입력은 JSON 글 하나로, 스키마와 노력 단계는 output_config 로 보낸다. 표본·생각·도구 설정은 보내지 않는다', async () => {
    const { client, calls } = clientReturning(message({}));
    await createAnthropicProvider({ model: MODEL, client }).complete(req);
    expect(calls).toHaveLength(1);
    const sent = calls[0]!;
    expect(Object.keys(sent).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system']);
    expect(sent).toMatchObject({ model: MODEL, max_tokens: req.maxTokens, system: req.system });
    expect(sent.messages).toEqual([{ role: 'user', content: JSON.stringify({ text: '별무리 엽서 100x148mm' }) }]);
    expect(sent.output_config?.effort).toBe('low');
    expect(sent.output_config?.format?.type).toBe('json_schema');
    expect(JSON.stringify(sent.output_config?.format?.schema)).toContain('"enum":["ad","catering","goods","not_product"]');
  });
});

describe('실제 호출 구현: 받은 것', () => {
  it('답을 약속의 꼴로 옮겨 돌려주고 토큰을 싣는다. 생각 토막이 앞에 와도 글 토막을 찾는다', async () => {
    const { client } = clientReturning(message({ thinkingFirst: true }));
    const res = await createAnthropicProvider({ model: MODEL, client }).complete(req);
    expect(res.output).toEqual({
      type: 'goods',
      subtype: '인쇄물',
      fields: [
        { field: 'name', raw: '별무리 엽서', value: '별무리 엽서', evidence: '별무리 엽서' },
        { field: 'size_mm', raw: '100x148mm', value: { width: 100, height: 148 }, evidence: '100x148mm' },
      ],
    });
    expect(res).toMatchObject({ stopReason: 'end_turn', usage: { inputTokens: 2000, outputTokens: 600 }, recorded: false });
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });
  it('장부를 넘겨받았으면 검사를 통과한 답과 비용을 적는다', async () => {
    const store = new MemoryCallStore();
    const { client } = clientReturning(message({}));
    const res = await createAnthropicProvider({ model: MODEL, client, store }).complete(req);
    const saved = await store.find(cacheKeyFor(req, MODEL));
    expect(saved).toMatchObject({
      task: 'extract', provider: 'anthropic', model: MODEL, promptVersion: 'extract-v1',
      stopReason: 'end_turn', inputTokens: 2000, outputTokens: 600, costUsd: 0.0005, isRecorded: false,
    });
    expect(saved?.response).toEqual(res.output);
  });
  it.each([
    ['거절', message({ stop: 'refusal', text: '죄송합니다' }), 'REFUSAL:false'],
    ['잘림', message({ stop: 'max_tokens', text: '{"type":"go' }), 'MAX_TOKENS:false'],
    ['잘림(문맥 창)', message({ stop: 'model_context_window_exceeded', text: null }), 'MAX_TOKENS:false'],
    ['글 토막 없음', message({ text: null }), 'BAD_OUTPUT:false'],
    ['JSON 아님', message({ text: '답: 없음' }), 'BAD_OUTPUT:false'],
    ['요구한 꼴과 다름', message({ text: '{"type":"goods"}' }), 'BAD_OUTPUT:false'],
    ['같은 칸 두 번', message({ text: JSON.stringify({ type: 'goods', subtype: null, fields: [wireAnswer.fields[0], wireAnswer.fields[0]] }) }), 'BAD_OUTPUT:false'],
  ])('%s → 오류로 알리고 장부에 적지 않는다', async (_name, msg, expected) => {
    const store = new MemoryCallStore();
    const { client } = clientReturning(msg);
    expect(await codeOf(createAnthropicProvider({ model: MODEL, client, store }).complete(req))).toBe(expected);
    expect(store.size).toBe(0);
  });
  it('칸 하나의 값이 꼴과 달라도 답 전체를 버리지 않는다. 그 칸의 값만 비운다', async () => {
    const text = JSON.stringify({
      type: 'goods',
      subtype: '인쇄물',
      fields: [
        { field: 'name', raw: '응원 슬로건', value: '응원 슬로건', evidence: '응원 슬로건' },
        { field: 'size_mm', raw: '200x600mm', value: 5, evidence: '200x600mm' },
      ],
    });
    const { client } = clientReturning(message({ text }));
    const res = await createAnthropicProvider({ model: MODEL, client }).complete(req);
    expect(res.output.fields).toEqual([
      { field: 'name', raw: '응원 슬로건', value: '응원 슬로건', evidence: '응원 슬로건' },
      { field: 'size_mm', raw: '200x600mm', value: null, evidence: '200x600mm' },
    ]);
  });
  it('답을 못 써도 나간 토큰 수는 오류에 실어 보낸다', async () => {
    const { client } = clientReturning(message({ stop: 'refusal', text: '죄송합니다' }));
    const err = await createAnthropicProvider({ model: MODEL, client }).complete(req).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'REFUSAL', usage: { inputTokens: 2000, outputTokens: 600 } });
  });
  it('호출이 닿지 못한 오류에는 토큰 수가 없다', async () => {
    const err = await createAnthropicProvider({ model: MODEL, client: clientThrowing(httpError(429)) }).complete(req).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'TRANSIENT' });
    expect((err as { usage?: unknown }).usage).toBeUndefined();
  });
});

describe('실제 호출 구현: 오류 가르기', () => {
  it.each([
    [408, 'TRANSIENT:true'],
    [409, 'TRANSIENT:true'],
    [429, 'TRANSIENT:true'],
    [500, 'TRANSIENT:true'],
    [529, 'TRANSIENT:true'],
    [401, 'NO_KEY:false'],
    [403, 'NO_KEY:false'],
    [400, 'BAD_REQUEST:false'],
    [404, 'BAD_REQUEST:false'],
    [413, 'BAD_REQUEST:false'],
  ])('HTTP %i → %s', async (status, expected) => {
    expect(await codeOf(createAnthropicProvider({ model: MODEL, client: clientThrowing(httpError(status)) }).complete(req))).toBe(expected);
  });
  it('연결 실패와 시간 초과는 다시 해 볼 만하다', async () => {
    for (const err of [new Anthropic.APIConnectionError({ message: 'x' }), new Anthropic.APIConnectionTimeoutError()]) {
      expect(await codeOf(createAnthropicProvider({ model: MODEL, client: clientThrowing(err) }).complete(req))).toBe('TRANSIENT:true');
    }
  });
  it('오류 글에는 상태 번호와 종류만 담고 응답 본문은 담지 않는다', () => {
    const mapped = toLlmUnavailable(httpError(429, 'rate_limit_error'));
    expect(mapped?.message).toBe('HTTP 429 rate_limit_error');
    expect(toLlmUnavailable(httpError(400, 'invalid_request_error'))?.message).not.toContain('본문');
  });
  it('SDK 오류가 아닌 것은 바꾸지 않고 그대로 던진다', async () => {
    expect(toLlmUnavailable(new TypeError('버그'))).toBeNull();
    await expect(createAnthropicProvider({ model: MODEL, client: clientThrowing(new TypeError('버그')) }).complete(req)).rejects.toThrow(TypeError);
  });
});
