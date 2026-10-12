// 확인 화면의 API 가 확인 기록(gold_reviews)에 한 줄을 쓰는지 본다.
// 서버를 띄우지 않고 경로 파일의 함수를 바로 부른다. npm run test:db 에서 돈다(시험용 PostgreSQL, 이름이 _test 로 끝나는 DB).
// 이 시험은 앱의 연결 풀로 커밋까지 간다. 옆에서 도는 시험이 그 줄을 보지 않게, 이 시험만 쓰는 스키마를 만들고 끝나면 통째로 지운다.
// 표기 지시 파일도 시험용으로 따로 만든다(진짜 정답 세트의 파일을 읽지 않는다).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GoldDoc } from '@/contract/eval-types';
import { closePool, getPool } from '@/server/db';
import { GET as getQueue } from '../../app/label/api/queue/route';
import { POST as postReview } from '../../app/label/api/review/route';
import { POST as postUndo } from '../../app/label/api/undo/route';
import { migrate } from '../../scripts/migrate';
import { assemble } from './assemble';
import { generateSpecs } from './generate';
import { loadDocs } from './store';

config({ path: '.env.local', quiet: true });
const url = process.env.TEST_DATABASE_URL;
// 이름이 _test 로 끝나는 DB 에서만 돈다(_test_b 처럼 꼬리가 하나 더 붙은 것도 된다). tests/setup 의 지킴이와 같은 틀이다.
const usable = url !== undefined && /_test(_[a-z0-9]+)?$/.test(new URL(url).pathname);

const SCHEMA = `label_api_${process.pid}`;
const DOC_ID = 'hand-998';
const spec = generateSpecs(11).find((s) => s.type === 'ad') as ReturnType<typeof generateSpecs>[number];
const made = assemble([spec], [{ id: spec.id, content: `${spec.surface_hints.flatMap((h) => h.tokens).join(' ')} `.padEnd(120, '가') }]).docs[0] as GoldDoc;
const doc: GoldDoc = { ...made, id: DOC_ID, split: 'hand' };

// 목표 고르기를 볼 연습 묶음 여섯 건. 이 시험만 쓰는 스키마에 싣는다.
const devSpecs = generateSpecs(11).filter((s) => s.split === 'dev').slice(0, 6);
const devDocs: GoldDoc[] = assemble(
  devSpecs,
  devSpecs.map((s) => ({ id: s.id, content: `${[...s.surface_hints.flatMap((h) => h.tokens), ...s.must_include].join(' ')} `.padEnd(120, '가') })),
).docs;

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const post = (body: unknown) => postReview(new Request('http://localhost/label/api/review', json(body)));
const undo = (body: unknown) => postUndo(new Request('http://localhost/label/api/undo', json(body)));

describe.skipIf(!usable)('확인 화면의 API', { timeout: 20_000, shuffle: false }, () => {
  const before = { db: process.env.DATABASE_URL, label: process.env.LABEL_ENABLED, hints: process.env.LABEL_HINTS_PATH, target: process.env.LABEL_TARGET_DEV };
  let dir = '';
  let hintsFile = '';
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  const reviews = async () => {
    const { rows } = await getPool().query('SELECT pass, verdict, fixed_fields, seconds, reviewed_at FROM gold_reviews WHERE gold_doc_id = $1 ORDER BY id', [DOC_ID]);
    return rows as { pass: number; verdict: string; fixed_fields: number; seconds: number | null; reviewed_at: Date }[];
  };

  /** 시험용 DB 에 연결해 한 가지 일을 하고 닫는다. */
  const admin = async (sql: string) => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    await admin(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
    // 이 스키마만 보는 주소. 표도 여기에 새로 만든다.
    const scoped = new URL(url as string);
    scoped.searchParams.set('options', `-c search_path=${SCHEMA}`);
    await migrate(scoped.toString());
    // 앱이 읽는 주소를 바꾼다.
    process.env.DATABASE_URL = scoped.toString();
    await loadDocs(getPool(), [doc]);
    // 시험용 표기 지시 파일
    dir = await mkdtemp(path.join(os.tmpdir(), 'label-api-'));
    hintsFile = path.join(dir, 'specs.json');
    await writeFile(hintsFile, JSON.stringify({ seed: 11, specs: [{ ...spec, id: DOC_ID }, ...devSpecs] }), 'utf8');
  });

  beforeEach(() => {
    process.env.LABEL_ENABLED = '1';
    process.env.LABEL_HINTS_PATH = hintsFile;
  });

  afterAll(async () => {
    await closePool();
    await admin(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await rm(dir, { recursive: true, force: true });
    restore('DATABASE_URL', before.db);
    restore('LABEL_ENABLED', before.label);
    restore('LABEL_HINTS_PATH', before.hints);
    restore('LABEL_TARGET_DEV', before.target);
  });

  it('LABEL_ENABLED 가 1 이 아니면 404 이고 아무것도 적지 않는다', async () => {
    delete process.env.LABEL_ENABLED;
    expect((await post({ docId: DOC_ID, pass: 1, seconds: 5 })).status).toBe(404);
    expect((await getQueue(new Request(`http://localhost/label/api/queue?id=${DOC_ID}`))).status).toBe(404);
    process.env.LABEL_ENABLED = '0';
    expect((await post({ docId: DOC_ID, pass: 1, seconds: 5 })).status).toBe(404);
    expect(await reviews()).toEqual([]);
  });

  it('줄을 물으면 문서가 원문과 정답과 함께 온다', async () => {
    const res = await getQueue(new Request(`http://localhost/label/api/queue?id=${DOC_ID}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { docs: GoldDoc[] };
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0]).toMatchObject({ id: DOC_ID, content: doc.content });
    expect(body.docs[0]?.truth.fields.name).toBe(doc.truth.fields.name);
  });

  it('맞음을 보내면 확인 기록에 한 줄이 남는다(판정, 고친 칸 0, 걸린 초)', async () => {
    const res = await post({ docId: DOC_ID, pass: 1, drop: false, fixes: {}, seconds: 37.4 });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { reviewId: string };
    expect(out).toMatchObject({ verdict: 'ok', fixedFields: 0, before: null });
    expect(out.reviewId).toMatch(/^\d+$/);
    const rows = await reviews();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pass: 1, verdict: 'ok', fixed_fields: 0, seconds: 37 });
    expect(rows[0]?.reviewed_at).toBeInstanceOf(Date);
  });

  it('적은 줄은 다른 연결에서도 보인다(커밋까지 갔다)', async () => {
    const other = new Client({ connectionString: url });
    await other.connect();
    try {
      const { rows } = await other.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.gold_reviews WHERE gold_doc_id = $1`, [DOC_ID]);
      expect(rows[0]).toEqual({ n: 1 });
    } finally {
      await other.end();
    }
  });

  it('고친 칸을 보내면 정답이 바뀌고 한 줄이 더 남는다', async () => {
    const res = await post({ docId: DOC_ID, pass: 1, fixes: { name: '고친 이름', vat_included: doc.truth.fields.vat_included ?? null }, seconds: 12 });
    const out = (await res.json()) as { before: GoldDoc['truth'] };
    expect(out).toMatchObject({ verdict: 'fixed', fixedFields: 1 });
    expect(out.before.fields.name).toBe(doc.truth.fields.name);
    const { rows } = await getPool().query("SELECT truth->'fields'->>'name' AS name FROM gold_docs WHERE id = $1", [DOC_ID]);
    expect(rows[0]).toEqual({ name: '고친 이름' });
    expect((await reviews()).map((r) => r.verdict)).toEqual(['ok', 'fixed']);
  });

  it('다시 보기는 pass 2 로 남는다', async () => {
    expect((await post({ docId: DOC_ID, pass: 2, seconds: 8 })).status).toBe(200);
    expect((await reviews()).map((r) => r.pass)).toEqual([1, 1, 2]);
  });

  it('꼴이 다른 요청은 400, 없는 문서는 404 이고 줄이 늘지 않는다', async () => {
    const count = (await reviews()).length;
    expect((await post({ docId: DOC_ID })).status).toBe(400);
    expect((await post({ docId: DOC_ID, pass: 3 })).status).toBe(400);
    expect((await post({ docId: DOC_ID, pass: 1, fixes: { price_krw: '백만원' } })).status).toBe(400);
    expect((await post({ docId: DOC_ID, pass: 1, fixes: { material: '아크릴' } })).status).toBe(400);
    expect((await post({ docId: 'hand-000', pass: 1 })).status).toBe(404);
    expect((await reviews()).length).toBe(count);
  });

  it('줄에는 그 문서의 표기 조각과 지금까지 걸린 초가 함께 온다', async () => {
    const res = await getQueue(new Request(`http://localhost/label/api/queue?id=${DOC_ID}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hints: Record<string, { field: string; tokens: string[] }[]>; seconds: number[] };
    expect(Object.keys(body.hints)).toEqual([DOC_ID]);
    const hints = body.hints[DOC_ID] ?? [];
    expect(hints.map((h) => h.field)).toEqual(spec.surface_hints.map((h) => h.field));
    for (const h of hints) for (const t of h.tokens) expect(doc.content).toContain(t);
    // 조각만 내려간다. 정답 값이나 글 쓰는 이에게 준 말은 싣지 않는다.
    expect([...new Set(hints.flatMap((h) => Object.keys(h)))].every((k) => ['field', 'tokens', 'unit', 'declareUnit'].includes(k))).toBe(true);
    // 첫 확인에 걸린 초만(다시 보기의 8초는 빠진다)
    expect(body.seconds).toEqual([37, 12]);
  });

  it('표기 지시 파일이 없거나 깨졌으면 강조 없이 예전처럼 돈다', async () => {
    for (const file of [path.join(dir, '없는-파일.json'), path.join(dir, 'broken.json')]) {
      if (file.endsWith('broken.json')) await writeFile(file, '{ 깨진 글', 'utf8');
      process.env.LABEL_HINTS_PATH = file;
      const res = await getQueue(new Request(`http://localhost/label/api/queue?id=${DOC_ID}`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { docs: GoldDoc[]; hints: Record<string, unknown> };
      expect(body.docs).toHaveLength(1);
      expect(body.hints).toEqual({});
    }
  });

  it('되돌리기: 방금 그 판정만 지우고, 고친 정답은 고치기 전 값으로 돌린다', async () => {
    const nameNow = async () => ((await getPool().query("SELECT truth->'fields'->>'name' AS name FROM gold_docs WHERE id = $1", [DOC_ID])).rows[0] as { name: string }).name;
    const start = (await reviews()).length;
    const nameBefore = await nameNow();

    const made = (await (await post({ docId: DOC_ID, pass: 1, fixes: { name: '잘못 고친 이름' }, seconds: 4 })).json()) as { verdict: string; reviewId: string; before: GoldDoc['truth'] };
    expect(made.verdict).toBe('fixed');
    expect(made.before.fields.name).toBe(nameBefore);
    expect(await nameNow()).toBe('잘못 고친 이름');

    // 방금 그 판정이 아니면(번호가 다르면), 고치기 전 정답이 없으면, 꼴이 다르면 받지 않는다.
    expect((await undo({ docId: DOC_ID, reviewId: String(Number(made.reviewId) - 1), before: made.before })).status).toBe(409);
    expect((await undo({ docId: DOC_ID, reviewId: made.reviewId })).status).toBe(400);
    expect((await undo({ docId: DOC_ID })).status).toBe(400);
    expect((await undo({ docId: DOC_ID, reviewId: 'abc' })).status).toBe(400);
    expect((await undo({ docId: 'hand-000', reviewId: made.reviewId })).status).toBe(404);
    expect((await reviews()).length).toBe(start + 1);
    expect(await nameNow()).toBe('잘못 고친 이름');

    const res = await undo({ docId: DOC_ID, reviewId: made.reviewId, before: made.before });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verdict: 'fixed', restored: true });
    expect((await reviews()).length).toBe(start);
    expect(await nameNow()).toBe(nameBefore);

    // 두 번 누르면 두 번째는 받지 않는다. 화면이 꺼져 있으면 404.
    expect((await undo({ docId: DOC_ID, reviewId: made.reviewId, before: made.before })).status).toBe(409);
    delete process.env.LABEL_ENABLED;
    expect((await undo({ docId: DOC_ID, reviewId: made.reviewId, before: made.before })).status).toBe(404);
    expect((await reviews()).length).toBe(start);
  });

  it('되돌리기는 기록 번호를 수로 견준다(9번 다음에 적은 10번이 가장 최근이다)', async () => {
    // 이 시험만 쓰는 스키마의 번호표를 8 로 돌려, 다음 두 줄이 9번과 10번이 되게 한다. 글자로 견주면 "9"가 "10"보다 뒤다.
    await getPool().query("SELECT setval(pg_get_serial_sequence('gold_reviews', 'id'), 8)");
    const nine = (await (await post({ docId: DOC_ID, pass: 1, seconds: 1 })).json()) as { reviewId: string };
    const ten = (await (await post({ docId: DOC_ID, pass: 1, seconds: 1 })).json()) as { reviewId: string };
    expect([nine.reviewId, ten.reviewId]).toEqual(['9', '10']);
    expect((await undo({ docId: DOC_ID, reviewId: nine.reviewId })).status).toBe(409);
    expect((await undo({ docId: DOC_ID, reviewId: ten.reviewId })).status).toBe(200);
    expect((await undo({ docId: DOC_ID, reviewId: nine.reviewId })).status).toBe(200);
  });

  it('목표: 고른 문서만 줄에 나오고, 따로 확인한 문서는 목표에 들어온다', async () => {
    expect(devDocs).toHaveLength(6);
    await loadDocs(getPool(), devDocs);
    process.env.LABEL_TARGET_DEV = '3';
    const ask = async () =>
      (await (await getQueue(new Request('http://localhost/label/api/queue?split=dev'))).json()) as { docs: GoldDoc[]; total: number; done: number; hints: Record<string, unknown> };
    const ids = (q: { docs: GoldDoc[] }) => q.docs.map((d) => d.id);

    const first = await ask();
    expect(first).toMatchObject({ total: 3, done: 0 });
    expect(first.docs).toHaveLength(3);
    expect(Object.keys(first.hints).sort()).toEqual([...ids(first)].sort());
    expect(ids(await ask())).toEqual(ids(first));

    // 목표 밖 문서를 따로 확인하면 목표에 들어오고, 건수는 그대로다.
    const outside = devDocs.find((d) => !ids(first).includes(d.id)) as GoldDoc;
    const made = (await (await post({ docId: outside.id, pass: 1, seconds: 3 })).json()) as { reviewId: string };
    const second = await ask();
    expect(second).toMatchObject({ total: 3, done: 1 });
    expect(second.docs).toHaveLength(2);
    expect(ids(second).every((id) => ids(first).includes(id))).toBe(true);

    // 되돌리면 처음 목표로 돌아간다.
    expect((await undo({ docId: outside.id, reviewId: made.reviewId })).status).toBe(200);
    expect(ids(await ask())).toEqual(ids(first));

    // 버린 문서는 "반드시 넣는 문서"가 아니다.
    await post({ docId: outside.id, pass: 1, drop: true, seconds: 1 });
    expect(ids(await ask())).toEqual(ids(first));

    // 목표가 묶음보다 크면 전부 본다.
    process.env.LABEL_TARGET_DEV = '50';
    expect(await ask()).toMatchObject({ total: 6, done: 1 });
  });
});
