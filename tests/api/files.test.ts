// 그림·PDF 올리기, 번역 검사, 보기 글, 살아 있는지, 평가 읽기. 경로 함수를 직접 불러 시험용 DB 로 돈다.
// 방식을 시험용(fake)으로 둔다. 글로 옮기기가 정해 둔 답을 주고, 모델은 한 번도 부르지 않는다.
process.env.LLM_PROVIDER = 'fake';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiErrorBodySchema,
  EvalRunDetailResponseSchema,
  EvalRunListResponseSchema,
  HealthResponseSchema,
  SampleListResponseSchema,
  SourceFileResponseSchema,
  type DraftDetailResponse,
  type EvalRunDetailResponse,
  type SourceFileResponse,
} from '@/contract/api';
import { CONTENT_CHECK_LIMITS, ContentCheckResponseSchema } from '@/contract/content';
import { UPLOAD_LIMITS } from '@/contract/pipeline-api';
import { closePool, getPool } from '@/server/db';
import { POST as contentChecks } from '../../app/api/content-checks/route';
import { GET as draftDetail } from '../../app/api/drafts/[id]/route';
import { GET as evalRun } from '../../app/api/eval/runs/[id]/route';
import { GET as evalRuns } from '../../app/api/eval/runs/route';
import { GET as health } from '../../app/api/health/route';
import { POST as drain } from '../../app/api/jobs/drain/route';
import { GET as samples } from '../../app/api/samples/route';
import { POST as upload } from '../../app/api/source-files/route';
import { count, dropWorkspaces, newWorkspace, track } from '../integration/helpers';
import { call, fileForm, pngBytes, resetToday } from './helpers';

const pool = () => getPool();
const startedAt = new Date();
/** 이 시험이 넣은 평가 실행에 붙이는 표시. 끝에 이 표시로 지운다. */
const COMMIT = 'api-test-eval';

const pdfBytes = (pages: number) =>
  new TextEncoder().encode(`%PDF-1.7\n${'<< /Type /Page >>\n'.repeat(pages)}<< /Type /Pages >>\n`) as Uint8Array<ArrayBuffer>;

beforeAll(async () => {
  await resetToday();
});

beforeEach(async () => {
  await pool().query('TRUNCATE jobs RESTART IDENTITY');
});

afterAll(async () => {
  await pool().query('DELETE FROM eval_runs WHERE git_commit = $1', [COMMIT]);
  // 시험용 방식이 장부에 남긴 줄을 지운다.
  await pool().query(`DELETE FROM llm_calls WHERE provider = 'fake' AND created_at >= $1`, [startedAt]);
  await dropWorkspaces();
  await resetToday();
  await closePool();
});

describe('그림·PDF 올리기', () => {
  it('그림을 올리면 옮긴 글이 접수되고(201), 뽑힌 초안에 "원본과 대조 필요"가 붙는다', async () => {
    const bytes = pngBytes();
    const got = await call<SourceFileResponse>(upload, 'POST', '/api/source-files', { body: fileForm(bytes, 'C:\\자료\\단가표 10월.png') });
    expect(got.status).toBe(201);
    const body = SourceFileResponseSchema.parse(got.body);
    const ws = track(body.workspace);
    expect(body).toMatchObject({ status: 'PROCESSING', duplicate: false, source: { kind: 'image', originName: '단가표 10월.png' } });
    expect(body.source.chars).toBeGreaterThan(0);
    expect(body.transcribe).toMatchObject({ recorded: false });

    expect((await call(drain, 'POST', '/api/jobs/drain')).body).toMatchObject({ done: 1, remaining: 0 });
    const detail = await call<DraftDetailResponse>(draftDetail, 'GET', `/api/drafts/${body.draftId}`, { ws, id: body.draftId });
    expect(detail.body.source).toMatchObject({ kind: 'image', originName: '단가표 10월.png' });
    expect(detail.body.source.text).toContain('커피차');
    expect(detail.body.reasons).toContain('TRANSCRIBED');

    // 파일 자체는 어디에도 남지 않는다. 남는 것은 옮긴 글과 해시다.
    const row = await pool().query<{ file_hash: string; clean_text: string }>('SELECT file_hash, clean_text FROM source_docs WHERE id = $1', [body.sourceDocId]);
    expect(row.rows[0]?.file_hash).toMatch(/^[0-9a-f]{64}$/);

    // 같은 파일을 다시 올리면 모델을 부르지 않고 있던 건을 돌려준다(200).
    const again = await call<SourceFileResponse>(upload, 'POST', '/api/source-files', { ws, body: fileForm(bytes) });
    expect(again.status).toBe(200);
    expect(SourceFileResponseSchema.parse(again.body)).toMatchObject({ duplicate: true, draftId: body.draftId, transcribe: null });
    expect(await count('drafts WHERE workspace_id = $1', [ws])).toBe(1);
  });

  it('PDF 도 같은 길로 들어간다', async () => {
    const ws = await newWorkspace();
    const got = await call<SourceFileResponse>(upload, 'POST', '/api/source-files', { ws, body: fileForm(pdfBytes(2), '안내.pdf') });
    expect(got.status).toBe(201);
    expect(got.body).toMatchObject({ workspace: ws, source: { kind: 'pdf', originName: '안내.pdf' } });
  });

  it('올리기 상한: 파일 3MB, 요청 4MB, PDF 10쪽을 넘으면 413 이고 접수되지 않는다', async () => {
    const ws = await newWorkspace();
    const cases = [
      await call(upload, 'POST', '/api/source-files', { ws, body: fileForm(pngBytes(UPLOAD_LIMITS.fileMaxBytes + 1)) }),
      await call(upload, 'POST', '/api/source-files', { ws, body: fileForm(pngBytes(UPLOAD_LIMITS.requestMaxBytes + 1)) }),
      await call(upload, 'POST', '/api/source-files', { ws, body: fileForm(pdfBytes(UPLOAD_LIMITS.pdfMaxPages + 1), '긴 안내.pdf') }),
      // 길이 헤더만 크게 적어도 본문을 읽기 전에 막는다.
      await call(upload, 'POST', '/api/source-files', {
        ws, body: 'x', headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(UPLOAD_LIMITS.requestMaxBytes + 1) },
      }),
    ];
    for (const got of cases) {
      expect(got.status).toBe(413);
      expect(ApiErrorBodySchema.parse(got.body).code).toBe('FILE_TOO_LARGE');
    }
    // 딱 3MB 는 받는다.
    const edge = await call(upload, 'POST', '/api/source-files', { ws, body: fileForm(pngBytes(UPLOAD_LIMITS.fileMaxBytes)) });
    expect(edge.status).toBe(201);
    expect(await count('drafts WHERE workspace_id = $1', [ws])).toBe(1);
  });

  it('받지 않는 형식은 415. 형식은 이름이 아니라 파일 머리로 본다', async () => {
    const ws = await newWorkspace();
    const text = new TextEncoder().encode('합정역 커피차 100잔 80만원') as Uint8Array<ArrayBuffer>;
    const got = await call(upload, 'POST', '/api/source-files', { ws, body: fileForm(text, '그림인척.png') });
    expect(got.status).toBe(415);
    expect(got.body).toMatchObject({ code: 'UNSUPPORTED_FILE' });
    expect(await count('drafts WHERE workspace_id = $1', [ws])).toBe(0);
  });

  it('파일이 없거나, 둘이거나, 비었거나, multipart 가 아니면 400', async () => {
    const ws = await newWorkspace();
    const two = fileForm(pngBytes());
    two.append('file', new File([pngBytes()], '둘째.png'));
    const notFile = new FormData();
    notFile.append('file', '글자만');
    const cases = [
      await call(upload, 'POST', '/api/source-files', { ws, body: fileForm(pngBytes(), '단가표.png', 'image') }),
      await call(upload, 'POST', '/api/source-files', { ws, body: two }),
      await call(upload, 'POST', '/api/source-files', { ws, body: notFile }),
      await call(upload, 'POST', '/api/source-files', { ws, body: fileForm(new Uint8Array(0)) }),
      await call(upload, 'POST', '/api/source-files', { ws, body: { file: 'abc' } }),
      await call(upload, 'POST', '/api/source-files', { ws, body: '깨진 본문', headers: { 'content-type': 'multipart/form-data; boundary=x' } }),
    ];
    for (const got of cases) {
      expect(got.status).toBe(400);
      expect(got.body).toMatchObject({ code: 'BAD_INPUT' });
    }
    expect(await count('drafts WHERE workspace_id = $1', [ws])).toBe(0);
  });
});

describe('번역 검사', () => {
  it('글마다 검사 결과를 돌려준다. DB 에는 쓰지 않는다', async () => {
    const before = await count('llm_calls');
    const got = await call(contentChecks, 'POST', '/api/content-checks', {
      body: {
        items: [
          { id: 'a', lang: 'en', field: 'title', text: 'Cheering slogan banner' },
          { id: 'b', lang: 'en', field: 'summary', text: '응원 슬로건 현수막입니다' },
          { lang: 'en', field: 'summary', text: 'From KRW 5,000 for 7 days.', allowedNumbers: ['5000'] },
          { lang: 'zh-Hans', field: 'summary', text: '价格为{price}。' },
        ],
      },
    });
    expect(got.status).toBe(200);
    const body = ContentCheckResponseSchema.parse(got.body);
    expect(body.results.map((r) => [r.id, r.index, r.status])).toEqual([
      ['a', 0, 'ok'],
      ['b', 1, 'needs_review'],
      [null, 2, 'needs_review'],
      [null, 3, 'needs_review'],
    ]);
    expect(body.results[0]?.checks.number).toBe('skipped');
    expect(body.results[1]?.checks.language).toBe('fail');
    expect(body.results[2]?.checks.number).toBe('fail');
    expect(body.results[3]?.failCodes).toContain('PLACEHOLDER_LOST');
    expect(body.summary).toMatchObject({ total: 4, ok: 1, needsReview: 3 });
    // 건너뛴 검사가 있는 글이 몇 줄인지 요약에 드러난다(첫 글은 숫자 검사를 건너뛰고도 ok 다).
    expect(body.summary.withSkipped).toBeGreaterThanOrEqual(1);
    expect(await count('llm_calls')).toBe(before);
  });

  it('꼴이 틀리거나 50건을 넘으면 400', async () => {
    const item = { lang: 'en', field: 'title', text: 'Banner' };
    const cases = [
      await call(contentChecks, 'POST', '/api/content-checks', { body: {} }),
      await call(contentChecks, 'POST', '/api/content-checks', { body: { items: [] } }),
      await call(contentChecks, 'POST', '/api/content-checks', { body: { items: [{ ...item, lang: 'ja' }] } }),
      await call(contentChecks, 'POST', '/api/content-checks', { body: { items: [{ ...item, text: 'a'.repeat(CONTENT_CHECK_LIMITS.textMaxChars + 1) }] } }),
      await call(contentChecks, 'POST', '/api/content-checks', { body: { items: Array.from({ length: CONTENT_CHECK_LIMITS.maxItems + 1 }, () => item) } }),
      await call(contentChecks, 'POST', '/api/content-checks', { body: 'items=1' }),
    ];
    for (const got of cases) {
      expect(got.status).toBe(400);
      expect(got.body).toMatchObject({ code: 'BAD_INPUT' });
    }
  });
});

describe('보기 글과 살아 있는지', () => {
  it('보기 글 목록이 약속의 꼴로 온다', async () => {
    const got = await call(samples, 'GET', '/api/samples');
    expect(got.status).toBe(200);
    expect(SampleListResponseSchema.parse(got.body).items.length).toBeGreaterThan(0);
  });

  it('살아 있는지 보기가 약속의 꼴로 온다', async () => {
    const got = await call(health, 'GET', '/api/health');
    expect(got.status).toBe(200);
    expect(HealthResponseSchema.parse(got.body)).toMatchObject({ ok: true, db: true, llm: { provider: 'fake', live: false, liveCap: 0, liveLeftToday: 0 } });
  });
});

describe('평가 읽기', () => {
  /** 실행 하나와 결과 줄을 넣는다. 칸은 [문서, 칸, 판정, 표시] 다. */
  async function seedRun(method: string, cells: [string, string, string, boolean][], split = 'dev'): Promise<number> {
    const run = await pool().query<{ id: string }>(
      `INSERT INTO eval_runs (split, method, model, prompt_version, gold_version, git_commit, metrics, cost_usd, started_at)
       VALUES ($1, $2, 'm', 'p1', 1, $3, '{"docs": 2}', 0.0123, '2001-06-01T00:00:00Z') RETURNING id`,
      [split, method, COMMIT],
    );
    const id = Number(run.rows[0]?.id);
    for (const [doc, field, verdict, flagged] of cells) {
      await pool().query(
        `INSERT INTO eval_results (run_id, gold_doc_id, field, expected, actual, verdict, flagged) VALUES ($1, $2, $3, '5000'::jsonb, '5000'::jsonb, $4, $5)`,
        [id, doc, field, verdict, flagged],
      );
    }
    return id;
  }

  it('목록은 새것부터, 상세는 문서별로 묶여 온다', async () => {
    const first = await seedRun('llm_code', [['d1', 'price_krw', 'wrong', true], ['d1', 'name', 'correct', false], ['d2', 'name', 'correct', false]]);
    const second = await seedRun('llm_code', [['d1', 'price_krw', 'correct', false], ['d1', 'name', 'correct', false], ['d2', 'name', 'missed', false], ['d3', 'name', 'correct', false]]);

    const list = await call(evalRuns, 'GET', '/api/eval/runs');
    expect(list.status).toBe(200);
    const mine = EvalRunListResponseSchema.parse(list.body).items.filter((r) => r.gitCommit === COMMIT);
    expect(mine.map((r) => r.id)).toEqual([second, first]);
    expect(mine[0]).toMatchObject({ split: 'dev', method: 'llm_code', costUsd: 0.0123, metrics: { docs: 2 } });

    const detail = await call<EvalRunDetailResponse>(evalRun, 'GET', `/api/eval/runs/${first}`, { id: first });
    expect(detail.status).toBe(200);
    const body = EvalRunDetailResponseSchema.parse(detail.body);
    expect(body.comparison).toBeNull();
    expect(body.docs.map((d) => [d.goldDocId, d.allCorrect, d.flagged, d.cells.length])).toEqual([['d1', false, true, 2], ['d2', true, false, 1]]);
    expect(body.docs[0]?.cells.find((c) => c.field === 'price_krw')).toMatchObject({ expected: 5000, actual: 5000, verdict: 'wrong', flagged: true });

    // 견주기: against 가 앞, 이 실행이 뒤다.
    const compared = await call<EvalRunDetailResponse>(evalRun, 'GET', `/api/eval/runs/${second}?against=${first}`, { id: second });
    expect(compared.status).toBe(200);
    expect(EvalRunDetailResponseSchema.parse(compared.body).comparison).toEqual({
      baseRunId: first, otherRunId: second, improved: ['d1'], regressed: ['d2'], unchanged: 0, onlyInBase: [], onlyInOther: ['d3'],
    });
  });

  it('없는 실행은 404, 방식이 다른 실행과는 견주지 않는다(400)', async () => {
    const a = await seedRun('llm_code', [['d1', 'name', 'correct', false]]);
    const b = await seedRun('rules', [['d1', 'name', 'correct', false]]);
    expect((await call(evalRun, 'GET', '/api/eval/runs/999999999', { id: 999999999 })).status).toBe(404);
    expect((await call(evalRun, 'GET', `/api/eval/runs/${a}?against=999999999`, { id: a })).status).toBe(404);
    const mixed = await call(evalRun, 'GET', `/api/eval/runs/${a}?against=${b}`, { id: a });
    expect(mixed.status).toBe(400);
    expect(mixed.body).toMatchObject({ code: 'BAD_INPUT' });
    expect((await call(evalRun, 'GET', `/api/eval/runs/${a}?against=abc`, { id: a })).status).toBe(400);
  });

  it('실제 자료 묶음의 결과는 값을 비워 보낸다', async () => {
    const id = await seedRun('llm_code', [['r1', 'price_krw', 'wrong', false]], 'real');
    const detail = await call<EvalRunDetailResponse>(evalRun, 'GET', `/api/eval/runs/${id}`, { id });
    expect(detail.body.docs[0]?.cells[0]).toMatchObject({ expected: null, actual: null, verdict: 'wrong' });
  });
});
