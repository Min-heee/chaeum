// 승인 → 상품 등록. 꼴 검사나 표의 제약에 걸리면 통째로 되돌아간다.
import { afterAll, describe, expect, it } from 'vitest';
import type { ProductText } from '@/contract/content';
import type { LlmCallRecord } from '@/contract/llm-types';
import { closePool, getPool, withTx } from '@/server/db';
import { getJob } from '@/server/queue';
import { listEvents } from '@/server/repos/draft-events';
import { getDraft, transitionDraft } from '@/server/repos/drafts';
import { PgLlmCallStore } from '@/server/repos/llm-calls';
import { buildProduct, getProduct, insertProduct, listProducts, listProductTexts, ProductInvalid, saveProductTexts } from '@/server/repos/products';
import { approveDraft, PRODUCT_INVALID_REASON } from '@/server/review';
import { count, dropWorkspaces, field, GOODS_FIELDS, newWorkspace, reviewableDraft, T0 } from './helpers';

const withField = (key: string, value: unknown) => GOODS_FIELDS.map((f) => (f.field === key ? { ...f, finalValue: value as never } : f));

const AD_FIELDS = [
  field('name', '합정역 2번출구 전광판'),
  field('price_krw', 1_500_000),
  field('vat_included', false),
  field('region', '합정역'),
  field('size_m', { width: 7, height: 12 }),
  field('hours', { open: '05:00', close: '01:00', nextDay: true }),
  field('footfall_per_day', 100_000),
  field('period_options', [{ days: 7, price_krw: 1_500_000 }, { days: 14, price_krw: 2_800_000 }]),
  field('file_format', ['jpg', 'mp4']),
];

afterAll(async () => {
  await dropWorkspaces();
  await closePool();
});

describe('승인하면 상품이 된다', () => {
  it('굿즈: 공통 칸은 열로, 나머지는 규격으로 들어가고 글 작업이 한 건 생긴다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    const done = await approveDraft({ workspaceId: ws, draftId, version, now: T0 });

    expect(done).toMatchObject({ id: draftId, status: 'APPROVED', version: version + 1 });
    expect(await getProduct(getPool(), ws, done.productId)).toMatchObject({
      draftId, type: 'goods', subtype: '인쇄물', name: '응원 슬로건', price_krw: 5000, list_price_krw: 6000, vat_included: true,
      spec: { size_mm: { width: 200, height: 600 }, material: '반사 원단', min_order_qty: 10 },
      options: [],
    });
    expect(await getJob(getPool(), 'content', done.productId)).toMatchObject({ status: 'queued', runAt: T0 });
    expect(await listProducts(getPool(), ws)).toHaveLength(1);
    expect(await getProduct(getPool(), await newWorkspace(), done.productId)).toBeNull();
  });

  it('광고 지면: 기간 옵션은 옵션으로, 목록 값도 꼴 그대로 들어간다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws, 'NEEDS_REVIEW', AD_FIELDS, 'ad', '전광판');
    const { productId } = await approveDraft({ workspaceId: ws, draftId, version, now: T0 });
    const product = await getProduct(getPool(), ws, productId);
    expect(product?.options).toEqual([{ days: 7, price_krw: 1_500_000 }, { days: 14, price_krw: 2_800_000 }]);
    expect(product?.spec).toMatchObject({ region: '합정역', file_format: ['jpg', 'mp4'], hours: { nextDay: true } });
    expect(product?.spec).not.toHaveProperty('period_options');
    expect(product?.list_price_krw).toBeNull();
  });

  it('글은 (상품, 칸, 언어)마다 한 줄이다. 두 번 써도 늘지 않는다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    const { productId } = await approveDraft({ workspaceId: ws, draftId, version, now: T0 });
    const text: ProductText = { field: 'title', lang: 'en', text: 'Cheering Slogan', source: 'llm', status: 'ok', failCodes: [] };
    await saveProductTexts(getPool(), productId, [text]);
    await saveProductTexts(getPool(), productId, [{ ...text, text: 'Slogan', source: 'template', status: 'needs_review', failCodes: ['GLOSSARY_MISS'] }]);
    expect(await listProductTexts(getPool(), productId)).toEqual([
      { field: 'title', lang: 'en', text: 'Slogan', source: 'template', status: 'needs_review', failCodes: ['GLOSSARY_MISS'] },
    ]);
  });
});

describe('넣을 수 없는 상품은 통째로 되돌아간다', () => {
  const nothingLeft = async (draftId: number) => {
    expect(await count('products WHERE draft_id = $1', [draftId])).toBe(0);
    expect(await count(`jobs WHERE kind = 'content'  AND ref_id IN (SELECT id FROM products WHERE draft_id = $1)`, [draftId])).toBe(0);
    expect(await count(`draft_events WHERE draft_id = $1 AND to_status = 'APPROVED'`, [draftId])).toBe(0);
  };

  it('정가가 판매가보다 작으면 승인이 되돌아가고, 바로 승인 가능하던 초안은 확인 필요로 내려간다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws, 'READY', withField('list_price_krw', 3000));

    await expect(approveDraft({ workspaceId: ws, draftId, version, now: T0 })).rejects.toMatchObject({
      code: 'PRODUCT_INVALID', current: { status: 'NEEDS_REVIEW', version: version + 1 },
    });
    await nothingLeft(draftId);
    expect(await getDraft(getPool(), ws, draftId)).toMatchObject({ status: 'NEEDS_REVIEW', version: version + 1 });
    expect((await listEvents(getPool(), draftId)).at(-1)).toMatchObject({ actor: 'system', from: 'READY', to: 'NEEDS_REVIEW', reasonCode: PRODUCT_INVALID_REASON });
  });

  it.each([
    ['이름이 한 글자', withField('name', '슬')],
    ['판매가가 0', withField('price_krw', 0)],
    ['판매가가 없음', withField('price_krw', null)],
    ['규격의 꼴이 틀림', withField('size_mm', '200x600')],
  ])('%s: 확인 필요이던 초안은 그대로 남는다', async (_label, fields) => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws, 'NEEDS_REVIEW', fields);
    await expect(approveDraft({ workspaceId: ws, draftId, version, now: T0 })).rejects.toMatchObject({ code: 'PRODUCT_INVALID' });
    await nothingLeft(draftId);
    expect(await getDraft(getPool(), ws, draftId)).toMatchObject({ status: 'NEEDS_REVIEW', version });
  });

  it('종류가 없거나 등록 대상이 아닌 초안, 갈래가 안 맞는 초안은 상품이 못 된다', () => {
    expect(() => buildProduct(null, null, GOODS_FIELDS)).toThrow(ProductInvalid);
    expect(() => buildProduct('not_product', null, [])).toThrow(ProductInvalid);
    expect(() => buildProduct('goods', '전광판', GOODS_FIELDS)).toThrow(ProductInvalid);
    expect(() => buildProduct('catering', '커피차', [field('name', '응원 커피차'), field('price_krw', 800_000), field('quantity_options', [{ qty: 100 }] as never)])).toThrow(/옵션/);
  });

  it('코드 검사를 지나쳐도 표의 제약이 막고, 같은 트랜잭션의 상태 변경과 기록까지 되돌아간다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    const good = buildProduct('goods', '인쇄물', GOODS_FIELDS);
    const eventsBefore = (await listEvents(getPool(), draftId)).length;

    for (const bad of [{ price_krw: 0 }, { list_price_krw: 1 }, { name: '슬' }, { subtype: '' }]) {
      await expect(
        withTx(async (c) => {
          await transitionDraft(c, { workspaceId: ws, draftId, to: 'APPROVED', expectedVersion: version, actor: 'seller', now: T0 });
          await insertProduct(c, ws, draftId, { ...good, ...bad }, T0);
        }),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await nothingLeft(draftId);
    expect(await getDraft(getPool(), ws, draftId)).toMatchObject({ status: 'READY', version });
    expect(await listEvents(getPool(), draftId)).toHaveLength(eventsBefore);
  });

  it('승인 길에서 표의 제약(초안 하나에 상품 하나)에 걸려도 승인이 되돌아가고 400 이다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws, 'NEEDS_REVIEW');
    await insertProduct(getPool(), ws, draftId, buildProduct('goods', '인쇄물', GOODS_FIELDS), T0);

    await expect(approveDraft({ workspaceId: ws, draftId, version, now: T0 })).rejects.toMatchObject({ code: 'PRODUCT_INVALID' });
    expect(await count('products WHERE draft_id = $1', [draftId])).toBe(1);
    expect(await getDraft(getPool(), ws, draftId)).toMatchObject({ status: 'NEEDS_REVIEW', version });
    expect(await count(`draft_events WHERE draft_id = $1 AND to_status = 'APPROVED'`, [draftId])).toBe(0);
  });
});

describe('호출 장부', () => {
  const record = (cacheKey: string, response: unknown): LlmCallRecord => ({
    task: 'extract', provider: 'anthropic', model: 'some-model', promptVersion: 'extract-v1', cacheKey, response,
    stopReason: 'end_turn', inputTokens: 120, outputTokens: 45, costUsd: 0.000123, latencyMs: 800, isRecorded: true,
  });

  it('같은 키의 가장 최근 줄을 돌려준다. 없는 키는 null', async () => {
    const store = new PgLlmCallStore();
    const key = `시험-${process.pid}-${process.hrtime.bigint()}`;
    expect(await store.find(key)).toBeNull();

    await store.save(record(key, { type: 'goods', fields: [] }));
    await store.save(record(key, ['둘째 답', 2]));
    expect(await store.find(key)).toEqual(record(key, ['둘째 답', 2]));
    // 시험용 구현이 적은 줄은 더 최근이어도 건너뛴다.
    await store.save({ ...record(key, ['가짜 답']), provider: 'fake' });
    expect(await store.find(key)).toEqual(record(key, ['둘째 답', 2]));
    expect(await count('llm_calls WHERE cache_key = $1', [key])).toBe(3);
    await getPool().query('DELETE FROM llm_calls WHERE cache_key = $1', [key]);
  });
});
