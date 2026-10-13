// 실제 자료 넣기와 손글 쓰기의 DB 일과 API. npm run test:db 에서 돈다(시험용 PostgreSQL, 이름이 _test 로 끝나는 DB).
// 서버를 띄우지 않고 경로 파일의 함수를 바로 부른다. 모델은 부르지 않는다(정해 둔 답을 주는 가짜 공급자를 넘긴다. 키는 시험 동안 지운다).
// 이 시험만 쓰는 스키마와 임시 폴더를 만들고 끝나면 통째로 지운다. 저장소의 정답 파일은 건드리지 않는다.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import os from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GoldDoc } from '@/contract/eval-types';
import type { Extraction } from '@/contract/fields';
import { LlmUnavailable, type LlmCallRecord, type LlmProvider, type LlmRequest } from '@/contract/llm-types';
import { buildExtractRequest, cacheKeyFor, createProvider, MemoryCallStore } from '@/llm';
import { closePool, getPool } from '@/server/db';
import { GET as getHand, POST as postHand } from '../../app/label/api/hand/route';
import { GET as getReal, POST as postReal } from '../../app/label/api/real/route';
import RealPage from '../../app/label/real/page';
import { migrate } from '../../scripts/migrate';
import { parseJsonl, readJsonlFile } from './files';
import { HAND_FILE, REAL_EDITS_FILE, REAL_SOURCES_FILE, realGoldFile, realIntakeFile } from './paths';
import {
  checkIntakeInput,
  createIntake,
  createIntakeLocked,
  dumpIntakes,
  failedRealCalls,
  listIntakes,
  loadIntakeDump,
  parseIntakeDump,
  realEdits,
  realProgress,
  realSources,
  resetFailedRealCalls,
  seedIntakeCalls,
  type Intake,
} from './real';
import { listDocs, listReviews, loadDocs, recheckQueue, reviewSeconds } from './store';

config({ path: '.env.local', quiet: true });
const url = process.env.TEST_DATABASE_URL;
const usable = url !== undefined && /_test(_[a-z0-9]+)?$/.test(new URL(url).pathname);

const SCHEMA = `real_hand_${process.pid}`;

// 직접 지은 글. 실제 회사나 상품이 아니다.
const TEXT_AD = '가나다미디어 전광판 안내\n위치: 합정역 3번 출구\n1주 150만원 (VAT 별도)\n운영 05시~25시\n한 번 15초';
const TEXT_GOODS = '아크릴 키링 제작 안내\n크기 50mm x 50mm, 재질 아크릴 3T\n최소 30개부터, 개당 2,500원';
const TEXT_ODD = '풍선 아치 설치 서비스 안내\n1세트 20만원';

/** 정해 둔 답: 위치를 틀리게 읽고(합정 → 사람이 고친다), 한 번 길이는 맞게, 부가세는 놓친다. */
const answerFor = (text: string): Extraction =>
  text.includes('전광판')
    ? {
        type: 'ad',
        subtype: '전광판',
        fields: [
          { field: 'name', raw: '가나다미디어 전광판', value: '가나다미디어 전광판', evidence: '가나다미디어 전광판 안내' },
          { field: 'price_krw', raw: '150만원', value: 1_500_000, evidence: '1주 150만원' },
          { field: 'region', raw: '합정', value: '합정', evidence: '위치: 합정역 3번 출구' },
          { field: 'spot_seconds', raw: '15초', value: 15, evidence: '한 번 15초' },
        ],
      }
    : { type: 'goods', subtype: '잡화', fields: [{ field: 'name', raw: '아크릴 키링', value: '아크릴 키링', evidence: '아크릴 키링 제작 안내' }] };

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const real = (body: unknown) => postReal(new Request('http://localhost/label/api/real', json(body)));
const hand = (body: unknown) => postHand(new Request('http://localhost/label/api/hand', json(body)));

describe.skipIf(!usable)('실제 자료 넣기와 손글 쓰기', { timeout: 30_000, shuffle: false }, () => {
  const names = ['DATABASE_URL', 'LABEL_ENABLED', 'SEALED_GOLD_PATH', 'ANTHROPIC_API_KEY', 'LABEL_REAL_CALL_CAP'] as const;
  const before = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  let dir = '';
  let repoFiles: Record<string, number | null> = {};
  const store = new MemoryCallStore();
  let calls = 0;
  const live = createProvider({
    kind: 'fake',
    fakeAnswer: (req) => {
      calls += 1;
      return answerFor((req.input as { text?: string }).text ?? JSON.stringify(req.input));
    },
  });
  const source = (content: string, n = 1) => ({ content, sourceUrl: `https://example.com/item/${n}`, fetchedOn: '2026-10-13', kind: 'page' as const });
  const draft = async (content: string, n = 1, cap = 10): Promise<Intake> => (await createIntake(getPool(), source(content, n), { store, live, cap })).intake;

  const admin = async (sql: string) => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  /** 저장소 안의 정답 파일들의 고친 시각. 시험이 끝난 뒤에도 같아야 한다. */
  const repoState = async () =>
    Object.fromEntries(await Promise.all([HAND_FILE, REAL_SOURCES_FILE, REAL_EDITS_FILE, path.join('data', 'gold', 'real.jsonl')].map(async (f) => [f, existsSync(f) ? (await stat(f)).mtimeMs : null] as const)));

  beforeAll(async () => {
    repoFiles = await repoState();
    await admin(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
    const scoped = new URL(url as string);
    scoped.searchParams.set('options', `-c search_path=${SCHEMA}`);
    await migrate(scoped.toString());
    process.env.DATABASE_URL = scoped.toString();
    dir = await mkdtemp(path.join(os.tmpdir(), 'real-hand-'));
    process.env.SEALED_GOLD_PATH = dir;
    // 이 시험은 진짜 모델을 부르지 않는다.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LABEL_REAL_CALL_CAP;
  });

  beforeEach(() => {
    process.env.LABEL_ENABLED = '1';
  });

  afterAll(async () => {
    await closePool();
    await admin(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await rm(dir, { recursive: true, force: true });
    for (const n of names) {
      if (before[n] === undefined) delete process.env[n];
      else process.env[n] = before[n];
    }
  });

  it('꺼져 있으면 두 API 모두 404 이고 아무것도 적지 않는다', async () => {
    delete process.env.LABEL_ENABLED;
    expect((await real({ action: 'draft', ...source(TEXT_AD) })).status).toBe(404);
    expect((await getReal(new Request('http://localhost/label/api/real?id=1'))).status).toBe(404);
    expect((await hand({ action: 'save', content: '글', type: 'not_product' })).status).toBe(404);
    expect((await getHand(new Request('http://localhost/label/api/hand?id=hand-001'))).status).toBe(404);
    process.env.LABEL_ENABLED = 'true';
    expect((await real({ action: 'skip', intakeId: '1' })).status).toBe(404);
    expect(await listIntakes(getPool())).toEqual([]);
    expect(await listDocs(getPool())).toEqual([]);
  });

  it('넣는 글과 출처의 꼴을 본다. 키가 없으면 초안을 채우지 않는다(규칙만 길로 내려가지 않는다)', async () => {
    expect((await real({ action: 'draft', ...source(TEXT_AD), content: '   ' })).status).toBe(400);
    expect((await real({ action: 'draft', ...source(TEXT_AD), sourceUrl: '어딘가' })).status).toBe(400);
    expect((await real({ action: 'draft', ...source(TEXT_AD), fetchedOn: '어제' })).status).toBe(400);
    expect((await real({ action: 'draft', ...source(TEXT_AD), kind: 'upload' })).status).toBe(400);
    expect((await real({ action: 'draft', ...source('가'.repeat(4001)) })).status).toBe(400);
    const noKey = await real({ action: 'draft', ...source(TEXT_AD) });
    expect(noKey.status).toBe(400);
    expect(((await noKey.json()) as { error: string }).error).toContain('ANTHROPIC_API_KEY');
    expect((await real({ action: '모름' })).status).toBe(400);
    expect(await listIntakes(getPool())).toEqual([]);
  });

  let first: Intake;

  it('초안: 얼린 파이프라인의 값·근거·표시가 남고, 같은 글은 다시 부르지 않는다', async () => {
    first = await draft(TEXT_AD);
    expect(calls).toBe(1);
    expect(first).toMatchObject({ status: 'open', called: true, modelName: 'claude-haiku-5-5', promptVersion: 'extract-v1', goldDocId: null, kind: 'page' });
    expect(first.model.type).toBe('ad');
    expect(first.model.fields.price_krw).toMatchObject({ value: 1_500_000, evidence: '1주 150만원' });
    expect(first.model.fields.region?.value).toBe('합정');
    expect(first.model.fields.hours?.value ?? null).toBeNull();

    // 같은 글을 다시 넣으면 그 초안을 돌려준다. 호출도 줄도 늘지 않는다.
    // 줄바꿈·공백만 다른 글도 같은 글이다(넣을 때 앱의 접수와 같은 정리를 거친다).
    const again = await createIntake(getPool(), checkIntakeInput(source(`  ${TEXT_AD}\n\n`.replace(/\n/g, '\r\n'), 9)), { store, live, cap: 10 });
    expect(again).toMatchObject({ resumed: true, intake: { id: first.id, sourceUrl: 'https://example.com/item/1' } });
    expect(calls).toBe(1);

    const res = await getReal(new Request(`http://localhost/label/api/real?id=${first.id}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { intake: { hints: { field: string; tokens: string[] }[] }; progress: { calls: number; saved: number; open: number } };
    expect(body.intake.hints.find((h) => h.field === 'region')?.tokens).toEqual(['위치: 합정역 3번 출구']);
    expect(body.progress).toMatchObject({ calls: 1, saved: 0, open: 1 });
    expect((await getReal(new Request('http://localhost/label/api/real?id=999'))).status).toBe(404);
  });

  it('실제 호출은 따로 세고 상한에서 멈춘다', async () => {
    await expect(draft(TEXT_GOODS, 2, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(calls).toBe(1);
    expect(await listIntakes(getPool())).toHaveLength(1);
  });

  it('답을 못 받은 호출도 상한에 센다(이 서버가 뜬 뒤의 것만). 키가 없어 부르지 못한 것은 세지 않는다', async () => {
    resetFailedRealCalls();
    const broken: LlmProvider = { name: 'anthropic', model: 'claude-haiku-5-5', complete: async () => Promise.reject(new LlmUnavailable('BAD_OUTPUT')) };
    await expect(createIntake(getPool(), source(TEXT_GOODS, 2), { store, live: broken, cap: 10 })).rejects.toMatchObject({ code: 'INVALID' });
    expect(failedRealCalls()).toBe(1);
    expect(await listIntakes(getPool())).toHaveLength(1);
    // 답을 받은 호출 1 + 못 받은 호출 1 = 2. 상한이 2 면 더 부르지 않는다.
    await expect(draft(TEXT_GOODS, 2, 2)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(calls).toBe(1);
    const noKey: LlmProvider = { ...broken, complete: async () => Promise.reject(new LlmUnavailable('NO_KEY')) };
    await expect(createIntake(getPool(), source(TEXT_GOODS, 2), { store, live: noKey, cap: 10 })).rejects.toMatchObject({ code: 'INVALID' });
    expect(failedRealCalls()).toBe(1);
    resetFailedRealCalls();
  });

  it('초안 채우기는 한 번에 하나만 돈다: 겹쳐 보낸 같은 글은 한 번만 부르고 줄도 하나만 생긴다', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const slow: LlmProvider = { name: live.name, model: live.model, complete: async <T>(req: LlmRequest<T>) => (await gate, live.complete(req)) };
    const text = '겹쳐 누른 전광판 글';
    const settle = (p: Promise<unknown>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
    const a = settle(createIntakeLocked(getPool(), source(text, 8), { store, live: slow, cap: 10 }));
    const b = settle(createIntakeLocked(getPool(), source(text, 8), { store, live: slow, cap: 10 }));
    // 먼저 끝나는 쪽은 잠금을 못 잡은 쪽이다(잡은 쪽은 모델의 답을 기다리고 있다).
    const loser = await Promise.race([a, b]);
    expect(loser).toMatchObject({ ok: false, e: { code: 'CONFLICT' } });
    open();
    const done = await Promise.all([a, b]);
    expect(done.filter((r) => r.ok)).toHaveLength(1);
    expect(calls).toBe(2);
    const rows = (await listIntakes(getPool())).filter((i) => i.content === text);
    expect(rows).toHaveLength(1);
    // 잠금은 풀려 있다: 같은 글을 다시 보내면 그 초안을 돌려준다.
    expect(await createIntakeLocked(getPool(), source(text, 8), { store, live: slow, cap: 10 })).toMatchObject({ resumed: true });
    // 뒤의 시험이 세는 건수에 끼지 않게 지운다.
    await getPool().query('DELETE FROM gold_real_intake WHERE id = $1::bigint', [rows[0]?.id]);
  });

  it('원문을 둘 자리가 상대 경로이거나 저장소 안이면 확정이 실패하고, 정답 문서도 파일도 생기지 않는다', async () => {
    const fields = { name: '가나다미디어 전광판', price_krw: 1_500_000, region: '합정', spot_seconds: 15 };
    const inRepo = ['data/gold', './sealed', 'sealed/test.jsonl', path.join(process.cwd(), 'data', 'gold'), process.cwd()];
    try {
      for (const bad of inRepo) {
        process.env.SEALED_GOLD_PATH = bad;
        const res = await real({ action: 'confirm', intakeId: first.id, type: 'ad', subtype: '전광판', fields });
        expect(res.status, bad).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain('SEALED_GOLD_PATH');
      }
    } finally {
      process.env.SEALED_GOLD_PATH = dir;
    }
    expect(await listDocs(getPool(), 'real')).toEqual([]);
    expect(await listReviews(getPool())).toEqual([]);
    expect((await listIntakes(getPool())).find((i) => i.id === first.id)?.status).toBe('open');
    for (const f of [path.join('data', 'gold', 'real.jsonl'), path.join('sealed', 'real.jsonl'), 'real.jsonl']) expect(existsSync(f), f).toBe(false);
    expect(await repoState()).toEqual(repoFiles);
  });

  let confirmed: { docId: string; reviewId: string };

  it('확정: 정답 문서(real)와 확인 기록이 생기고, 원문은 저장소 밖의 파일로만 간다', async () => {
    const fields = { name: '가나다미디어 전광판', price_krw: 1_500_000, region: '합정역 3번 출구', spot_seconds: 15, vat_included: false, hours: { open: '05:00', close: '01:00', nextDay: true } };
    expect((await real({ action: 'confirm', intakeId: first.id, type: 'ad', subtype: '케이크', fields })).status).toBe(400);
    expect((await real({ action: 'confirm', intakeId: first.id, type: 'ad', subtype: '전광판', fields: { ...fields, size_mm: { width: 1, height: 1 } } })).status).toBe(400);
    expect((await real({ action: 'confirm', intakeId: first.id, type: 'ad', subtype: '전광판', fields: { ...fields, price_krw: '150만' } })).status).toBe(400);
    expect((await real({ action: 'confirm', intakeId: '999', type: 'ad', subtype: '전광판', fields })).status).toBe(404);
    expect(await listDocs(getPool(), 'real')).toEqual([]);

    const res = await real({ action: 'confirm', intakeId: first.id, type: 'ad', subtype: '전광판', fields, seconds: 41.6 });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { docId: string; reviewId: string; verdict: string; changed: number; progress: { saved: number; tally: Record<string, number> } };
    confirmed = out;
    // 위치를 고쳤고(1), 부가세와 운영 시간을 새로 넣었다(2).
    expect(out).toMatchObject({ docId: 'real-001', verdict: 'fixed', changed: 3 });
    expect(out.progress.saved).toBe(1);
    expect(out.progress.tally).toMatchObject({ docs: 1, modelFilled: 4, kept: 3, fixed: 1, added: 2, removed: 0, untouchedDocs: 0 });

    const docs = await listDocs(getPool(), 'real');
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ id: 'real-001', split: 'real', author: 'human', content: TEXT_AD });
    expect(docs[0]?.truth.fields).toMatchObject({ region: '합정역 3번 출구', vat_included: false, size_m: null });
    expect((await listReviews(getPool())).filter((r) => r.goldDocId === 'real-001')).toMatchObject([{ pass: 1, verdict: 'fixed', fixedFields: 3, seconds: 42 }]);

    // 파일: 저장소 밖(시험용 폴더)에만 생긴다.
    expect(realGoldFile()).toBe(path.join(dir, 'real.jsonl'));
    expect((await readJsonlFile(realGoldFile()))?.map((d) => d.id)).toEqual(['real-001']);
    expect(await repoState()).toEqual(repoFiles);

    // 이미 확정한 건은 다시 확정되지 않고, 같은 글도 다시 넣을 수 없다.
    expect((await real({ action: 'confirm', intakeId: first.id, type: 'ad', subtype: '전광판', fields })).status).toBe(409);
    await expect(draft(TEXT_AD)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('되돌리기: 방금 그 확정만 지운다. 정답 문서·확인 기록·파일의 줄이 함께 사라지고 초안은 남는다', async () => {
    expect((await real({ action: 'undo', intakeId: first.id, reviewId: String(Number(confirmed.reviewId) + 5) })).status).toBe(409);
    expect((await real({ action: 'undo', intakeId: first.id })).status).toBe(409);
    expect(await listDocs(getPool(), 'real')).toHaveLength(1);
    // 파일의 자리가 틀렸으면 되돌리기도 DB 를 건드리지 않는다.
    process.env.SEALED_GOLD_PATH = 'data/gold';
    expect((await real({ action: 'undo', intakeId: first.id, reviewId: confirmed.reviewId })).status).toBe(400);
    process.env.SEALED_GOLD_PATH = dir;
    expect(await listDocs(getPool(), 'real')).toHaveLength(1);
    expect(existsSync(path.join('data', 'gold', 'real.jsonl'))).toBe(false);

    const res = await real({ action: 'undo', intakeId: first.id, reviewId: confirmed.reviewId });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { removedDocId: string; intake: { status: string; model: { type: string } }; progress: { saved: number; open: number; calls: number } };
    expect(out).toMatchObject({ removedDocId: 'real-001', intake: { status: 'open', model: { type: 'ad' } }, progress: { saved: 0, open: 1, calls: 1 } });
    expect(await listDocs(getPool(), 'real')).toEqual([]);
    expect(await listReviews(getPool())).toEqual([]);
    expect(await readJsonlFile(realGoldFile())).toEqual([]);
    expect((await real({ action: 'undo', intakeId: first.id, reviewId: confirmed.reviewId })).status).toBe(409);

    // 다시 확정하면 같은 번호를 다시 쓴다. 이번에는 초안 그대로(바꾼 것 없음).
    const same = { name: '가나다미디어 전광판', price_krw: 1_500_000, region: '합정', spot_seconds: 15 };
    const again = (await (await real({ action: 'confirm', intakeId: first.id, type: 'ad', subtype: '전광판', fields: same, seconds: 3 })).json()) as { docId: string; verdict: string; changed: number };
    expect(again).toMatchObject({ docId: 'real-001', verdict: 'ok', changed: 0 });
  });

  it('종류를 바꿔 확정하거나("등록 대상 아님"), 우리 양식에 없는 상품이면 넘긴다. 넘김도 되돌릴 수 있다', async () => {
    const goods = await draft(TEXT_GOODS, 2);
    const asNone = (await (await real({ action: 'confirm', intakeId: goods.id, type: 'not_product', subtype: '잡화', fields: {} })).json()) as { docId: string; changed: number };
    // 종류를 바꿨고(갈래는 따라 바뀐 것이라 따로 세지 않는다), 모델이 낸 이름을 지웠다.
    expect(asNone).toMatchObject({ docId: 'real-002', changed: 2 });
    expect((await listDocs(getPool(), 'real'))[1]?.truth).toEqual({ type: 'not_product', subtype: null, fields: {} });

    const odd = await draft(TEXT_ODD, 3);
    expect((await real({ action: 'skip', intakeId: odd.id, note: '우리 양식에 없는 상품' })).status).toBe(200);
    expect((await real({ action: 'skip', intakeId: odd.id })).status).toBe(409);
    expect((await real({ action: 'confirm', intakeId: odd.id, type: 'not_product', fields: {} })).status).toBe(409);
    expect((await real({ action: 'undo', intakeId: odd.id })).status).toBe(200);
    expect((await listIntakes(getPool())).find((i) => i.id === odd.id)?.status).toBe('open');
    expect((await real({ action: 'skip', intakeId: odd.id })).status).toBe(200);

    expect(await realProgress(getPool())).toMatchObject({ target: 20, saved: 2, skipped: 1, open: 0, calls: 3 });
    expect((await readJsonlFile(realGoldFile()))?.map((d) => d.id)).toEqual(['real-001', 'real-002']);
  });

  it('저장소에 남길 것에는 원문도 값도 없다. 값이 든 줄은 저장소 밖으로 가고, 다시 실으면 같은 셈이 나온다', async () => {
    const sources = await realSources(getPool());
    expect(sources).toEqual([
      { id: 'real-001', sourceUrl: 'https://example.com/item/1', fetchedOn: '2026-10-13', kind: 'page', status: 'saved' },
      { id: 'real-002', sourceUrl: 'https://example.com/item/2', fetchedOn: '2026-10-13', kind: 'page', status: 'saved' },
      { id: null, sourceUrl: 'https://example.com/item/3', fetchedOn: '2026-10-13', kind: 'page', status: 'skipped', note: '우리 양식에 없는 상품' },
    ]);
    const edits = await realEdits(getPool());
    expect(edits.docs.map((d) => d.id)).toEqual(['real-001', 'real-002']);
    // 문서마다 확정할 때 본 초가 함께 실린다(너무 빨리 넘긴 건을 가려 볼 수 있게).
    expect(edits.docs[0]).toMatchObject({ untouched: true, seconds: 3, fields: { name: 'kept', region: 'kept', size_m: 'kept_none' } });
    expect(edits.docs[1]?.seconds).toBeNull();
    expect(edits.docs[1]).toMatchObject({ typeChanged: true, untouched: false, fields: { name: 'removed' } });
    expect(edits.tally).toMatchObject({ docs: 2, modelFilled: 5, fixed: 0, removed: 1, added: 0, untouchedDocs: 1, typeChanged: 1 });
    const repoSide = JSON.stringify([sources, edits]);
    for (const piece of ['가나다미디어', '합정', '아크릴', '풍선', '1500000']) expect(repoSide, piece).not.toContain(piece);

    // 정답을 나중에 다시 고치면(확인 화면에서) 셈도 지금 정답을 따른다.
    await getPool().query(`UPDATE gold_docs SET truth = jsonb_set(truth, '{fields,region}', '"합정역"') WHERE id = 'real-001'`);
    expect((await realEdits(getPool())).tally).toMatchObject({ fixed: 1, untouchedDocs: 0 });

    // 저장소 밖의 줄: 정답 문서가 된 건의 원문은 real.jsonl 에 있으므로 싣지 않는다.
    const dump = await dumpIntakes(getPool());
    expect(dump.map((l) => [l.status, l.content === null])).toEqual([['saved', true], ['saved', true], ['skipped', false]]);
    expect(dump[0]?.origin?.fields.find((f) => f.field === 'region')).toMatchObject({ modelValue: '합정', humanValue: '합정역', action: 'fixed' });
    expect(realIntakeFile()).toBe(path.join(dir, 'real-intake.jsonl'));

    // 장부를 넘기면 초안을 만든 호출의 답이 줄에 함께 실리고, 새 장부에 다시 심을 수 있다(DB 를 새로 만들어도 real 평가가 같은 답을 쓴다).
    const key = cacheKeyFor(buildExtractRequest(TEXT_AD) as LlmRequest<unknown>, 'claude-haiku-5-5');
    const record: LlmCallRecord = { task: 'extract', provider: 'anthropic', model: 'claude-haiku-5-5', promptVersion: 'extract-v1', cacheKey: key, response: answerFor(TEXT_AD), stopReason: 'end_turn', inputTokens: 10, outputTokens: 5, costUsd: 0.0015, latencyMs: 9, isRecorded: false };
    const withCalls = await dumpIntakes(getPool(), new MemoryCallStore([record]));
    expect(withCalls.map((l) => l.call?.cacheKey ?? null)).toEqual([key, null, null]);
    const fresh = new MemoryCallStore();
    const reread = parseIntakeDump(withCalls.map((l) => `${JSON.stringify(l)}\n`).join(''));
    expect(await seedIntakeCalls(fresh, reread)).toBe(1);
    expect(await seedIntakeCalls(fresh, reread)).toBe(0);
    expect(await fresh.find(key)).toMatchObject({ provider: 'anthropic', response: answerFor(TEXT_AD), isRecorded: true });
    expect(dump[0]?.call).toBeUndefined();

    // 표를 비우고 파일에서 다시 싣는다.
    const lines = parseIntakeDump(dump.map((l) => `${JSON.stringify(l)}\n`).join(''));
    const docs = parseJsonl(await readFile(realGoldFile(), 'utf8')).map((d: GoldDoc) => (d.id === 'real-001' ? { ...d, truth: { ...d.truth, fields: { ...d.truth.fields, region: '합정역' } } } : d));
    const reviews = await listReviews(getPool());
    await getPool().query('DELETE FROM gold_real_intake');
    await getPool().query("DELETE FROM gold_docs WHERE split = 'real'");
    expect(await loadIntakeDump(getPool(), lines)).toBe(1); // 문서가 없으면 넘긴 건만 실린다
    await loadDocs(getPool(), docs);
    expect(await loadIntakeDump(getPool(), lines)).toBe(2);
    expect(await loadIntakeDump(getPool(), lines)).toBe(0);
    expect((await realEdits(getPool())).tally).toMatchObject({ docs: 2, fixed: 1, removed: 1 });
    expect(await realSources(getPool())).toEqual(sources);
    expect(reviews).toHaveLength(2);
    // 다음에 넣는 글의 번호가 겹치지 않는다.
    expect(Number((await draft('새로 넣는 전광판 글', 4)).id)).toBeGreaterThan(Number(lines[lines.length - 1]?.intakeId));
  });

  it('손글: 새로 쓰면 다음 번호로 저장되고, 고쳐 쓰고, 방금 쓴 것만 지울 수 있다. 모델을 부르지 않는다', async () => {
    const callsBefore = calls;
    const base = { action: 'save', content: '\n\n다라마 커피차 안내\r\n100잔 80만원, 서울 전 지역  \n\n', type: 'catering', subtype: '커피차' };
    expect((await hand({ ...base, content: ' ' })).status).toBe(400);
    expect((await hand({ ...base, type: '음식' })).status).toBe(400);
    expect((await hand({ ...base, subtype: null })).status).toBe(400);
    expect((await hand({ ...base, fields: { region: '서울' } })).status).toBe(400);
    expect((await hand({ ...base, fields: { price_krw: 800_000.5 } })).status).toBe(400);

    const fields = { name: '다라마 커피차', price_krw: 800_000, service_region: '서울 전 지역', quantity_options: [{ qty: 100, price_krw: 800_000 }] };
    const res = await hand({ ...base, fields, tipIds: ['missing', 'bare_amount', '없는 귀띔'], seconds: 300 });
    expect(res.status).toBe(200);
    const made = (await res.json()) as { docId: string; reviewId: string; created: boolean; progress: { target: number; docs: { id: string }[] } };
    expect(made).toMatchObject({ docId: 'hand-001', created: true, progress: { target: 10, docs: [{ id: 'hand-001' }] } });

    const got = (await (await getHand(new Request('http://localhost/label/api/hand?id=hand-001'))).json()) as { doc: GoldDoc };
    expect(got.doc).toMatchObject({ split: 'hand', author: 'human', goldVersion: 1, traps: ['missing_field', 'unit'], content: '다라마 커피차 안내\n100잔 80만원, 서울 전 지역' });
    expect(got.doc.truth.fields).toMatchObject({ price_krw: 800_000, list_price_krw: null, service_hours: null });
    expect((await getHand(new Request('http://localhost/label/api/hand?id=real-001'))).status).toBe(404);

    // 고쳐 쓰기: 같은 번호, 확인 기록은 한 줄 더(fixed).
    const fixed = (await (await hand({ ...base, id: 'hand-001', fields: { ...fields, design_deadline_days: 7 }, tipIds: [] })).json()) as { docId: string; created: boolean };
    expect(fixed).toMatchObject({ docId: 'hand-001', created: false, changed: 1 });
    // 확인 기록: 새로 쓴 것은 ok, 고쳐 쓴 것은 fixed 와 정답에서 바뀐 칸 수(여기서는 1). 쓴 사람이 저장하며 남긴 기록이다.
    expect((await listReviews(getPool())).filter((r) => r.goldDocId === 'hand-001')).toMatchObject([
      { pass: 1, verdict: 'ok', fixedFields: 0, seconds: 300 },
      { pass: 1, verdict: 'fixed', fixedFields: 1 },
    ]);
    expect((await listDocs(getPool(), 'hand'))[0]).toMatchObject({ traps: [], truth: { fields: { design_deadline_days: 7 } } });
    expect((await hand({ ...base, id: 'hand-777', fields })).status).toBe(404);
    // 고쳐 쓴 문서는 "방금 새로 쓴 것"이 아니라서 지우지 않는다.
    expect((await hand({ action: 'undo', docId: 'hand-001', reviewId: made.reviewId })).status).toBe(409);

    const second = (await (await hand({ action: 'save', content: '잔금은 금요일까지 부탁드립니다.', type: 'not_product', subtype: null, fields: {}, tipIds: ['not_product'] })).json()) as { docId: string; reviewId: string };
    expect(second.docId).toBe('hand-002');
    expect((await hand({ action: 'undo', docId: 'hand-002', reviewId: '0' })).status).toBe(409);
    expect((await hand({ action: 'undo', docId: 'hand-002', reviewId: second.reviewId })).status).toBe(200);
    expect((await hand({ action: 'undo', docId: 'hand-002', reviewId: second.reviewId })).status).toBe(404);
    expect((await listDocs(getPool(), 'hand')).map((d) => d.id)).toEqual(['hand-001']);

    expect(calls).toBe(callsBefore);
    // 화면이 저장소의 파일을 직접 쓰지 않는다(gold:export 가 쓴다).
    expect(await repoState()).toEqual(repoFiles);
  });

  it('실제 자료·손글을 저장해도 "하루 뒤 다시 보기"의 줄과 남은 시간 어림에 끼지 않는다', async () => {
    // 이 스키마에는 real·hand 문서와 그 첫 확인 기록만 있다.
    expect((await listReviews(getPool())).filter((r) => r.pass === 1).length).toBeGreaterThan(0);
    expect(await recheckQueue(getPool(), 20261012, 10)).toMatchObject({ docs: [], total: 0 });
    expect(await reviewSeconds(getPool(), 1)).toEqual([]);
  });

  it('넣은 글의 표가 아직 없으면(이행 0006 전) 화면과 API 가 오류 대신 안내를 보인다', async () => {
    await getPool().query('ALTER TABLE gold_real_intake RENAME TO gold_real_intake_away');
    try {
      const got = await getReal(new Request('http://localhost/label/api/real?id=1'));
      expect(got.status).toBe(503);
      expect(((await got.json()) as { error: string }).error).toContain('npm run db:migrate');
      expect((await real({ action: 'draft', ...source('표가 없을 때 넣는 글', 9) })).status).toBe(503);
      expect((await real({ action: 'skip', intakeId: '1' })).status).toBe(503);
      const html = renderToStaticMarkup(await RealPage({ searchParams: Promise.resolve({}) }));
      expect(html).toContain('npm run db:migrate');
      // 손글 쓰기는 그 표를 쓰지 않는다.
      expect((await getHand(new Request('http://localhost/label/api/hand?id=hand-001'))).status).toBe(200);
    } finally {
      await getPool().query('ALTER TABLE gold_real_intake_away RENAME TO gold_real_intake');
    }
    expect((await getReal(new Request('http://localhost/label/api/real?id=999'))).status).toBe(404);
  });
});
