// 정답 세트의 DB 일. npm run test:db 에서 돈다(시험용 PostgreSQL, 이름이 _test 로 끝나는 DB).
// 트랜잭션 하나 안에서 돌고 끝나면 되돌린다. 다른 시험의 자료를 건드리지 않는다.
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GoldDoc } from '@/contract/eval-types';
import { migrate } from '../../scripts/migrate';
import { GOLD_VERSION, assemble } from './assemble';
import { canon } from './files';
import { generateSpecs } from './generate';
import {
  firstPassQueue,
  getDoc,
  GoldError,
  listDocs,
  listReviews,
  loadDocs,
  loadReviews,
  planExport,
  recheckQueue,
  recordReview,
  reviewSeconds,
  summarize,
  undoReview,
} from './store';

config({ path: '.env.local', quiet: true });
const url = process.env.TEST_DATABASE_URL;
// 이름이 _test 로 끝나는 DB 에서만 돈다(_test_b 처럼 꼬리가 하나 더 붙은 것도 된다). tests/setup 의 지킴이와 같은 틀이다.
const usable = url !== undefined && /_test(_[a-z0-9]+)?$/.test(new URL(url).pathname);

// 진짜 정답과 겹치지 않게 손글 묶음의 높은 번호를 쓴다.
const specs = generateSpecs(3).slice(0, 12);
const docs: GoldDoc[] = assemble(
  specs,
  specs.map((s) => ({ id: s.id, content: `${s.surface_hints.flatMap((h) => h.tokens).join(' ')} `.padEnd(120, '가') })),
).docs.map((d, i) => ({ ...d, id: `hand-9${String(i).padStart(2, '0')}`, split: 'hand' as const }));

// 시험들이 한 트랜잭션을 이어 쓴다(앞에서 실은 문서를 뒤에서 확인한다). 순서를 섞어 돌려도 이 묶음은 적힌 순서대로 돈다.
describe.skipIf(!usable)('정답 세트 DB', { shuffle: false }, () => {
  const client = new Client({ connectionString: url });

  beforeAll(async () => {
    await migrate(url as string);
    await client.connect();
    await client.query('BEGIN');
    // 이 트랜잭션 안에서만 비운다. 끝나면 되돌린다.
    await client.query('DELETE FROM gold_docs');
  });

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  });

  it('싣는다. 두 번 실어도 늘지 않는다', async () => {
    expect(docs).toHaveLength(12);
    expect(await loadDocs(client, docs)).toEqual({ inserted: 12, updated: 0, skipped: 0 });
    expect(await loadDocs(client, docs)).toEqual({ inserted: 0, updated: 0, skipped: 12 });
    expect(await listDocs(client, 'hand')).toHaveLength(12);
  });

  it('DB 를 다녀온 정답은 파일의 것과 같다고 본다', async () => {
    expect(planExport(docs, await listDocs(client, 'hand')).changed).toEqual([]);
  });

  it('첫 확인 줄은 안 본 문서를 번호순으로 준다', async () => {
    const q = await firstPassQueue(client, 'hand', 5);
    expect(q.docs.map((d) => d.id)).toEqual(docs.slice(0, 5).map((d) => d.id));
    expect(q).toMatchObject({ total: 12, done: 0 });
  });

  it('맞음: 판정과 걸린 초가 남고 정답은 그대로다', async () => {
    const id = docs[0]?.id as string;
    const out = await recordReview(client, { docId: id, pass: 1, seconds: 41.6 });
    expect(out).toMatchObject({ verdict: 'ok', fixedFields: 0, before: null });
    expect(out.reviewId).toMatch(/^\d+$/);
    const { rows } = await client.query('SELECT pass, verdict, fixed_fields, seconds FROM gold_reviews WHERE gold_doc_id = $1', [id]);
    expect(rows).toEqual([{ pass: 1, verdict: 'ok', fixed_fields: 0, seconds: 42 }]);
    const q = await firstPassQueue(client, 'hand', 30);
    expect(q.done).toBe(1);
    expect(q.docs.map((d) => d.id)).not.toContain(id);
  });

  it('고침: 정답이 바뀌고 고친 칸 수가 남는다. 같은 값을 다시 넣은 칸은 세지 않는다', async () => {
    const doc = docs.find((d) => d.truth.type !== 'not_product' && d.id !== docs[0]?.id) as GoldDoc;
    const out = await recordReview(client, {
      docId: doc.id,
      pass: 1,
      fixes: { name: '  고친 이름  ', price_krw: doc.truth.fields.price_krw ?? null, vat_included: null },
      seconds: 90,
    });
    const changed = doc.truth.fields.vat_included === null ? 1 : 2;
    expect(out).toMatchObject({ verdict: 'fixed', fixedFields: changed });
    // 고치기 전 정답을 함께 돌려준다(되돌리기가 이것을 다시 보낸다).
    expect(canon(out.before)).toEqual(canon(doc.truth));
    const after = await getDoc(client, doc.id);
    expect(after?.truth.fields.name).toBe('고친 이름');
    expect(after?.truth.fields.vat_included).toBeNull();
    expect(planExport(docs, await listDocs(client, 'hand'))).toMatchObject({ changed: [doc.id], version: GOLD_VERSION + 1 });
  });

  it('꼴이 다른 값, 그 종류에 없는 칸, 없는 문서는 받지 않고 아무것도 남기지 않는다', async () => {
    const doc = docs.find((d) => d.truth.type === 'ad') as GoldDoc;
    const before = (await listReviews(client)).length;
    await expect(recordReview(client, { docId: doc.id, pass: 1, fixes: { price_krw: '백만원' } })).rejects.toBeInstanceOf(GoldError);
    await expect(recordReview(client, { docId: doc.id, pass: 1, fixes: { material: '아크릴' } })).rejects.toBeInstanceOf(GoldError);
    await expect(recordReview(client, { docId: doc.id, pass: 1, subtype: '커피차' })).rejects.toBeInstanceOf(GoldError);
    await expect(recordReview(client, { docId: 'hand-000', pass: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await listReviews(client)).length).toBe(before);
  });

  it('버림: 판정만 남는다', async () => {
    const id = docs[11]?.id as string;
    expect(await recordReview(client, { docId: id, pass: 1, drop: true, seconds: 5 })).toMatchObject({ verdict: 'dropped', fixedFields: 0, before: null });
  });

  it('진행 상황은 가장 최근 판정으로 센다', async () => {
    const id = docs[0]?.id as string;
    await recordReview(client, { docId: id, pass: 1, drop: true });
    await recordReview(client, { docId: id, pass: 1, seconds: 10 });
    const hand = (await summarize(client)).splits.find((s) => s.split === 'hand');
    expect(hand).toMatchObject({ total: 12, reviewed: 3, ok: 1, fixed: 1, dropped: 1 });
  });

  it('고친 문서를 다시 열어 그대로 확인해도 고친 일은 요약에 남는다', async () => {
    const hand = async () => (await summarize(client)).splits.find((s) => s.split === 'hand') as NonNullable<Awaited<ReturnType<typeof summarize>>['splits'][number]>;
    const before = await hand();
    expect(before.fixedFields).toBeGreaterThan(0);
    const fixed = (await listDocs(client, 'hand')).find((d) => d.truth.fields.name === '고친 이름') as GoldDoc;

    expect(await recordReview(client, { docId: fixed.id, pass: 1, seconds: 3 })).toMatchObject({ verdict: 'ok', fixedFields: 0 });
    expect(await hand()).toMatchObject({
      reviewed: before.reviewed, ok: before.ok, fixed: before.fixed, fixedFields: before.fixedFields, seconds: before.seconds + 3,
    });
  });

  it('다시 보기: 씨앗이 같으면 같은 문서가 나오고, 버린 문서는 안 나오고, 본 것은 줄에서 빠진다', async () => {
    for (const d of docs.slice(2, 11)) {
      const seen = await client.query('SELECT 1 FROM gold_reviews WHERE gold_doc_id = $1 AND pass = 1', [d.id]);
      if (seen.rowCount === 0) await recordReview(client, { docId: d.id, pass: 1, seconds: 1 });
    }
    const a = await recheckQueue(client, 5, 4);
    const b = await recheckQueue(client, 5, 4);
    expect(a.docs.map((d) => d.id)).toEqual(b.docs.map((d) => d.id));
    expect(a).toMatchObject({ total: 4, done: 0 });
    expect(a.docs.map((d) => d.id)).not.toContain(docs[11]?.id);
    const other = await recheckQueue(client, 6, 4);
    expect(other.docs.map((d) => d.id)).not.toEqual(a.docs.map((d) => d.id));

    await recordReview(client, { docId: a.docs[0]?.id as string, pass: 2, seconds: 20 });
    const after = await recheckQueue(client, 5, 4);
    expect(after).toMatchObject({ total: 4, done: 1 });
    expect(after.docs.map((d) => d.id)).toEqual(a.docs.slice(1).map((d) => d.id));
    expect((await summarize(client)).recheck).toMatchObject({ reviewed: 1, same: 1 });
  });

  it('옛 버전 파일을 다시 실어도 사람이 고친 정답이 남는다. 버전이 높으면 바뀐다', async () => {
    const fixed = (await listDocs(client, 'hand')).find((d) => d.truth.fields.name === '고친 이름') as GoldDoc;
    await loadDocs(client, docs);
    expect((await getDoc(client, fixed.id))?.truth.fields.name).toBe('고친 이름');
    const newer = docs.map((d) => ({ ...d, goldVersion: GOLD_VERSION + 1 }));
    expect((await loadDocs(client, newer)).updated).toBe(12);
    expect((await getDoc(client, fixed.id))?.truth.fields.name).not.toBe('고친 이름');
  });

  it('확인 기록은 기록이 없는 문서에만 실린다', async () => {
    const rows = await listReviews(client);
    expect(await loadReviews(client, rows)).toBe(0);
    await client.query('DELETE FROM gold_reviews');
    expect(await loadReviews(client, rows)).toBe(rows.length);
    expect(await loadReviews(client, rows)).toBe(0);
    expect((await listReviews(client)).map((r) => r.verdict)).toEqual(rows.map((r) => r.verdict));
  });

  it('고른 문서 안에서만 줄을 세우고 센다', async () => {
    const all = await firstPassQueue(client, 'hand', 30);
    expect(all.total).toBe(12);
    const only = docs.slice(0, 4).map((d) => d.id);
    const q = await firstPassQueue(client, 'hand', 30, only);
    expect(q.total).toBe(4);
    expect(q.docs.every((d) => only.includes(d.id))).toBe(true);
    expect(q.done + q.docs.length).toBe(4);
    expect(await firstPassQueue(client, 'hand', 30, [])).toEqual({ docs: [], total: 0, done: 0 });
  });

  it('되돌리기: 가장 최근 기록이 그 판정일 때만 지우고, 고친 정답은 고치기 전 값으로 돌린다', async () => {
    const doc = (await listDocs(client, 'hand')).find((d) => d.truth.type !== 'not_product') as GoldDoc;
    const count = async () => (await listReviews(client)).filter((r) => r.goldDocId === doc.id).length;
    const nameNow = async () => (await getDoc(client, doc.id))?.truth.fields.name;
    const start = await count();

    const first = await recordReview(client, { docId: doc.id, pass: 1, fixes: { name: '되돌릴 이름' }, seconds: 7 });
    expect(first).toMatchObject({ verdict: 'fixed', fixedFields: 1 });
    expect(first.before?.fields.name).toBe(doc.truth.fields.name);
    const second = await recordReview(client, { docId: doc.id, pass: 1, seconds: 2 });
    expect(second).toMatchObject({ verdict: 'ok', before: null });
    expect(second.reviewId).not.toBe(first.reviewId);

    // 가장 최근 기록이 아니면 되돌리지 않는다.
    await expect(undoReview(client, { docId: doc.id, reviewId: first.reviewId, before: first.before })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await count()).toBe(start + 2);
    expect(await undoReview(client, { docId: doc.id, reviewId: second.reviewId })).toEqual({ verdict: 'ok', restored: false });
    expect(await nameNow()).toBe('되돌릴 이름');

    // 정답을 고친 판정: 고치기 전 정답이 없거나 꼴이 다르면 되돌리지 않는다.
    await expect(undoReview(client, { docId: doc.id, reviewId: first.reviewId })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(undoReview(client, { docId: doc.id, reviewId: first.reviewId, before: { ...first.before, type: 'not_product' } })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(undoReview(client, { docId: doc.id, reviewId: first.reviewId, before: { ...first.before, fields: { name: '칸이 모자란 정답' } } })).rejects.toMatchObject({ code: 'INVALID' });
    expect(await count()).toBe(start + 1);
    expect(await nameNow()).toBe('되돌릴 이름');

    expect(await undoReview(client, { docId: doc.id, reviewId: first.reviewId, before: first.before })).toEqual({ verdict: 'fixed', restored: true });
    expect(await count()).toBe(start);
    expect(canon((await getDoc(client, doc.id))?.truth)).toEqual(canon(doc.truth));

    // 같은 것을 두 번 되돌릴 수 없다. 없는 문서도 받지 않는다.
    await expect(undoReview(client, { docId: doc.id, reviewId: first.reviewId, before: first.before })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(undoReview(client, { docId: 'hand-000', reviewId: first.reviewId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await count()).toBe(start);
  });

  it('되돌린 문서는 "아직"으로 돌아가 첫 확인 줄에 다시 나온다', async () => {
    await client.query('DELETE FROM gold_reviews');
    const id = docs[3]?.id as string;
    const made = await recordReview(client, { docId: id, pass: 1, seconds: 9 });
    expect((await firstPassQueue(client, 'hand', 30)).docs.map((d) => d.id)).not.toContain(id);
    await undoReview(client, { docId: id, reviewId: made.reviewId });
    const q = await firstPassQueue(client, 'hand', 30);
    expect(q.docs.map((d) => d.id)).toContain(id);
    expect(q.done).toBe(0);
  });

  it('걸린 초는 그 차례의 것만, 적힌 순서대로 준다', async () => {
    await client.query('DELETE FROM gold_reviews');
    await recordReview(client, { docId: docs[0]?.id as string, pass: 1, seconds: 75 });
    await recordReview(client, { docId: docs[1]?.id as string, pass: 1 });
    await recordReview(client, { docId: docs[2]?.id as string, pass: 1, seconds: 20.4 });
    await recordReview(client, { docId: docs[0]?.id as string, pass: 2, seconds: 8 });
    expect(await reviewSeconds(client, 1)).toEqual([75, 20]);
    expect(await reviewSeconds(client, 2)).toEqual([8]);
  });
});
