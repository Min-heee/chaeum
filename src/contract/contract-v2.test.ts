// v0.2 에서 늘어난 약속(그림·PDF, 실제 호출의 길, 양식 맞춤 파일, 경로별 꼴)이 서로 어긋나지 않는지 본다.
import { describe, expect, it } from 'vitest';
import {
  API_ERRORS,
  ApiErrorBodySchema,
  BulkIntakeRequestSchema,
  ConflictBodySchema,
  DraftDetailResponseSchema,
  DraftListQuerySchema,
  ExportQuerySchema,
  IntakeResponseSchema,
  JOB_KINDS,
  LIMITS,
  PatchFieldsRequestSchema,
  PUBLIC_WORKSPACE_ID,
  RejectRequestSchema,
  SampleSchema,
  SOURCE_KINDS,
  SourceFileResponseSchema,
} from './api';
import { ATTACHMENT_KINDS, attachmentKindOf, isMediaTypeOf } from './attachments';
import { CONTENT_CHECK_LIMITS, ContentCheckRequestSchema, ContentCheckResponseSchema } from './content';
import { isDocAllCorrect } from './eval-types';
import { EXPORT_SOURCES, ExportTemplateSchema, isExportTemplateName } from './export-template';
import { FIELD_KEYS } from './fields';
import { LLM_TASKS, LLM_UNAVAILABLE_CODES, TranscriptionSchema } from './llm-types';
import {
  afterLlmFailure,
  checkUpload,
  cleanOriginName,
  countPdfPagesRoughly,
  LIVE_LLM,
  parseDailyCap,
  PIPELINE_STEPS,
  planLlmRoute,
  sniffMediaType,
  STEP_JOB_KIND,
  UPLOAD_LIMITS,
  type LlmRouteInput,
} from './pipeline-api';
import { isBlocking, LLM_SKIP_CAUSES, LLM_SKIP_LABELS, REASONS } from './reasons';
import { QUOTE_TASKS } from './tools/quote';

const bytes = (...head: number[]) => new Uint8Array([...head, ...new Array<number>(32).fill(0)]);
const ascii = (text: string) => new Uint8Array([...text].map((ch) => ch.charCodeAt(0)));

describe('그림·PDF 의 약속', () => {
  it('원문 종류는 글 + 첨부 종류 둘 + 가져온 줄이다', () => {
    expect(SOURCE_KINDS).toEqual(['text', ...ATTACHMENT_KINDS, 'import']);
  });

  it('받는 형식은 그림 셋과 PDF 뿐이다', () => {
    expect(attachmentKindOf('image/png')).toBe('image');
    expect(attachmentKindOf('application/pdf')).toBe('pdf');
    expect(attachmentKindOf('image/gif')).toBeNull();
    expect(isMediaTypeOf('image', 'application/pdf')).toBe(false);
  });

  it('형식은 파일 머리 바이트로 알아낸다', () => {
    expect(sniffMediaType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMediaType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffMediaType(ascii('RIFF\u0010\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffMediaType(ascii('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffMediaType(ascii('GIF89a......'))).toBeNull();
    expect(sniffMediaType(ascii('RIFF\u0010\u0000\u0000\u0000WAVEfmt '))).toBeNull();
    expect(sniffMediaType(new Uint8Array())).toBeNull();
  });

  it('올리기 검사: 빈 파일, 큰 파일, 모르는 형식, 쪽이 많은 PDF 를 막는다', () => {
    expect(checkUpload(new Uint8Array())).toEqual({ ok: false, problem: 'empty' });
    expect(checkUpload(ascii('hello world'))).toEqual({ ok: false, problem: 'unsupported' });
    expect(checkUpload(bytes(0xff, 0xd8, 0xff))).toEqual({ ok: true, kind: 'image', mediaType: 'image/jpeg' });

    const big = new Uint8Array(UPLOAD_LIMITS.fileMaxBytes + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect(checkUpload(big)).toEqual({ ok: false, problem: 'too_large' });

    const page = '<< /Type /Page /Parent 1 0 R >>\n';
    const pdf = (pages: number) => ascii(`%PDF-1.7\n<< /Type /Pages /Count ${pages} >>\n${page.repeat(pages)}`);
    expect(countPdfPagesRoughly(pdf(3))).toBe(3);
    expect(checkUpload(pdf(UPLOAD_LIMITS.pdfMaxPages))).toEqual({ ok: true, kind: 'pdf', mediaType: 'application/pdf' });
    expect(checkUpload(pdf(UPLOAD_LIMITS.pdfMaxPages + 1))).toEqual({ ok: false, problem: 'too_many_pages' });
    const locked = new Uint8Array([...pdf(1), ...new TextEncoder().encode('trailer << /Encrypt 5 0 R >>')]);
    expect(checkUpload(locked)).toEqual({ ok: false, problem: 'encrypted' });
    // 쪽 표식을 못 찾으면(눌린 PDF) 모름이고, 막지 않는다.
    expect(checkUpload(ascii('%PDF-1.7\nstream...'))).toMatchObject({ ok: true, kind: 'pdf' });
  });

  it('파일 하나가 호스팅의 요청 본문 한도(4.5MB) 안에 든다', () => {
    expect(UPLOAD_LIMITS.fileMaxBytes).toBe(3 * 1024 * 1024);
    expect(UPLOAD_LIMITS.fileMaxBytes).toBeLessThan(UPLOAD_LIMITS.requestMaxBytes);
    expect(UPLOAD_LIMITS.requestMaxBytes).toBeLessThanOrEqual(4.5 * 1024 * 1024);
  });

  it('파일 이름은 경로를 떼고 길이를 자른다', () => {
    expect(cleanOriginName('C:\\자료\\단가표 10월.png')).toBe('단가표 10월.png');
    expect(cleanOriginName('../../etc/단가표.pdf')).toBe('단가표.pdf');
    expect(cleanOriginName('  \u0000 ')).toBeNull();
    expect(cleanOriginName(undefined)).toBeNull();
    expect([...(cleanOriginName('가'.repeat(500)) ?? '')]).toHaveLength(UPLOAD_LIMITS.originNameMaxChars);
  });

  it('글로 옮긴 답의 꼴과 사유', () => {
    expect(TranscriptionSchema.safeParse({ text: '1주 150', readable: true }).success).toBe(true);
    expect(TranscriptionSchema.safeParse({ text: '1주 150' }).success).toBe(false);
    expect(REASONS.TRANSCRIBED.scope).toBe('draft');
    expect(isBlocking('TRANSCRIBED')).toBe(true);
  });
});

describe('단계와 작업 줄', () => {
  it('단계 셋은 LLM 일의 앞 셋과 같고, 글로 옮기기만 줄을 타지 않는다', () => {
    expect([...PIPELINE_STEPS]).toEqual(LLM_TASKS.slice(0, 3));
    expect(LLM_TASKS.slice(3)).toEqual([...QUOTE_TASKS]);
    expect(STEP_JOB_KIND.transcribe).toBeNull();
    expect(PIPELINE_STEPS.map((s) => STEP_JOB_KIND[s]).filter(Boolean)).toEqual([...JOB_KINDS]);
  });
});

describe('어느 LLM 길을 쓸지', () => {
  const live: LlmRouteInput = { hasRecording: false, providerKind: 'anthropic', hasKey: true, dailyCap: 50, textChars: 300 };

  it('녹화가 있으면 실제 호출이 열려 있어도 녹화를 쓴다', () => {
    expect(planLlmRoute({ ...live, hasRecording: true })).toEqual({ route: 'replay' });
    expect(planLlmRoute({ ...live, hasRecording: true, hasKey: false, providerKind: 'replay', dailyCap: 0 })).toEqual({ route: 'replay' });
  });

  it('녹화가 없고 실제 호출이 열려 있으면 자리를 잡고 부른다', () => {
    expect(planLlmRoute(live)).toEqual({ route: 'anthropic', needsSlot: true });
    expect(planLlmRoute({ ...live, textChars: LIVE_LLM.textMaxChars })).toEqual({ route: 'anthropic', needsSlot: true });
    expect(planLlmRoute({ ...live, textChars: 0 })).toEqual({ route: 'anthropic', needsSlot: true });
  });

  it('아니면 규칙만 길이고 원인이 남는다', () => {
    expect(planLlmRoute({ ...live, hasKey: false })).toEqual({ route: 'rules', cause: 'no_key' });
    expect(planLlmRoute({ ...live, hasKey: false, providerKind: 'replay' })).toEqual({ route: 'rules', cause: 'no_key' });
    expect(planLlmRoute({ ...live, providerKind: 'replay' })).toEqual({ route: 'rules', cause: 'cache_miss' });
    expect(planLlmRoute({ ...live, dailyCap: 0 })).toEqual({ route: 'rules', cause: 'off' });
    expect(planLlmRoute({ ...live, textChars: LIVE_LLM.textMaxChars + 1 })).toEqual({ route: 'rules', cause: 'too_long' });
  });

  it('시험용 방식은 늘 시험용 구현으로 간다', () => {
    expect(planLlmRoute({ ...live, providerKind: 'fake', hasKey: false, dailyCap: 0 })).toEqual({ route: 'fake' });
  });

  it('하루 상한: 기본은 꺼짐, 이상한 값도 꺼짐, 큰 값은 자른다', () => {
    expect(LIVE_LLM.defaultDailyCap).toBe(0);
    expect(LIVE_LLM.textMaxChars).toBe(LIMITS.liveLlmTextMaxChars);
    for (const raw of [undefined, '', ' ', '0', '-3', '1.5', 'abc', 'NaN']) expect(parseDailyCap(raw), String(raw)).toBe(0);
    expect(parseDailyCap(' 200 ')).toBe(200);
    expect(parseDailyCap('999999')).toBe(LIVE_LLM.hardDailyCap);
  });

  it('호출이 실패하면: 잠깐의 오류는 시도가 남았을 때만 다시, 그 밖은 원인을 남기고 내려간다', () => {
    expect(afterLlmFailure('TRANSIENT', 1, 3)).toBe('retry');
    expect(afterLlmFailure('TRANSIENT', 3, 3)).toBe('error');
    expect(afterLlmFailure('REFUSAL', 1)).toBe('refusal');
    expect(afterLlmFailure('NO_KEY', 1)).toBe('no_key');
    expect(afterLlmFailure('CACHE_MISS', 1)).toBe('cache_miss');
    for (const code of LLM_UNAVAILABLE_CODES) {
      const next = afterLlmFailure(code, 3, 3);
      expect(next === 'retry' || (LLM_SKIP_CAUSES as readonly string[]).includes(next), code).toBe(true);
    }
    expect(Object.keys(LLM_SKIP_LABELS).sort()).toEqual([...LLM_SKIP_CAUSES].sort());
  });
});

describe('양식 맞춤 파일', () => {
  const template = {
    name: 'default',
    columns: [
      { header: '상품명', from: 'name' },
      { header: '가로(m)', from: 'size_m', format: 'width' },
      { header: '통화', value: 'KRW' },
      { header: 'Title', from: 'title_en' },
    ],
  };

  it('바른 틀은 통과한다. 칸 이름은 전부 값의 출처가 된다', () => {
    expect(ExportTemplateSchema.safeParse(template).success).toBe(true);
    for (const key of FIELD_KEYS) expect(EXPORT_SOURCES).toContain(key);
    expect(new Set(EXPORT_SOURCES).size).toBe(EXPORT_SOURCES.length);
  });

  it('모르는 칸, 같은 칸 이름 두 번, from 과 value 를 함께 적은 것, 빈 틀은 실패한다', () => {
    const withColumns = (columns: unknown[]) => ExportTemplateSchema.safeParse({ ...template, columns }).success;
    expect(withColumns([{ header: '가수', from: 'artist' }])).toBe(false);
    expect(withColumns([{ header: '이름', from: 'name' }, { header: '이름', from: 'region' }])).toBe(false);
    expect(withColumns([{ header: '이름', from: 'name', value: 'x' }])).toBe(false);
    expect(withColumns([{ header: '이름', from: 'name', format: 'upper' }])).toBe(false);
    expect(withColumns([])).toBe(false);
  });

  it('틀 이름에는 경로 글자가 들어갈 수 없다', () => {
    expect(isExportTemplateName('market-b')).toBe(true);
    for (const bad of ['../secret', 'a/b', 'A', '', 'a.json', '-a']) expect(isExportTemplateName(bad), bad).toBe(false);
    expect(ExportQuerySchema.safeParse({ kind: 'products', template: '../x' }).success).toBe(false);
    expect(ExportQuerySchema.parse({})).toEqual({ kind: 'products' });
  });
});

describe('경로별 꼴', () => {
  const intake = { workspace: '6f1c2a34-5b6c-4d7e-8f90-123456789abc', sourceDocId: 41, draftId: 41, status: 'PROCESSING', duplicate: false };

  it('접수 응답과 그림 올리기 응답', () => {
    expect(IntakeResponseSchema.safeParse(intake).success).toBe(true);
    expect(IntakeResponseSchema.safeParse({ ...intake, workspace: PUBLIC_WORKSPACE_ID }).success).toBe(true);
    const file = {
      ...intake,
      source: { kind: 'image', originName: '단가표.png', chars: 312 },
      transcribe: { recorded: false, live: true, originalLatencyMs: 2100, originalCostUsd: 0.0009 },
    };
    expect(SourceFileResponseSchema.safeParse(file).success).toBe(true);
    expect(SourceFileResponseSchema.safeParse({ ...file, transcribe: null }).success).toBe(true);
    expect(SourceFileResponseSchema.safeParse({ ...file, source: { ...file.source, kind: 'text' } }).success).toBe(false);
  });

  it('여러 건 접수: 글 목록이나 CSV 글 가운데 하나만', () => {
    expect(BulkIntakeRequestSchema.safeParse({ texts: ['가', '나'] }).success).toBe(true);
    expect(BulkIntakeRequestSchema.safeParse({ csv: 'text\n가\n나' }).success).toBe(true);
    expect(BulkIntakeRequestSchema.safeParse({ texts: ['가'], csv: '나' }).success).toBe(false);
    expect(BulkIntakeRequestSchema.safeParse({ texts: new Array(LIMITS.bulkMaxDocs + 1).fill('가') }).success).toBe(false);
  });

  it('검수함의 주소 값: 글자로 온 쪽 번호를 수로 읽고, 모르는 상태는 막는다', () => {
    expect(DraftListQuerySchema.parse({ status: 'READY', cursor: '12' })).toEqual({ status: 'READY', cursor: 12 });
    expect(DraftListQuerySchema.safeParse({ status: 'DONE' }).success).toBe(false);
    expect(DraftListQuerySchema.safeParse({ reason: 'TRANSCRIBED' }).success).toBe(true);
  });

  it('초안 상세: llm 칸과 원문 종류가 들어 있다', () => {
    const detail = {
      id: 41, status: 'NEEDS_REVIEW', version: 2, type: 'ad', subtype: '전광판',
      reasons: ['LLM_SKIPPED', 'TRANSCRIBED'], extractedBy: 'rules',
      llm: { recorded: false, live: false, skipCause: 'daily_cap', originalLatencyMs: null, originalCostUsd: null, model: null, promptVersion: null },
      source: { id: 41, kind: 'pdf', originName: null, text: '합정역 8번 출구 전광판 1주 150' },
      fields: [
        { field: 'hours', raw: '05시~25시', modelValue: null, codeValue: { open: '05:00', close: '01:00', nextDay: true },
          finalValue: { open: '05:00', close: '01:00', nextDay: true }, evidence: '05시~25시', reasons: [], editedByHuman: false },
      ],
      reject: null, productId: null,
      events: [{ id: 1, actor: 'system', action: 'status', from: 'PROCESSING', to: 'NEEDS_REVIEW', field: null, before: null, after: null, reasonCode: null, at: '2026-01-01T00:00:00.000Z' }],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    };
    expect(DraftDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(DraftDetailResponseSchema.safeParse({ ...detail, llm: { ...detail.llm, skipCause: 'busy' } }).success).toBe(false);
    expect(DraftDetailResponseSchema.safeParse({ ...detail, fields: [{ ...detail.fields[0], field: 'artist' }] }).success).toBe(false);
  });

  it('칸 고치기: version 이 꼭 있고 고칠 것이 하나는 있어야 한다', () => {
    expect(PatchFieldsRequestSchema.safeParse({ version: 2, edits: { price_krw: 1500000 } }).success).toBe(true);
    expect(PatchFieldsRequestSchema.safeParse({ version: 2, edits: { footfall_per_day: null } }).success).toBe(true);
    expect(PatchFieldsRequestSchema.safeParse({ version: 2, type: 'goods', subtype: '인쇄물' }).success).toBe(true);
    expect(PatchFieldsRequestSchema.safeParse({ version: 2, edits: {} }).success).toBe(false);
    expect(PatchFieldsRequestSchema.safeParse({ edits: { price_krw: 1 } }).success).toBe(false);
  });

  it('반려에는 사유 코드가 꼭 있다', () => {
    expect(RejectRequestSchema.safeParse({ version: 1, reasonCode: 'DUPLICATE' }).success).toBe(true);
    expect(RejectRequestSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(RejectRequestSchema.safeParse({ version: 1, reasonCode: 'BORING' }).success).toBe(false);
  });

  it('오류 본문: 409 에는 지금 상태가, 그림 올리기 실패에는 원인이 함께 간다', () => {
    const conflict = { code: 'VERSION_CONFLICT', message: '다른 사람이 먼저 바꿨습니다', current: { status: 'APPROVED', version: 3 } };
    expect(ConflictBodySchema.safeParse(conflict).success).toBe(true);
    expect(ConflictBodySchema.safeParse({ code: 'VERSION_CONFLICT', message: 'x' }).success).toBe(false);
    expect(ApiErrorBodySchema.safeParse({ code: 'LLM_UNAVAILABLE', message: 'x', skipCause: 'off' }).success).toBe(true);
    expect(ApiErrorBodySchema.safeParse({ code: 'TEAPOT', message: 'x' }).success).toBe(false);
    expect(API_ERRORS.FILE_TOO_LARGE).toBe(413);
    expect(API_ERRORS.UNSUPPORTED_FILE).toBe(415);
    expect(API_ERRORS.UNREADABLE_FILE).toBe(422);
    expect(API_ERRORS.LLM_UNAVAILABLE).toBe(503);
  });

  it('보기 글', () => {
    const sample = { id: 'sample-01', label: '메신저 말투', style: 'messenger', type: 'ad', text: '합정역 전광판 문의드려요' };
    expect(SampleSchema.safeParse(sample).success).toBe(true);
    expect(SampleSchema.safeParse({ ...sample, text: '가'.repeat(LIMITS.textMaxChars + 1) }).success).toBe(false);
  });
});

describe('번역 검사 API 의 꼴', () => {
  it('요청: 언어·칸·글이 있어야 하고 50건까지다', () => {
    const item = { lang: 'en', field: 'title', text: 'Hapjeong Station LED Billboard' };
    expect(ContentCheckRequestSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(ContentCheckRequestSchema.safeParse({ items: [{ ...item, allowedNumbers: ['7', '1500000'], sourceKo: '합정역 전광판' }] }).success).toBe(true);
    expect(ContentCheckRequestSchema.safeParse({ items: [] }).success).toBe(false);
    expect(ContentCheckRequestSchema.safeParse({ items: [{ ...item, lang: 'ja' }] }).success).toBe(false);
    expect(ContentCheckRequestSchema.safeParse({ items: new Array(CONTENT_CHECK_LIMITS.maxItems + 1).fill(item) }).success).toBe(false);
  });

  it('응답: 검사 5종의 결과가 모두 있어야 한다', () => {
    const result = {
      id: null, index: 0, lang: 'zh-Hans', field: 'summary', status: 'needs_review', failCodes: ['HANGUL_IN_TEXT'],
      checks: { placeholder: 'pass', number: 'skipped', language: 'fail', monologue: 'pass', glossary: 'pass' },
    };
    const body = { results: [result], summary: { total: 1, ok: 0, needsReview: 1, withSkipped: 0 } };
    expect(ContentCheckResponseSchema.safeParse(body).success).toBe(true);
    const { glossary: _dropped, ...four } = result.checks;
    void _dropped;
    expect(ContentCheckResponseSchema.safeParse({ ...body, results: [{ ...result, checks: four }] }).success).toBe(false);
  });
});

describe('평가의 약속', () => {
  it('전부 맞은 문서: 틀린 판정이 하나도 없다', () => {
    expect(isDocAllCorrect([{ verdict: 'correct' }, { verdict: 'true_none' }])).toBe(true);
    expect(isDocAllCorrect([{ verdict: 'correct' }, { verdict: 'fabricated' }])).toBe(false);
    expect(isDocAllCorrect([{ verdict: 'missed' }])).toBe(false);
    expect(isDocAllCorrect([])).toBe(true);
  });
});
