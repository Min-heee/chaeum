// 견적: 만들기·읽기·확정과 경로. 모델을 못 부를 때 어디까지 내려가는지, 하루 상한, 답장의 글 검사와 틀 문장, 공간 칸막이를 본다.
// 이 시험은 tests/ 아래가 아니라 여기 있다. DB 시험이 도는 자리(vitest 의 db 쪽 include)가 src/**/*.db.test.ts 이기 때문이다.
// 모델은 한 번도 실제로 부르지 않는다. 시험용 구현, 네트워크 없는 실제 호출 흉내, 받아 둔 녹화본(data/recordings/quote.jsonl)만 쓴다.
process.env.LLM_PROVIDER = 'fake';
delete process.env.ANTHROPIC_API_KEY;

import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { ApiErrorBodySchema, PUBLIC_WORKSPACE_ID } from '@/contract/api';
import { LlmUnavailable, type LlmProvider, type LlmRequest, type LlmResult } from '@/contract/llm-types';
import type { LlmRouter } from '@/contract/pipeline-api';
import { QUOTE_LIMITS, QuoteResponseSchema, type QuoteExtraction, type QuoteProduct, type QuoteResponse } from '@/contract/tools/quote';
import { MemoryCallStore } from '@/llm';
import { parseRecordingLines } from '@/llm/stores';
import { quoteSamples, SAMPLE_TODAY } from '@/tools/quote';
import { POST as confirmRoute } from '../../app/api/quotes/[id]/confirm/route';
import { GET as getRoute } from '../../app/api/quotes/[id]/route';
import { POST as createRoute } from '../../app/api/quotes/route';
import { call } from '../../tests/api/helpers';
import { count, dropWorkspaces, newWorkspace, rawDraft, T0, track } from '../../tests/integration/helpers';
import { fakeRouter, MODEL, router } from '../../tests/integration/pipeline-helpers';
import { FIXTURE_PRODUCTS } from '../../tests/tools/quote-fixtures';
import { closePool, getPool } from './db';
import { AppError } from './errors';
import { confirmQuote, createQuote, getQuote } from './quotes';
import { readCounter } from './repos/daily-counters';
import { insertProduct } from './repos/products';
import { ensurePublicWorkspace } from './workspace';

afterAll(async () => {
  await dropWorkspaces();
  await closePool();
});

const TODAY = SAMPLE_TODAY;
/** 하루 상한 시험의 날. 다른 시험과 겹치지 않는 옛 날짜다. */
const CAP_DAY = new Date('2003-03-03T03:00:00Z');

/** 지어낸 상품 묶음을 공간에 넣는다. 이름 → 번호. */
async function seedProducts(ws: string, products: readonly QuoteProduct[] = FIXTURE_PRODUCTS): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const p of products) {
    const draftId = await rawDraft(ws, 'APPROVED');
    const id = await insertProduct(getPool(), ws, draftId, { type: p.type, subtype: p.subtype, name: p.name, price_krw: p.price_krw, list_price_krw: null, vat_included: p.vat_included, spec: p.spec, options: p.options }, T0);
    ids.set(p.name, id);
  }
  return ids;
}

const NONE: QuoteExtraction = { lang: 'ko', budget_raw: null, budget_krw: null, region: null, date_raw: null, date: null, type: null, subtype: null, qty: null, days: null };
/** "5월 첫 주, 홍대 근처, 300만 원, 광고" */
const HONGDAE: QuoteExtraction = {
  ...NONE, budget_raw: '300만 원', budget_krw: 3000000, region: '홍대', date_raw: '5월 첫 주',
  date: { year: null, month: 5, day_from: null, day_to: null, week_of_month: 1 }, type: 'ad',
};

/** 시험용 길: 조건 뽑기는 정해 둔 답, 답장은 차례대로 정해 둔 글(다 쓰면 마지막 글). */
function scripted(extraction: QuoteExtraction, replies: string[] = ['문의 감사합니다. 총액은 {total}입니다.']): LlmRouter & { replyCalls: number } {
  let turn = 0;
  const base = fakeRouter((req: LlmRequest<unknown>) => {
    if (req.task === 'quote_extract') return extraction;
    turn += 1;
    return { reply: replies[Math.min(turn, replies.length) - 1] };
  });
  return { model: base.model, pick: (input) => base.pick(input), get replyCalls() { return turn; } };
}

/** 네트워크 없이 실제 호출 길을 타는 공급자. */
function liveStub(extraction: QuoteExtraction, fail?: (req: LlmRequest<unknown>) => Error | null): LlmProvider & { calls: number } {
  const stub = {
    name: 'anthropic' as const,
    model: MODEL,
    calls: 0,
    async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      stub.calls += 1;
      const err = fail?.(req as LlmRequest<unknown>);
      if (err) throw err;
      const output = req.schema.parse(req.task === 'quote_extract' ? extraction : { reply: '문의 감사합니다. 총액은 {total}입니다.' });
      return { output, stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 200 }, latencyMs: 500, recorded: false };
    },
  };
  return stub;
}

const TEXT = '5월 첫 주에 생일 광고를 하고 싶어요. 예산은 300만 원이고 홍대 근처면 좋겠습니다.';
const errorOf = async (run: Promise<unknown>): Promise<AppError> => {
  try {
    await run;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('오류가 나야 하는데 나지 않았다');
};

describe('견적 만들기', () => {
  it('조건 → 맞는 상품과 총액·마감 → 답장까지 한 건으로 저장된다', async () => {
    const ws = await newWorkspace();
    const ids = await seedProducts(ws);
    const got = await createQuote(ws, { text: `  ${TEXT}  `, today: TODAY }, T0, scripted(HONGDAE));
    expect(QuoteResponseSchema.safeParse(got).success).toBe(true);
    expect(got).toMatchObject({ workspace: ws, status: 'draft', text: TEXT, today: TODAY, productCount: FIXTURE_PRODUCTS.length, candidateCount: 1, confirmedReply: null });
    expect(got.conditions).toMatchObject({ budgetKrw: 3000000, budgetBy: 'code', region: '홍대', dateFrom: '2027-05-01', dateTo: '2027-05-07', type: 'ad' });
    const [first] = got.candidates;
    expect(first).toMatchObject({ productId: ids.get('홍대입구역 9번 출구 전광판'), matched: ['type', 'region', 'budget', 'deadline'] });
    expect(first?.pricing).toMatchObject({ basis: 'period_option', days: 7, totalKrw: 1400000, exact: true, vatIncluded: false });
    expect(first?.schedule.deadlines.map((d) => [d.kind, d.date])).toEqual([['booking', '2027-04-17'], ['material', '2027-04-24']]);
    expect(got.selectedProductId).toBe(first?.productId);
    // 빠진 상품에는 까닭이 남는다. 합정역 지면은 종류는 맞지만 지역이 다르다.
    expect(got.excluded).toHaveLength(FIXTURE_PRODUCTS.length - 1);
    expect(got.excluded.find((e) => e.productId === ids.get('합정역 사거리 전광판'))?.reasons).toEqual(['region_mismatch']);
    // 답장: 모델은 자리표시만 썼고 숫자와 "부가세 별도"는 코드가 넣었다.
    expect(got.reply).toEqual({ template: '문의 감사합니다. 총액은 {total}입니다.', text: '문의 감사합니다. 총액은 1,400,000원 (부가세 별도)입니다.', source: 'llm', status: 'ok', failCodes: [] });
    expect(got.llm).toMatchObject({ extract: { recorded: false, live: false, promptVersion: 'quote-extract-v1' }, reply: { promptVersion: 'quote-reply-v1' }, replySkipCause: null });
    // 다시 읽어도 같다.
    expect(await getQuote(ws, got.id)).toEqual(got);
  });

  it('공간 없이 부르면 새 공간이 생긴다. 그 공간에는 상품이 없어 맞는 상품도 0개이고, 답장은 찾지 못했다는 글이다', async () => {
    const got = await createQuote(null, { text: TEXT, today: TODAY }, T0, scripted(HONGDAE, ['문의 감사합니다. 조건에 맞는 상품을 찾지 못했습니다.']));
    track(got.workspace);
    expect(got).toMatchObject({ productCount: 0, candidateCount: 0, candidates: [], excluded: [], selectedProductId: null });
    expect(got.reply).toMatchObject({ source: 'llm', status: 'ok', text: '문의 감사합니다. 조건에 맞는 상품을 찾지 못했습니다.' });
  });

  it('종류·갈래·지역이 하나도 없는 문의에는 상품을 고르지 않는다. 답장은 되묻는 틀 문장이고 답장 모델을 부르지 않는다', async () => {
    const ws = await newWorkspace();
    await seedProducts(ws);
    const llm = scripted({ ...NONE, budget_raw: '300만 원', budget_krw: 3000000 });
    const got = await createQuote(ws, { text: '예산은 300만 원입니다. 뭐가 좋을까요?', today: TODAY }, T0, llm);
    // 맞는 상품 목록은 그대로 보여 준다(사람이 고를 수 있다). 가장 싼 것을 대신 고르지는 않는다.
    expect(got.candidateCount).toBeGreaterThan(1);
    expect(got.selectedProductId).toBeNull();
    expect(got.reply).toMatchObject({ source: 'template', status: 'ok', failCodes: [] });
    expect(got.reply.text).toContain('어떤 상품을 찾으시는지');
    expect(got.reply.text).not.toMatch(/\d/);
    expect(got.llm).toMatchObject({ reply: null, replySkipCause: null });
    expect(llm.replyCalls).toBe(0);
    expect(QuoteResponseSchema.safeParse(got).success).toBe(true);
    // 사람이 골라 주면 그 상품으로 쓴다.
    const picked = await createQuote(ws, { text: '예산은 300만 원입니다. 뭐가 좋을까요?', today: TODAY, productId: got.candidates[0]!.productId }, T0, llm);
    expect(picked.selectedProductId).toBe(got.candidates[0]!.productId);
    expect(picked.reply.source).toBe('llm');
  });
  it('지역만 있는 문의: 지역이 맞은 지면이 지역을 보지 않는 굿즈보다 먼저 골라진다', async () => {
    const ws = await newWorkspace();
    const ids = await seedProducts(ws);
    const got = await createQuote(ws, { text: '홍대 근처로 알아보고 있어요.', today: TODAY }, T0, scripted({ ...NONE, region: '홍대 근처' }));
    expect(got.selectedProductId).toBe(ids.get('홍대입구역 9번 출구 전광판'));
    expect(got.candidates[0]?.matched).toEqual(['region']);
  });
  it('1900년 날짜가 적힌 문의도 오류 없이 접수된다. 상품은 모두 "마감이 지남"으로 빠진다', async () => {
    const ws = await newWorkspace();
    await seedProducts(ws);
    const date = { year: 1900, month: 1, day_from: 1, day_to: null, week_of_month: null };
    const got = await createQuote(ws, { text: '1900년 1월 1일 광고', today: TODAY }, T0, scripted({ ...NONE, type: 'ad', date_raw: '1900년 1월 1일', date }, ['문의 감사합니다. 조건에 맞는 상품을 찾지 못했습니다.']));
    expect(got.conditions).toMatchObject({ dateFrom: '1900-01-01', dateProblem: false });
    expect(got.candidateCount).toBe(0);
    for (const e of got.excluded) expect(e.reasons).toContain('deadline_passed');
  });

  it("catalog 가 'public' 이면 본보기 공간의 상품을 살핀다. 견적은 요청한 공간에 저장되고 본보기 공간에는 아무것도 쓰지 않는다", async () => {
    await ensurePublicWorkspace(getPool(), T0);
    const hongdae = FIXTURE_PRODUCTS.find((p) => p.name === '홍대입구역 9번 출구 전광판') as QuoteProduct;
    const draftId = await rawDraft(PUBLIC_WORKSPACE_ID, 'APPROVED');
    try {
      const productId = await insertProduct(getPool(), PUBLIC_WORKSPACE_ID, draftId, { type: hongdae.type, subtype: hongdae.subtype, name: hongdae.name, price_krw: hongdae.price_krw, list_price_krw: null, vat_included: hongdae.vat_included, spec: hongdae.spec, options: hongdae.options }, T0);
      const ws = await newWorkspace();
      // 비우면 요청한 공간의 상품이다. 그 공간은 비어 있다.
      const own = await createQuote(ws, { text: TEXT, today: TODAY }, T0, scripted(HONGDAE, ['문의 감사합니다. 조건에 맞는 상품을 찾지 못했습니다.']));
      expect(own).toMatchObject({ catalog: 'own', productCount: 0, candidateCount: 0 });

      const got = await createQuote(ws, { text: TEXT, today: TODAY, catalog: 'public' }, T0, scripted(HONGDAE));
      expect(QuoteResponseSchema.safeParse(got).success).toBe(true);
      expect(got).toMatchObject({ workspace: ws, catalog: 'public', selectedProductId: productId });
      expect(got.candidates.map((c) => c.productId)).toContain(productId);
      expect(got.reply.text).toBe('문의 감사합니다. 총액은 1,400,000원 (부가세 별도)입니다.');
      expect(await getQuote(ws, got.id)).toEqual(got);
      expect(await count('quotes WHERE workspace_id = $1', [PUBLIC_WORKSPACE_ID])).toBe(0);

      // 공간 없이 불러도 된다. 새 방문자 공간이 생기고 거기에 저장된다.
      const fresh = await createQuote(null, { text: TEXT, today: TODAY, catalog: 'public' }, T0, scripted(HONGDAE));
      track(fresh.workspace);
      expect(fresh.workspace).not.toBe(PUBLIC_WORKSPACE_ID);
      expect(fresh).toMatchObject({ catalog: 'public', selectedProductId: productId });
    } finally {
      // 본보기 공간은 다른 시험과 함께 쓴다. 넣은 상품을 지운다(원문을 지우면 초안과 상품이 함께 지워진다).
      await getPool().query('DELETE FROM source_docs WHERE id = (SELECT source_doc_id FROM drafts WHERE id = $1)', [draftId]);
    }
  });

  it('고를 상품을 정해 줄 수 있다. 맞는 상품에 없는 번호면 400이고 아무것도 저장하지 않는다', async () => {
    const ws = await newWorkspace();
    const ids = await seedProducts(ws);
    const metro = ids.get('강남역 스크린도어 광고') as number;
    const got = await createQuote(ws, { text: '광고 문의', productId: metro, today: TODAY }, T0, scripted({ ...NONE, type: 'ad' }));
    expect(got.selectedProductId).toBe(metro);
    expect(got.candidateCount).toBe(4);
    expect(got.reply.text).toContain('3,300,000원 (부가세 별도)');
    // 조건에서 빠진 상품(굿즈)은 고를 수 없다.
    const err = await errorOf(createQuote(ws, { text: '광고 문의', productId: ids.get('포토카드 인쇄'), today: TODAY }, T0, scripted({ ...NONE, type: 'ad' })));
    expect(err.code).toBe('BAD_INPUT');
    expect(await count('quotes WHERE workspace_id = $1', [ws])).toBe(1);
  });

  it('맞는 상품이 상한보다 많으면 총액이 작은 것부터 상한까지만 싣는다. 고른 상품이 그 밖이면 마지막 자리에 넣는다', async () => {
    const ws = await newWorkspace();
    const ids = await seedProducts(ws);
    const got = await createQuote(ws, { text: '아무거나 추천해 주세요', today: TODAY }, T0, scripted(NONE));
    expect(got.candidateCount).toBe(FIXTURE_PRODUCTS.length);
    expect(got.candidates).toHaveLength(QUOTE_LIMITS.maxCandidates);
    const totals = got.candidates.map((c) => c.pricing.totalKrw);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
    // 가장 비싼 것(강남역, 3,300,000원)을 고르면 다섯 자리의 마지막에 들어온다.
    const metro = ids.get('강남역 스크린도어 광고') as number;
    const picked = await createQuote(ws, { text: '아무거나 추천해 주세요', productId: metro, today: TODAY }, T0, scripted(NONE));
    expect(picked.candidates).toHaveLength(QUOTE_LIMITS.maxCandidates);
    expect(picked.candidates.at(-1)?.productId).toBe(metro);
  });

  it('마감이 지난 날짜면 그 상품은 빠지고 까닭이 남는다', async () => {
    const ws = await newWorkspace();
    await seedProducts(ws);
    // 오늘이 2027-04-25 면 소재 마감(4월 24일)이 하루 지났다.
    const late = await createQuote(ws, { text: TEXT, today: '2027-04-25' }, T0, scripted(HONGDAE, ['조건에 맞는 상품을 찾지 못했습니다.']));
    expect(late.candidateCount).toBe(0);
    expect(late.excluded.find((e) => e.name === '홍대입구역 9번 출구 전광판')?.reasons).toEqual(['deadline_passed']);
    // 마감 당일(예약 마감 4월 17일)은 아직 된다.
    const onTheDay = await createQuote(ws, { text: TEXT, today: '2027-04-17' }, T0, scripted(HONGDAE));
    expect(onTheDay.candidates[0]?.schedule.deadlines[0]).toMatchObject({ kind: 'booking', daysLeft: 0, status: 'closing' });
  });

  it('글이 비었거나 길면 400, 본보기 공간이면 403. 모델을 부르기 전에 막는다', async () => {
    await ensurePublicWorkspace(getPool(), T0);
    const r = scripted(NONE);
    expect((await errorOf(createQuote(null, { text: '  \n ' }, T0, r))).code).toBe('BAD_INPUT');
    expect((await errorOf(createQuote(null, { text: '가'.repeat(QUOTE_LIMITS.textMaxChars + 1) }, T0, r))).code).toBe('BAD_INPUT');
    expect((await errorOf(createQuote(PUBLIC_WORKSPACE_ID, { text: TEXT }, T0, r))).code).toBe('READ_ONLY_WORKSPACE');
    expect(r.replyCalls).toBe(0);
  });

  it('공간의 견적 수가 상한에 닿으면 429이고 모델을 부르지 않는다', async () => {
    const ws = await newWorkspace();
    await getPool().query(
      `INSERT INTO quotes (workspace_id, inquiry_text, lang, today, extraction, conditions, reply_template, reply_text, reply_source, reply_status, created_at)
       SELECT $1, '글', 'ko', '2026-10-12', '{}', '{}', '글', '글', 'template', 'ok', $2 FROM generate_series(1, $3)`,
      [ws, T0, QUOTE_LIMITS.quotesPerWorkspace],
    );
    const r = scripted(NONE);
    const err = await errorOf(createQuote(ws, { text: TEXT }, T0, r));
    expect(err.code).toBe('LIMIT_EXCEEDED');
    expect(err.skipCause).toBeUndefined();
    expect(r.replyCalls).toBe(0);
  });
});

describe('모델을 못 부를 때', () => {
  it('키도 녹화도 없으면 조건을 뽑지 못해 접수하지 않는다(503, 까닭 no_key). 공간도 견적도 남지 않는다', async () => {
    const before = [await count('workspaces'), await count('quotes')];
    const err = await errorOf(createQuote(null, { text: TEXT }, T0, router({})));
    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect(err.skipCause).toBe('no_key');
    expect(ApiErrorBodySchema.safeParse(err.toBody()).success).toBe(true);
    expect([await count('workspaces'), await count('quotes')]).toEqual(before);
  });

  it('실제 호출이 꺼져 있으면 503(off), 조건 뽑기가 거절되거나 실패해도 503이다', async () => {
    const live = liveStub(HONGDAE);
    expect((await errorOf(createQuote(null, { text: TEXT }, CAP_DAY, router({ providerKind: 'anthropic', liveProvider: live, dailyCap: 0 })))).skipCause).toBe('off');
    expect(live.calls).toBe(0);
    await getPool().query(`DELETE FROM daily_counters WHERE day = '2003-03-03'`);
    const refused = liveStub(HONGDAE, () => new LlmUnavailable('REFUSAL'));
    expect((await errorOf(createQuote(null, { text: TEXT }, CAP_DAY, router({ providerKind: 'anthropic', liveProvider: refused, dailyCap: 9 })))).skipCause).toBe('refusal');
    const flaky = liveStub(HONGDAE, () => new LlmUnavailable('TRANSIENT'));
    const err = await errorOf(createQuote(null, { text: TEXT }, CAP_DAY, router({ providerKind: 'anthropic', liveProvider: flaky, dailyCap: 9 })));
    expect(err).toMatchObject({ code: 'LLM_UNAVAILABLE', skipCause: 'error' });
    // 요청 안이라 다시 해 보지 않는다. 한 번만 불렀다.
    expect(flaky.calls).toBe(1);
  });

  it('하루 상한: 호출 하나가 한 건이다. 조건 뽑기가 마지막 자리를 쓰면 답장은 틀 문장으로 내려가고, 다음 문의는 429다', async () => {
    await getPool().query(`DELETE FROM daily_counters WHERE day = '2003-03-03'`);
    const ws = await newWorkspace();
    await seedProducts(ws);
    const live = liveStub(HONGDAE);
    const r = router({ providerKind: 'anthropic', liveProvider: live, dailyCap: 1 });
    const got = await createQuote(ws, { text: TEXT, today: TODAY }, CAP_DAY, r);
    expect(live.calls).toBe(1);
    expect(got.llm).toMatchObject({ extract: { live: true, recorded: false, latencyMs: 500 }, reply: null, replySkipCause: 'daily_cap' });
    expect(got.llm.extract.costUsd).toBeGreaterThan(0);
    expect(got.reply).toMatchObject({ source: 'template', status: 'ok', failCodes: [] });
    expect(got.reply.text).toContain('총액: 1,400,000원 (부가세 별도), 기간 7일');
    expect(got.reply.text).toContain('예약 마감: 2027년 4월 17일');
    expect(await readCounter(getPool(), 'live_llm', CAP_DAY)).toBe(1);

    const err = await errorOf(createQuote(ws, { text: `${TEXT} 다시요` }, CAP_DAY, r));
    expect(err).toMatchObject({ code: 'LIMIT_EXCEEDED', skipCause: 'daily_cap' });
    expect(live.calls).toBe(1);
  });

  it('받아 둔 녹화가 있는 보기 문의는 키 없이도 조건이 뽑힌다. 답장은 그 상품으로 받아 둔 녹화가 없으면 틀 문장이다', async () => {
    const records = parseRecordingLines(readFileSync('data/recordings/quote.jsonl', 'utf8'), 'quote.jsonl');
    const replay = router({ store: new MemoryCallStore(records) });
    // 답장의 녹화는 본보기 공간의 상품 이름으로 받아 둔 것이다. 이 시험의 지어낸 상품(이름이 다르다)으로는 답장 요청이 달라 녹화가 맞지 않는다.
    const sample = quoteSamples().find((s) => s.id === 'q-ko-03');
    const ws = await newWorkspace();
    const ids = await seedProducts(ws);
    const got = await createQuote(ws, { text: sample?.text ?? '', today: TODAY }, T0, replay);
    expect(got.llm).toMatchObject({ extract: { recorded: true, live: false }, reply: null, replySkipCause: 'no_key' });
    expect(got.llm.extract.costUsd).toBeGreaterThan(0);
    expect(got.conditions).toMatchObject({ region: '강남역', dateFrom: '2026-12-01', dateTo: '2026-12-31', type: 'ad', subtype: '지하철', days: 30 });
    expect(got.selectedProductId).toBe(ids.get('강남역 스크린도어 광고'));
    expect(got.reply).toMatchObject({ source: 'template', status: 'ok' });
  });
});

describe('답장의 글 검사', () => {
  it('첫 답이 걸리면 까닭을 알려 한 번만 다시 부른다. 다시 받은 글이 통과하면 그 글이다', async () => {
    const ws = await newWorkspace();
    await seedProducts(ws);
    const r = scripted(HONGDAE, ['총액은 1,400,000원입니다.', '총액은 {total}입니다. 기간은 {days}일입니다.']);
    const got = await createQuote(ws, { text: TEXT, today: TODAY }, T0, r);
    expect(r.replyCalls).toBe(2);
    expect(got.reply).toMatchObject({ source: 'llm', status: 'ok', failCodes: [], text: '총액은 1,400,000원 (부가세 별도)입니다. 기간은 7일입니다.' });
  });

  it('두 번 다 걸리면 모델의 글을 쓰지 않고 틀 문장으로 내려간다. 걸린 까닭은 남는다', async () => {
    const ws = await newWorkspace();
    await seedProducts(ws);
    const r = scripted(HONGDAE, ['총액은 1,400,000원입니다.', '총액은 {total}이고 할인하면 {discount}입니다.']);
    const got = await createQuote(ws, { text: TEXT, today: TODAY }, T0, r);
    expect(r.replyCalls).toBe(2);
    expect(got.reply).toMatchObject({ source: 'template', status: 'needs_review', failCodes: ['PLACEHOLDER_LOST'] });
    expect(got.reply.text).not.toContain('{');
    expect(got.reply.text).toContain('1,400,000원 (부가세 별도)');
    expect(got.llm.replySkipCause).toBeNull();
  });

  it('영어 문의: 답장에 한글이 섞이면 걸린다. 틀 문장에도 용어집에 없는 한글 이름이 남으면 숨기지 않고 알린다', async () => {
    const ws = await newWorkspace();
    await seedProducts(ws);
    const en: QuoteExtraction = { ...NONE, lang: 'en', type: 'catering', subtype: '도시락' };
    const got = await createQuote(ws, { text: 'Do you have lunch boxes?', today: TODAY }, T0, scripted(en, ['We recommend 솔바람 도시락. The total is {total}.']));
    expect(got.conditions.lang).toBe('en');
    expect(got.reply.source).toBe('template');
    expect(got.reply.status).toBe('needs_review');
    expect(got.reply.failCodes).toContain('HANGUL_IN_TEXT');
    expect(got.reply.text).toContain('KRW 600,000 (VAT not included)');
  });
});

describe('확정', () => {
  it('사람이 본 글로 확정한다. 두 번은 못 한다. 자리표시가 남은 글은 받지 않는다', async () => {
    const ws = await newWorkspace();
    await seedProducts(ws);
    const made = await createQuote(ws, { text: TEXT, today: TODAY }, T0, scripted(HONGDAE));
    expect((await errorOf(confirmQuote(ws, made.id, { reply: '총액은 {total}입니다.' }, T0))).code).toBe('BAD_INPUT');
    expect((await errorOf(confirmQuote(ws, made.id, { reply: '가'.repeat(QUOTE_LIMITS.replyMaxChars + 1) }, T0))).code).toBe('BAD_INPUT');
    const done = await confirmQuote(ws, made.id, { reply: '  안내드립니다.\r\n총액은 1,400,000원입니다.  ' }, T0);
    expect(QuoteResponseSchema.safeParse(done).success).toBe(true);
    expect(done).toMatchObject({ status: 'confirmed', confirmedReply: '안내드립니다.\n총액은 1,400,000원입니다.', confirmedAt: T0.toISOString() });
    // 처음 받은 초안은 그대로 남는다.
    expect(done.reply).toEqual(made.reply);
    expect((await errorOf(confirmQuote(ws, made.id, { reply: '다시 확정' }, T0))).code).toBe('BAD_TRANSITION');
  });

  it('다른 공간의 견적은 읽지도 확정하지도 못한다', async () => {
    const ws = await newWorkspace();
    const other = await newWorkspace();
    const made = await createQuote(ws, { text: TEXT, today: TODAY }, T0, scripted(NONE, ['조건에 맞는 상품을 찾지 못했습니다.']));
    expect((await errorOf(getQuote(other, made.id))).code).toBe('NOT_FOUND');
    expect((await errorOf(confirmQuote(other, made.id, { reply: '글' }, T0))).code).toBe('NOT_FOUND');
    expect((await errorOf(getQuote(ws, made.id + 100000))).code).toBe('NOT_FOUND');
  });

  it('고른 상품이 지워져도 견적은 남는다', async () => {
    const ws = await newWorkspace();
    await seedProducts(ws);
    const made = await createQuote(ws, { text: TEXT, today: TODAY }, T0, scripted(HONGDAE));
    await getPool().query('DELETE FROM products WHERE id = $1', [made.selectedProductId]);
    const read = await getQuote(ws, made.id);
    expect(read.selectedProductId).toBeNull();
    expect(read.candidates).toEqual(made.candidates);
    expect(read.reply).toEqual(made.reply);
  });
});

describe('경로', () => {
  const create = (ws: string | null, body: unknown) => call<QuoteResponse>(createRoute, 'POST', '/api/quotes', { ws, body });
  const read = (ws: string | null, id: number | string) => call<QuoteResponse>(getRoute, 'GET', `/api/quotes/${id}`, { ws, id });
  const confirm = (ws: string | null, id: number, body: unknown) => call<QuoteResponse>(confirmRoute, 'POST', `/api/quotes/${id}/confirm`, { ws, id, body });

  it('만들기 201 → 읽기 200 → 확정 200 → 다시 확정 422', async () => {
    const ws = await newWorkspace();
    await seedProducts(ws);
    // 시험용 구현의 기본 답은 "아무 조건도 없음"이다. 값을 낼 수 있는 상품이 모두 맞는다.
    const made = await create(ws, { text: TEXT, today: TODAY });
    expect(made.status).toBe(201);
    expect(QuoteResponseSchema.safeParse(made.body).success).toBe(true);
    expect(made.body).toMatchObject({ workspace: ws, candidateCount: FIXTURE_PRODUCTS.length, today: TODAY });
    expect(made.response.headers.get('cache-control')).toBe('no-store');

    const got = await read(ws, made.body.id);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(made.body);

    const done = await confirm(ws, made.body.id, { reply: '확인했습니다.' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('confirmed');
    const again = await confirm(ws, made.body.id, { reply: '확인했습니다.' });
    expect(again.status).toBe(422);
    expect(again.body).toMatchObject({ code: 'BAD_TRANSITION' });
  });

  it('헤더 없이 만들면 새 공간을 돌려주고, 헤더 없이 읽으면(본보기 공간) 404', async () => {
    const made = await create(null, { text: TEXT });
    expect(made.status).toBe(201);
    track(made.body.workspace);
    expect(made.body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await read(null, made.body.id)).status).toBe(404);
    expect((await confirm(null, made.body.id, { reply: '글' })).status).toBe(404);
  });

  it('꼴이 틀린 요청은 400, 번호 꼴이 아닌 주소는 404, 본보기 공간에 만들기는 403', async () => {
    const ws = await newWorkspace();
    expect((await create(ws, { text: TEXT, extra: 1 })).status).toBe(400);
    expect((await create(ws, { text: 7 })).status).toBe(400);
    expect((await create(ws, { text: TEXT, today: '2027-02-30' })).status).toBe(400);
    expect((await create(ws, { text: TEXT, productId: 0 })).status).toBe(400);
    expect((await create(ws, '{')).status).toBe(400);
    expect((await read(ws, 'abc')).status).toBe(404);
    expect((await confirm(ws, 1, { reply: '' })).status).toBe(400);
    await ensurePublicWorkspace(getPool(), T0);
    const pub = await create(PUBLIC_WORKSPACE_ID, { text: TEXT });
    expect(pub.status).toBe(403);
    expect(pub.body).toMatchObject({ code: 'READ_ONLY_WORKSPACE' });
  });
});
