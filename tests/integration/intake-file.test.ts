// 그림·PDF 올리기: 검사 → 글로 옮기기 → 같은 길로 접수 → 뽑기. 파일 자체는 남기지 않는다.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { LIMITS, PUBLIC_WORKSPACE_ID, SourceFileResponseSchema } from '@/contract/api';
import { countPdfPagesRoughly, UPLOAD_LIMITS, type TranscribeStep } from '@/contract/pipeline-api';
import { closePool, getPool } from '@/server/db';
import { intakeFile } from '@/server/intake-file';
import { transcribe } from '@/server/pipeline/transcribe';
import { countPdfPages } from '@/server/pdf-pages';
import { bumpCounter, readCounter } from '@/server/repos/daily-counters';
import { getDraft } from '@/server/repos/drafts';
import { draftDetail, draftList } from '@/server/service';
import { ensurePublicWorkspace } from '@/server/workspace';
import { at, count, dropWorkspaces, newWorkspace, track } from './helpers';
import { drainAll, fakeAnswer, fakeRouter, goodsText, handlersFor, liveStub, router } from './pipeline-helpers';

const pool = () => getPool();
const CAP_DAY = new Date('2003-04-04T03:00:00Z');
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
let serial = 0;

/** 머리 바이트만 PNG 인 서로 다른 파일. */
function png(): Uint8Array {
  serial += 1;
  return Uint8Array.from([...PNG_HEAD, 1, 2, 3, serial % 256, Math.floor(serial / 256)]);
}
const pdf = (pages = 1) => new TextEncoder().encode(`%PDF-1.7\n${'<< /Type /Page >>\n'.repeat(pages)}<< /Type /Pages >>\n${serial += 1}`);

/** 부른 횟수를 세는 글로 옮기기. */
function counted(): TranscribeStep & { calls: number } {
  const step = (async (input, r) => {
    step.calls += 1;
    return transcribe(input, r);
  }) as TranscribeStep & { calls: number };
  step.calls = 0;
  return step;
}

beforeEach(async () => {
  await pool().query('TRUNCATE jobs RESTART IDENTITY');
  await pool().query(`DELETE FROM daily_counters WHERE day >= '2003-04-01' AND day <= '2003-04-30'`);
});

afterAll(async () => {
  await pool().query(`DELETE FROM daily_counters WHERE day >= '2003-04-01' AND day <= '2003-04-30'`);
  await dropWorkspaces();
  await closePool();
});

describe('그림 올리기', () => {
  it('그림을 올리면 옮긴 글이 접수되고, 뽑힌 초안에 "원본과 대조 필요"가 붙는다', async () => {
    const ws = await newWorkspace();
    const { text, name } = goodsText();
    const r = fakeRouter(fakeAnswer(text));
    const got = await intakeFile({ bytes: png(), name: 'C:\\단가표\\슬로건 단가.png' }, { workspaceId: ws, now: at(0), router: r });

    expect(got.created).toBe(true);
    expect(() => SourceFileResponseSchema.parse(got.body)).not.toThrow();
    expect(got.body).toMatchObject({ workspace: ws, status: 'PROCESSING', duplicate: false, source: { kind: 'image', originName: '슬로건 단가.png', chars: [...text].length } });
    expect(got.body.transcribe).toMatchObject({ recorded: false, live: false });

    // 남는 것은 옮긴 글, 파일 해시, 파일 이름뿐이다.
    const { rows } = await pool().query('SELECT * FROM source_docs WHERE id = $1', [got.body.sourceDocId]);
    expect(rows[0]).toMatchObject({ source_kind: 'image', origin_name: '슬로건 단가.png', clean_text: text });
    expect(rows[0].file_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(rows[0]).sort()).toEqual(['batch_no', 'clean_text', 'content_hash', 'created_at', 'file_hash', 'id', 'origin_name', 'source_kind', 'workspace_id']);

    await drainAll(handlersFor({ router: r }));
    const detail = await draftDetail(ws, got.body.draftId);
    // 값이 다 맞아도 옮긴 글은 사람이 원본과 대조한다.
    expect(detail).toMatchObject({ status: 'NEEDS_REVIEW', extractedBy: 'llm', reasons: ['TRANSCRIBED'] });
    expect(detail.source).toMatchObject({ kind: 'image', originName: '슬로건 단가.png', text });
    expect(detail.fields.find((f) => f.field === 'name')?.finalValue).toBe(name);
    expect((await draftList(ws)).items[0]).toMatchObject({ id: got.body.draftId, sourceKind: 'image', reasons: ['TRANSCRIBED'] });
  });

  it('PDF 도 같은 길을 탄다. 규칙만으로 뽑히면 사유가 둘 다 붙는다', async () => {
    const ws = await newWorkspace();
    const { text } = goodsText();
    const got = await intakeFile({ bytes: pdf(), name: null }, { workspaceId: ws, now: at(0), router: fakeRouter(fakeAnswer(text)) });
    expect(got.body.source).toMatchObject({ kind: 'pdf', originName: null });
    await drainAll(handlersFor({ router: router({}) }));
    const draft = await getDraft(pool(), ws, got.body.draftId);
    expect(draft?.reasons).toEqual(expect.arrayContaining(['LLM_SKIPPED', 'TRANSCRIBED']));
  });

  it('같은 파일을 다시 올리면 모델을 부르지 않고 있던 건을 돌려준다. 이름이 달라도 같다', async () => {
    const ws = await newWorkspace();
    const bytes = png();
    const step = counted();
    const options = { workspaceId: ws, now: at(0), router: fakeRouter(fakeAnswer(goodsText().text)), transcribe: step };
    const first = await intakeFile({ bytes, name: 'a.png' }, options);
    const second = await intakeFile({ bytes, name: 'b.png' }, options);

    expect(second.created).toBe(false);
    expect(second.body).toMatchObject({ draftId: first.body.draftId, sourceDocId: first.body.sourceDocId, duplicate: true, transcribe: null });
    expect(second.body.source.chars).toBe(first.body.source.chars);
    expect(step.calls).toBe(1);
    expect(await count('source_docs WHERE workspace_id = $1', [ws])).toBe(1);
  });

  it('옮긴 글이 이미 넣은 글과 같으면 그 건을 돌려준다', async () => {
    const ws = await newWorkspace();
    const { text } = goodsText();
    const r = fakeRouter(fakeAnswer(text));
    const first = await intakeFile({ bytes: png() }, { workspaceId: ws, now: at(0), router: r });
    const second = await intakeFile({ bytes: png() }, { workspaceId: ws, now: at(0), router: r });
    expect(second).toMatchObject({ created: false, body: { draftId: first.body.draftId, duplicate: true } });
  });

  it('공간 번호 없이 올리면 새 공간이 생긴다', async () => {
    const got = await intakeFile({ bytes: png() }, { workspaceId: null, now: at(0), kindForNew: 'local', router: fakeRouter(fakeAnswer(goodsText().text)) });
    track(got.body.workspace);
    expect(got.created).toBe(true);
  });
});

describe('올리기를 받지 않는 경우', () => {
  const answer = fakeAnswer(goodsText().text);

  it('형식·크기·쪽수·빈 파일은 모델을 부르기 전에 막는다', async () => {
    const ws = await newWorkspace();
    const step = counted();
    const options = { workspaceId: ws, now: at(0), router: fakeRouter(answer), transcribe: step };
    const big = new Uint8Array(UPLOAD_LIMITS.fileMaxBytes + 1);
    big.set(PNG_HEAD);

    await expect(intakeFile({ bytes: new TextEncoder().encode('그냥 글자') }, options)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
    // 이름이 png 여도 머리 바이트가 아니면 받지 않는다.
    await expect(intakeFile({ bytes: new TextEncoder().encode('GIF89a...'), name: '사진.png' }, options)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
    await expect(intakeFile({ bytes: big }, options)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(intakeFile({ bytes: pdf(UPLOAD_LIMITS.pdfMaxPages + 1) }, options)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(intakeFile({ bytes: new Uint8Array(0) }, options)).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(step.calls).toBe(0);
    expect(await count('source_docs WHERE workspace_id = $1', [ws])).toBe(0);
  });

  it('쪽 이름을 16진 표기로 바꿔 적어도(/P#61ge) 쪽수 상한에 걸린다', async () => {
    const ws = await newWorkspace();
    const step = counted();
    const options = { workspaceId: ws, now: at(0), router: fakeRouter(answer), transcribe: step };
    const hex = new TextEncoder().encode(`%PDF-1.7\n${'<< /Type /P#61ge >>\n'.repeat(100)}<< /Type /Pages >>\n`);
    expect(countPdfPagesRoughly(hex)).toBe(100);
    await expect(intakeFile({ bytes: hex }, options)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    const typeHex = new TextEncoder().encode(`%PDF-1.7\n${'<< /Ty#70e/#50age >>\n'.repeat(11)}`);
    await expect(intakeFile({ bytes: typeHex }, options)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(step.calls).toBe(0);
  });

  it('눌린 객체 묶음 안의 쪽도 센다. 그래도 쪽수를 세지 못한 PDF 는 받지 않는다(415)', async () => {
    const ws = await newWorkspace();
    const step = counted();
    const options = { workspaceId: ws, now: at(0), router: fakeRouter(answer), transcribe: step };
    const packed = (pages: number) => {
      const body = deflateSync(Buffer.from('<< /Type /Page >> '.repeat(pages)));
      return Buffer.concat([Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /ObjStm /N ${pages} /Filter /FlateDecode /Length ${body.length} >>\nstream\n`), body, Buffer.from('\nendstream\nendobj\n')]);
    };
    expect(countPdfPages(packed(3))).toBe(3);
    expect(countPdfPages(packed(40))).toBe(40);
    await expect(intakeFile({ bytes: packed(UPLOAD_LIMITS.pdfMaxPages + 1) }, options)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    // 쪽 표식이 어디에도 없는 PDF: 몇 쪽인지 모른 채 모델에 넘기지 않는다.
    await expect(intakeFile({ bytes: new TextEncoder().encode('%PDF-1.7\nstream...') }, options)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
    expect(step.calls).toBe(0);
    // 상한 안의 눌린 PDF 는 받는다.
    await expect(intakeFile({ bytes: packed(2) }, options)).resolves.toMatchObject({ created: true });
    expect(step.calls).toBe(1);
  });

  it('오늘 접수 상한이 찬 날에는 모델을 부르기 전에 429 를 낸다. 실제 호출 자리도 쓰지 않는다', async () => {
    const ws = await newWorkspace();
    const live = liveStub();
    const options = { workspaceId: ws, now: CAP_DAY, router: router({ providerKind: 'anthropic', liveProvider: live, dailyCap: 10 }) };
    await bumpCounter(pool(), 'intake', CAP_DAY, LIMITS.intakePerDay, LIMITS.intakePerDay);
    for (let i = 0; i < 3; i += 1) {
      await expect(intakeFile({ bytes: png() }, options)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    }
    // 공간 번호 없이 와도 같다. 빈 공간도 남기지 않는다.
    const before = await count('workspaces');
    await expect(intakeFile({ bytes: png() }, { ...options, workspaceId: null })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(await count('workspaces')).toBe(before);
    expect(live.calls).toBe(0);
    expect(await readCounter(pool(), 'live_llm', CAP_DAY)).toBe(0);
  });

  it('공간이 꽉 찼으면 모델을 부르기 전에 429 를 낸다', async () => {
    const ws = await newWorkspace();
    await pool().query(
      `WITH docs AS (
         INSERT INTO source_docs (workspace_id, clean_text, content_hash)
         SELECT $1, '글 ' || g, 'file-fill-' || g FROM generate_series(1, $2::int) g RETURNING id)
       INSERT INTO drafts (workspace_id, source_doc_id) SELECT $1, id FROM docs`,
      [ws, LIMITS.draftsPerWorkspace],
    );
    const step = counted();
    const tried = intakeFile({ bytes: png() }, { workspaceId: ws, now: at(0), router: fakeRouter(answer), transcribe: step });
    await expect(tried).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(step.calls).toBe(0);
  });

  it('접수한 그림은 하루 접수 수에 한 건으로 잡힌다', async () => {
    const ws = await newWorkspace();
    const before = await readCounter(pool(), 'intake', CAP_DAY);
    await intakeFile({ bytes: png() }, { workspaceId: ws, now: CAP_DAY, router: fakeRouter(fakeAnswer(goodsText().text)) });
    expect(await readCounter(pool(), 'intake', CAP_DAY)).toBe(before + 1);
  });

  it('글자를 읽을 수 없는 파일은 422 이고 접수되지 않는다', async () => {
    const ws = await newWorkspace();
    const unreadable = fakeRouter(() => ({ text: '', readable: false }));
    await expect(intakeFile({ bytes: png() }, { workspaceId: ws, now: at(0), router: unreadable })).rejects.toMatchObject({ code: 'UNREADABLE_FILE' });
    expect(await count('source_docs WHERE workspace_id = $1', [ws])).toBe(0);
  });

  it('옮긴 글이 글 상한을 넘으면 400 이다', async () => {
    const ws = await newWorkspace();
    const long = fakeRouter(fakeAnswer('가'.repeat(4001)));
    await expect(intakeFile({ bytes: png() }, { workspaceId: ws, now: at(0), router: long })).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('모델을 부를 수 없으면 접수하지 않고 까닭을 함께 알린다. 그림에는 규칙만 길이 없다', async () => {
    const ws = await newWorkspace();
    const noKey = intakeFile({ bytes: png() }, { workspaceId: ws, now: at(0), router: router({}) });
    await expect(noKey).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE', skipCause: 'no_key' });
    const off = intakeFile({ bytes: png() }, { workspaceId: ws, now: at(0), router: router({ providerKind: 'anthropic', apiKey: 'k', dailyCap: 0 }) });
    await expect(off).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE', skipCause: 'off' });
    expect((await off.catch((e) => e.toBody())).skipCause).toBe('off');
    expect(await count('source_docs WHERE workspace_id = $1', [ws])).toBe(0);
  });

  it('오늘 실제 호출 상한이 차면 429 이다', async () => {
    const ws = await newWorkspace();
    const live = liveStub();
    const options = { workspaceId: ws, now: CAP_DAY, router: router({ providerKind: 'anthropic', liveProvider: live, dailyCap: 1 }) };
    const first = await intakeFile({ bytes: png() }, options);
    expect(first.body.transcribe).toMatchObject({ live: true, recorded: false, originalLatencyMs: 1234 });
    await expect(intakeFile({ bytes: png() }, options)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', skipCause: 'daily_cap' });
    expect(live.calls).toBe(1);
    expect(await readCounter(pool(), 'live_llm', CAP_DAY)).toBe(1);
  });

  it('본보기 공간에는 올리지 못한다. 모델도 부르지 않는다', async () => {
    await ensurePublicWorkspace(pool(), at(0));
    const step = counted();
    const tried = intakeFile({ bytes: png() }, { workspaceId: PUBLIC_WORKSPACE_ID, now: at(0), router: fakeRouter(answer), transcribe: step });
    await expect(tried).rejects.toMatchObject({ code: 'READ_ONLY_WORKSPACE' });
    expect(step.calls).toBe(0);
  });
});
