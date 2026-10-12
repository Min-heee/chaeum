// 경로 파일이 부르는 묶음 함수: 남의 공간 번호로는 보지도 고치지도 못한다. 응답은 약속의 꼴이다.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BulkIntakeResponseSchema,
  DraftListResponseSchema,
  IntakeResponseSchema,
  ProductDetailResponseSchema,
  ProductListResponseSchema,
  PUBLIC_WORKSPACE_ID,
  SampleListResponseSchema,
} from '@/contract/api';
import { GOLD_STYLES } from '@/contract/eval-types';
import { DOC_TYPES } from '@/contract/fields';
import { buildExtractRequest, MemoryCallStore } from '@/llm';
import { parseCsvRows, textsFromCsv } from '@/server/bulk-csv';
import { closePool, getPool, withTx } from '@/server/db';
import { seedGlossary } from '@/server/job-handlers';
import { cleanText } from '@/server/limits';
import { saveProductTexts } from '@/server/repos/products';
import { sampleCacheKey, seedSamples } from '@/server/samples';
import {
  approve, draftDetail, draftList, exportCsv, intakeBulk, intakeText, patchFields, productDetail, productList, reject, reprocess, sampleList,
} from '@/server/service';
import { ensurePublicWorkspace } from '@/server/workspace';
import { at, dropWorkspaces, newWorkspace, reviewableDraft, sampleText } from './helpers';
import { MODEL } from './pipeline-helpers';

const pool = () => getPool();

beforeEach(async () => {
  await pool().query('TRUNCATE jobs RESTART IDENTITY');
});

afterAll(async () => {
  await dropWorkspaces();
  await closePool();
});

describe('남의 공간', () => {
  it('남의 공간 번호로는 초안을 볼 수도, 고칠 수도, 결정할 수도 없다', async () => {
    const mine = await newWorkspace();
    const theirs = await newWorkspace();
    const { draftId, version } = await reviewableDraft(mine);

    await expect(draftDetail(theirs, draftId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(draftDetail(PUBLIC_WORKSPACE_ID, draftId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await draftList(theirs)).items).toEqual([]);
    const act = { workspaceId: theirs, draftId, version, now: at(1000) };
    await expect(patchFields({ ...act, edits: { price_krw: 1 } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(approve(act)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(reject({ ...act, reasonCode: 'OTHER' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(reprocess(act)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // 내 공간에서는 그대로다.
    expect(await draftDetail(mine, draftId)).toMatchObject({ id: draftId, status: 'READY', version, productId: null, reject: null });
  });

  it('남의 공간 번호로는 상품도 양식 파일도 보이지 않는다', async () => {
    const mine = await newWorkspace();
    const theirs = await newWorkspace();
    const { draftId, version } = await reviewableDraft(mine);
    const approved = await approve({ workspaceId: mine, draftId, version, now: at(1000) });
    expect(approved).toMatchObject({ status: 'APPROVED', productId: expect.any(Number) });
    const productId = approved.productId as number;

    await expect(productDetail(theirs, productId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await productList(theirs)).items).toEqual([]);
    expect((await exportCsv(theirs)).rows).toBe(0);
    expect((await exportCsv(mine)).rows).toBe(1);
    expect((await draftDetail(mine, draftId)).productId).toBe(productId);
  });

  it('본보기 공간에는 쓰지 못한다', async () => {
    await ensurePublicWorkspace(pool(), at(0));
    await expect(intakeText(sampleText(), { workspaceId: PUBLIC_WORKSPACE_ID, now: at(0) })).rejects.toMatchObject({ code: 'READ_ONLY_WORKSPACE' });
    await expect(approve({ workspaceId: PUBLIC_WORKSPACE_ID, draftId: 1, version: 1, now: at(0) })).rejects.toMatchObject({ code: 'READ_ONLY_WORKSPACE' });
  });
});

describe('응답의 꼴', () => {
  it('접수, 검수함, 상품 목록과 상세가 약속의 스키마를 지킨다', async () => {
    const ws = await newWorkspace();
    const one = await intakeText(sampleText(), { workspaceId: ws, now: at(0) });
    expect(one.created).toBe(true);
    expect(() => IntakeResponseSchema.parse(one.body)).not.toThrow();
    expect((await intakeText(cleanText(` ${(await draftDetail(ws, one.body.draftId)).source.text} `), { workspaceId: ws, now: at(0) })).created).toBe(false);

    const bulk = await intakeBulk([sampleText(), '   ', sampleText()], { workspaceId: ws, now: at(0) });
    expect(() => BulkIntakeResponseSchema.parse(bulk)).not.toThrow();
    expect(bulk.counts).toEqual({ new: 2, duplicate: 0, error: 1 });
    expect(bulk.items.map((i) => [i.index, i.result])).toEqual([[0, 'new'], [1, 'error'], [2, 'new']]);

    const { draftId, version } = await reviewableDraft(ws);
    const list = await draftList(ws, { status: 'READY' });
    expect(() => DraftListResponseSchema.parse(list)).not.toThrow();
    expect(list.items).toMatchObject([{ id: draftId, name: '응원 슬로건', sourceKind: 'text' }]);
    expect(list.counts).toMatchObject({ PROCESSING: 3, READY: 1 });

    const approved = await approve({ workspaceId: ws, draftId, version, now: at(1000) });
    const before = await productList(ws);
    expect(() => ProductListResponseSchema.parse(before)).not.toThrow();
    expect(before.items).toMatchObject([{ id: approved.productId, textState: 'pending', name: '응원 슬로건', price_krw: 5000 }]);

    await withTx((c) => saveProductTexts(c, approved.productId as number, [
      { field: 'title', lang: 'en', text: 'Cheer Slogan', source: 'llm', status: 'ok', failCodes: [] },
      { field: 'title', lang: 'zh-Hans', text: '手幅', source: 'template', status: 'needs_review', failCodes: ['HANGUL_IN_TEXT'] },
    ]));
    const detail = await productDetail(ws, approved.productId as number);
    expect(() => ProductDetailResponseSchema.parse(detail)).not.toThrow();
    expect(detail).toMatchObject({ textState: 'needs_review', draftId });
    expect(detail.texts).toHaveLength(2);
    expect((await productList(ws)).items[0]?.textState).toBe('needs_review');
  });

  it('반려된 초안의 상세에는 반려 사유가 있다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    await reject({ workspaceId: ws, draftId, version, reasonCode: 'DUPLICATE', memo: ' 같은 지면 ', now: at(1000) });
    expect((await draftDetail(ws, draftId)).reject).toEqual({ code: 'DUPLICATE', memo: '같은 지면' });
  });
});

describe('보기 글과 용어집', () => {
  it('보기 글은 12건이고 꼴이 서로 다르다. 첫 글은 "05시~25시"가 든 전광판 글이다', () => {
    const samples = seedSamples();
    expect(samples).toHaveLength(12);
    expect(new Set(samples.map((s) => s.id)).size).toBe(12);
    expect(new Set(samples.map((s) => s.style))).toEqual(new Set(GOLD_STYLES));
    expect(new Set(samples.map((s) => s.type))).toEqual(new Set(DOC_TYPES));
    expect(samples[0]).toMatchObject({ type: 'ad', style: 'notice' });
    expect(samples[0]?.text).toContain('05시~25시');
    // 글 정리를 거쳐도 서로 다른 글이다.
    expect(new Set(samples.map((s) => cleanText(s.text))).size).toBe(12);
  });

  it('보기 글 목록은 녹화본이 있는 글을 알려 준다', async () => {
    const [first] = seedSamples();
    const store = new MemoryCallStore();
    const req = buildExtractRequest(cleanText(first?.text ?? ''));
    await store.save({
      task: 'extract', provider: 'anthropic', model: MODEL, promptVersion: req.promptVersion, cacheKey: sampleCacheKey(first?.text ?? '', MODEL),
      response: { type: 'not_product', subtype: null, fields: [] }, stopReason: 'end_turn', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, isRecorded: true,
    });
    const list = await sampleList({ store, model: MODEL });
    expect(() => SampleListResponseSchema.parse(list)).not.toThrow();
    expect(list.items.map((i) => i.recorded)).toEqual([true, ...Array.from({ length: 11 }, () => false)]);
  });

  it('보기 글의 장부 키는 접수 때와 같은 글 정리를 거친다(공백·줄바꿈 꼴이 달라도 같은 키)', () => {
    const text = seedSamples()[0]?.text ?? '';
    const messy = `  ${text.replace(/\n/g, ' \r\n')}\n\n\n`;
    expect(messy).not.toBe(text);
    expect(sampleCacheKey(messy, MODEL)).toBe(sampleCacheKey(text, MODEL));
    expect(sampleCacheKey(`${text} 덧붙임`, MODEL)).not.toBe(sampleCacheKey(text, MODEL));
  });

  it('용어집은 10~15줄이고 한국어 낱말이 겹치지 않는다', () => {
    const glossary = seedGlossary();
    expect(glossary.length).toBeGreaterThanOrEqual(10);
    expect(glossary.length).toBeLessThanOrEqual(15);
    expect(new Set(glossary.map((g) => g.ko)).size).toBe(glossary.length);
    // 다른 언어 표기에 한글이 섞여 있지 않다.
    for (const g of glossary) expect(`${g.en}${g['zh-Hans']}`).not.toMatch(/[가-힣]/);
  });
});

describe('여러 건 넣기의 CSV', () => {
  it('첫 열이 글이다. 머리줄은 건너뛰고, 따옴표 안의 줄바꿈과 쉼표는 글의 일부다', () => {
    const csv = '﻿text,memo\r\n"합정역 전광판, 1주 150\n소재는 mp4",급함\r\n\r\n커피차 100잔 80만원\r\n"그는 ""특가""라고 했다",x\n';
    expect(textsFromCsv(csv)).toEqual(['합정역 전광판, 1주 150\n소재는 mp4', '커피차 100잔 80만원', '그는 "특가"라고 했다']);
    expect(parseCsvRows('a,b\nc')).toEqual([['a', 'b'], ['c']]);
  });

  it('글이 없어도 50건을 넘어도 400 이다', () => {
    expect(() => textsFromCsv('text\n\n')).toThrow(expect.objectContaining({ code: 'BAD_INPUT' }));
    expect(() => textsFromCsv(Array.from({ length: 51 }, (_, i) => `글 ${i}`).join('\n'))).toThrow(expect.objectContaining({ code: 'BAD_INPUT' }));
  });
});
