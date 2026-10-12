// 정답 세트의 DB 일. npm run test:db 에서 돈다(시험용 PostgreSQL, 이름이 _test 로 끝나는 DB).
// 트랜잭션 하나 안에서 돌고 끝나면 되돌린다. 다른 시험의 자료를 건드리지 않는다.
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GoldDoc } from '@/contract/eval-types';
import { migrate } from '../../scripts/migrate';
import { assemble } from './assemble';
import { generateSpecs } from './generate';
import { firstPassQueue, getDoc, GoldError, listDocs, listReviews, loadDocs, loadReviews, planExport, recheckQueue, recordReview, summarize } from './store';

config({ path: '.env.local', quiet: true });
const url = process.env.TEST_DATABASE_URL;
const usable = url !== undefined && new URL(url).pathname.endsWith('_test');

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
    expect(await recordReview(client, { docId: id, pass: 1, seconds: 41.6 })).toEqual({ verdict: 'ok', fixedFields: 0 });
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
    expect(out).toEqual({ verdict: 'fixed', fixedFields: changed });
    const after = await getDoc(client, doc.id);
    expect(after?.truth.fields.name).toBe('고친 이름');
    expect(after?.truth.fields.vat_included).toBeNull();
    expect(planExport(docs, await listDocs(client, 'hand'))).toMatchObject({ changed: [doc.id], version: 2 });
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
    expect(await recordReview(client, { docId: id, pass: 1, drop: true, seconds: 5 })).toEqual({ verdict: 'dropped', fixedFields: 0 });
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

    expect(await recordReview(client, { docId: fixed.id, pass: 1, seconds: 3 })).toEqual({ verdict: 'ok', fixedFields: 0 });
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
    const newer = docs.map((d) => ({ ...d, goldVersion: 2 }));
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
});
