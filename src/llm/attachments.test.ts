// 그림·PDF 가 붙은 요청: 장부 키에 파일 해시가 들어가는지, 모델에게 파일 토막이 가는지, 구현 셋이 같은 요청으로 도는지 본다.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { isLlmUnavailable, type LlmAttachment, type LlmCallRecord, type LlmRequest, type Transcription } from '@/contract/llm-types';
import { checkUpload } from '@/contract/pipeline-api';
import { createAnthropicProvider, userContent, type MessagesClient } from './anthropic';
import { checkAttachments } from './attachments';
import { buildExtractRequest, buildTranscribeRequest, cacheKeyFor, createProvider, MemoryCallStore } from './index';
import { attachmentHash } from './keys';
import { countUnreadableMarks, transcribeWireToOutput, UNREADABLE_MARK } from './prompts/transcribe.v1';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const png = (body: string): LlmAttachment => ({ kind: 'image', mediaType: 'image/png', dataBase64: b64(body) });
const MODEL = 'claude-haiku-5-5';

// 지어낸 작은 단가표를 그림으로 만든 것(260x120, 약 7KB). 같은 폴더의 html 을 브라우저로 찍었다.
const SHEET_PNG = readFileSync(fileURLToPath(new URL('./__fixtures__/price-sheet-small.png', import.meta.url)));
// 한 쪽짜리 PDF 의 뼈대. 올리기 검사가 보는 머리 바이트와 쪽 표식만 있다.
const ONE_PAGE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n%%EOF\n',
  'latin1',
);

/** 올리기 검사를 통과한 바이트로 붙일 파일을 만든다. 실제 올리기 길과 같은 순서다. */
function attachmentOf(bytes: Uint8Array): LlmAttachment {
  const check = checkUpload(bytes);
  if (!check.ok) throw new Error(`올리기 검사에서 걸렸다: ${check.problem}`);
  return { kind: check.kind, mediaType: check.mediaType, dataBase64: Buffer.from(bytes).toString('base64') };
}

/** 한 바이트만 바꾼 사본. */
function flipOneByte(bytes: Uint8Array, at: number): Buffer {
  const copy = Buffer.from(bytes);
  copy[at] = copy[at]! ^ 0x01;
  return copy;
}

/** 모델이 보낸 답(글로 옮기기의 꼴)을 돌려주는 가짜 클라이언트. 받은 요청을 모아 둔다. */
function clientAnswering(answer: unknown) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      async create(params) {
        calls.push(params);
        return {
          id: 'msg_1', type: 'message', role: 'assistant', model: MODEL,
          content: [{ type: 'text', text: JSON.stringify(answer), citations: null }],
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 5200, output_tokens: 400, cache_creation_input_tokens: null, cache_read_input_tokens: null },
        } as unknown as Anthropic.Message;
      },
    },
  };
  return { client, calls };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (isLlmUnavailable(err)) return err.code;
    throw err;
  }
  return 'ok';
}

describe('첨부가 붙은 요청의 장부 키', () => {
  it('파일이 다르면 키가 다르고, 같으면 같다', () => {
    const a = cacheKeyFor(buildTranscribeRequest(png('단가표 가')), MODEL);
    const again = cacheKeyFor(buildTranscribeRequest(png('단가표 가')), MODEL);
    const b = cacheKeyFor(buildTranscribeRequest(png('단가표 나')), MODEL);
    expect(a).toBe(again);
    expect(a).not.toBe(b);
  });

  it('진짜 그림에서 한 바이트만 달라도 키가 다르다. 같은 바이트를 다시 읽으면 같은 키다', () => {
    const original = attachmentOf(SHEET_PNG);
    const sameBytes = attachmentOf(Buffer.from(SHEET_PNG));
    // 머리 바이트가 아닌 가운데 한 바이트를 바꾼다. 올리기 검사는 그대로 통과한다.
    const changed = attachmentOf(flipOneByte(SHEET_PNG, Math.floor(SHEET_PNG.length / 2)));
    const key = (a: LlmAttachment) => cacheKeyFor(buildTranscribeRequest(a), MODEL);
    expect(key(sameBytes)).toBe(key(original));
    expect(key(changed)).not.toBe(key(original));
    expect(attachmentHash(changed)).not.toBe(attachmentHash(original));
  });

  it('같은 바이트라도 형식이 다르면 키가 다르다', () => {
    const asPng = buildTranscribeRequest(png('같은 바이트'));
    const asJpeg = buildTranscribeRequest({ ...png('같은 바이트'), mediaType: 'image/jpeg' });
    expect(cacheKeyFor(asPng, MODEL)).not.toBe(cacheKeyFor(asJpeg, MODEL));
  });

  it('해시는 base64 글이 아니라 풀어낸 바이트로 낸다(저장하는 파일 해시와 같은 값)', () => {
    const want = createHash('sha256').update(SHEET_PNG).digest('hex');
    expect(attachmentHash(attachmentOf(SHEET_PNG))).toBe(want);
  });

  it('첨부가 없는 요청의 키는 빈 첨부 목록을 줘도 그대로다', () => {
    const req = buildExtractRequest('합정역 전광판 1주 150');
    expect(cacheKeyFor({ ...req, attachments: [] }, MODEL)).toBe(cacheKeyFor(req, MODEL));
  });

  it('모델이 다르면 같은 파일도 키가 다르다', () => {
    const req = buildTranscribeRequest(attachmentOf(SHEET_PNG));
    expect(cacheKeyFor(req, 'model-a')).not.toBe(cacheKeyFor(req, 'model-b'));
  });
});

describe('모델에게 보내는 내용', () => {
  it('첨부가 없으면 JSON 글 하나다', () => {
    expect(userContent({ input: { text: '가' } })).toBe('{"text":"가"}');
  });

  it('그림은 image 토막으로 앞에 오고 JSON 글이 뒤에 온다', () => {
    const file = attachmentOf(SHEET_PNG);
    expect(userContent({ input: { kind: 'image' }, attachments: [file] })).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SHEET_PNG.toString('base64') } },
      { type: 'text', text: '{"kind":"image"}' },
    ]);
  });

  it('PDF 는 document 토막으로 간다', () => {
    const file = attachmentOf(ONE_PAGE_PDF);
    expect(file).toMatchObject({ kind: 'pdf', mediaType: 'application/pdf' });
    expect(userContent({ input: { kind: 'pdf' }, attachments: [file] })).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: ONE_PAGE_PDF.toString('base64') } },
      { type: 'text', text: '{"kind":"pdf"}' },
    ]);
  });

  it.each(['image/jpeg', 'image/webp'] as const)('%s 도 image 토막으로 간다', (mediaType) => {
    const content = userContent({ input: {}, attachments: [{ kind: 'image', mediaType, dataBase64: b64('x') }] });
    expect(content).toMatchObject([{ type: 'image', source: { type: 'base64', media_type: mediaType } }, { type: 'text' }]);
  });
});

describe('붙은 파일 검사', () => {
  const ok = buildTranscribeRequest(attachmentOf(SHEET_PNG));
  const withFiles = (attachments: LlmAttachment[]): LlmRequest<Transcription> => ({ ...ok, attachments });

  it('약속대로면 통과한다. 파일이 없는 뽑기 요청도 통과한다', () => {
    expect(() => checkAttachments(ok)).not.toThrow();
    expect(() => checkAttachments(buildExtractRequest('글'))).not.toThrow();
  });

  it.each([
    ['파일이 없는 글로 옮기기', withFiles([])],
    ['파일이 둘', withFiles([attachmentOf(SHEET_PNG), attachmentOf(ONE_PAGE_PDF)])],
    ['종류와 형식이 어긋남', withFiles([{ kind: 'image', mediaType: 'application/pdf', dataBase64: b64('x') }])],
    ['빈 내용', withFiles([{ kind: 'image', mediaType: 'image/png', dataBase64: '' }])],
    ['줄바꿈이 섞인 base64', withFiles([{ kind: 'image', mediaType: 'image/png', dataBase64: 'AAAA\nAAAA' }])],
    ['base64 가 아닌 글', withFiles([{ kind: 'image', mediaType: 'image/png', dataBase64: '단가표' }])],
    ['파일이 붙은 뽑기 요청', { ...buildExtractRequest('글'), attachments: [attachmentOf(SHEET_PNG)] }],
  ])('%s → 구현 셋 모두 부르지 않고 BAD_REQUEST', async (_name, bad) => {
    const req = bad as LlmRequest<unknown>;
    const store = new MemoryCallStore();
    const { client, calls } = clientAnswering({ unreadable: false, text: '가', note: '' });
    expect(await codeOf(createAnthropicProvider({ model: MODEL, client, store }).complete(req))).toBe('BAD_REQUEST');
    expect(await codeOf(createProvider({ kind: 'fake', store }).complete(req))).toBe('BAD_REQUEST');
    expect(await codeOf(createProvider({ kind: 'replay', store }).complete(req))).toBe('BAD_REQUEST');
    expect(calls).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it('오류 글에 파일 내용을 담지 않는다', () => {
    const secret = b64('비밀 단가표');
    const thrown = (() => {
      try {
        checkAttachments(withFiles([{ kind: 'image', mediaType: 'application/pdf', dataBase64: secret }]));
      } catch (err) {
        return err;
      }
      return null;
    })();
    expect(isLlmUnavailable(thrown)).toBe(true);
    expect(String((thrown as Error).message)).not.toContain(secret);
  });
});

describe('글로 옮기기 요청', () => {
  it('파일 이름과 파일 내용은 입력에 넣지 않는다', () => {
    const req = buildTranscribeRequest(png('비밀 단가표'));
    expect(req.task).toBe('transcribe');
    expect(req.input).toEqual({ kind: 'image' });
    expect(JSON.stringify(req.input)).not.toContain(b64('비밀 단가표'));
    expect(req.attachments).toHaveLength(1);
  });

  it('실제 호출 구현: 파일 토막을 보내고, 받은 답을 약속의 꼴({ text, readable })로 옮긴다', async () => {
    const file = attachmentOf(SHEET_PNG);
    const req = buildTranscribeRequest(file);
    const text = '별빛미디어 단가표\n\n매체명 | 1주 | 2주\n합정역 스퀘어비전 | 150 | 280';
    const { client, calls } = clientAnswering({ unreadable: false, text, note: '' });
    const res = await createAnthropicProvider({ model: MODEL, client }).complete(req);
    expect(res.output).toEqual({ text, readable: true });
    expect(res.usage).toEqual({ inputTokens: 5200, outputTokens: 400 });
    const sent = calls[0]!;
    expect(sent.messages).toEqual([{ role: 'user', content: userContent(req) }]);
    expect(sent.system).toBe(req.system);
    expect(JSON.stringify(sent.output_config?.format?.schema)).toContain('"unreadable"');
  });

  it('읽을 수 없는 파일이면 readable 이 false 이고 글이 비어 있다', async () => {
    const { client } = clientAnswering({ unreadable: true, text: '뭔가 적힌 듯함', note: '글자가 없는 사진이다' });
    const res = await createAnthropicProvider({ model: MODEL, client }).complete(buildTranscribeRequest(attachmentOf(SHEET_PNG)));
    expect(res.output).toEqual({ text: '', readable: false });
  });

  it('답이 요구한 꼴과 다르면 BAD_OUTPUT', async () => {
    const { client } = clientAnswering({ text: '가', readable: true });
    expect(await codeOf(createAnthropicProvider({ model: MODEL, client }).complete(buildTranscribeRequest(attachmentOf(SHEET_PNG))))).toBe('BAD_OUTPUT');
  });

  it('장부에는 옮긴 글만 남는다. 파일 내용은 남지 않는다', async () => {
    const file = attachmentOf(SHEET_PNG);
    const req = buildTranscribeRequest(file);
    const store = new MemoryCallStore();
    const { client } = clientAnswering({ unreadable: false, text: '합정역 스퀘어비전 | 150 | 280', note: '' });
    await createAnthropicProvider({ model: MODEL, client, store }).complete(req);
    const saved = await store.find(cacheKeyFor(req, MODEL));
    expect(saved).toMatchObject({ task: 'transcribe', provider: 'anthropic', promptVersion: 'transcribe-v1', isRecorded: false });
    expect(saved?.response).toEqual({ text: '합정역 스퀘어비전 | 150 | 280', readable: true });
    const line = JSON.stringify(saved);
    expect(line).not.toContain(file.dataBase64);
    expect(line.length).toBeLessThan(1000);
  });

  it('시험용 구현과 녹화 재생이 같은 요청으로 돈다. 시험용 구현이 적은 줄은 녹화가 아니다', async () => {
    const store = new MemoryCallStore();
    const req = buildTranscribeRequest(attachmentOf(SHEET_PNG));
    const fake = await createProvider({ kind: 'fake', store, fakeAnswer: () => ({ text: '1주 150', readable: true }) }).complete(req);
    expect(fake.output).toEqual({ text: '1주 150', readable: true });
    expect(await codeOf(createProvider({ kind: 'replay', store }).complete(req))).toBe('CACHE_MISS');
  });

  it('시험용 구현은 답을 정하지 않아도 글로 옮기기에 기본 답을 준다', async () => {
    const res = await createProvider({ kind: 'fake' }).complete(buildTranscribeRequest(attachmentOf(ONE_PAGE_PDF)));
    expect(res.output.readable).toBe(true);
    expect(res.output.text).not.toBe('');
  });

  it('녹화 재생: 같은 파일이면 받아 둔 답이 나오고, 한 바이트 다른 파일이면 "녹화 없음"이다', async () => {
    const req = buildTranscribeRequest(attachmentOf(SHEET_PNG));
    const store = new MemoryCallStore();
    const { client, calls } = clientAnswering({ unreadable: false, text: '합정역 스퀘어비전 | 150 | 280', note: '' });
    await createAnthropicProvider({ model: MODEL, client, store }).complete(req);

    const replay = createProvider({ kind: 'replay', model: MODEL, store });
    const again = await replay.complete(buildTranscribeRequest(attachmentOf(Buffer.from(SHEET_PNG))));
    expect(again).toMatchObject({
      output: { text: '합정역 스퀘어비전 | 150 | 280', readable: true },
      recorded: true,
      usage: { inputTokens: 5200, outputTokens: 400 },
    });

    const other = buildTranscribeRequest(attachmentOf(flipOneByte(SHEET_PNG, SHEET_PNG.length - 20)));
    expect(await codeOf(replay.complete(other))).toBe('CACHE_MISS');
    // 다시 내준 답은 장부에서 나온 것이다. 모델은 처음 한 번만 불렸다.
    expect(calls).toHaveLength(1);
  });

  it('녹화 재생: 장부의 답이 약속의 꼴과 다르면 내주지 않는다', async () => {
    const req = buildTranscribeRequest(attachmentOf(SHEET_PNG));
    const broken: LlmCallRecord = {
      task: 'transcribe', provider: 'anthropic', model: MODEL, promptVersion: req.promptVersion, cacheKey: cacheKeyFor(req, MODEL),
      response: { text: 150 }, stopReason: 'end_turn', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, isRecorded: true,
    };
    expect(await codeOf(createProvider({ kind: 'replay', model: MODEL, store: new MemoryCallStore([broken]) }).complete(req))).toBe('BAD_OUTPUT');
  });
});

describe('받은 답을 약속의 꼴로 옮기기(글로 옮기기)', () => {
  it('옮긴 글은 손대지 않고 그대로 넘긴다', () => {
    const text = '  05시~25시 | 150 \n\n7*12(m)\n';
    expect(transcribeWireToOutput({ unreadable: false, text, note: '오른쪽 끝이 잘려 있다' })).toEqual({ text, readable: true });
  });

  it.each([
    ['읽을 수 없다고 한 답', { unreadable: true, text: '', note: '' }],
    ['빈 글', { unreadable: false, text: '', note: '' }],
    ['공백뿐인 글', { unreadable: false, text: ' \n ', note: '' }],
    ['"읽지 못함" 표시뿐인 글', { unreadable: false, text: `${UNREADABLE_MARK}\n${UNREADABLE_MARK} `, note: '' }],
  ])('%s → 읽을 수 없는 파일로 본다', (_name, wire) => {
    expect(transcribeWireToOutput(wire)).toEqual({ text: '', readable: false });
  });

  it('몇 군데만 못 읽은 글은 읽은 것으로 보고 표시를 남긴다', () => {
    const text = `합정역 스퀘어비전 | 150 | ${UNREADABLE_MARK}`;
    expect(transcribeWireToOutput({ unreadable: false, text, note: '' })).toEqual({ text, readable: true });
    expect(countUnreadableMarks(text)).toBe(1);
    expect(countUnreadableMarks('150 | 280')).toBe(0);
  });
});
