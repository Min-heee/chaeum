// 파이프라인: 접수 → 작업 줄 → 초안까지 한 바퀴. LLM 길 고르기(녹화 재생 / 실제 호출 상한 / 규칙만)와 그 표시.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DraftDetailResponseSchema } from '@/contract/api';
import { LlmUnavailable } from '@/contract/llm-types';
import { buildExtractRequest, cacheKeyFor } from '@/llm';
import { closePool, getPool, withTx } from '@/server/db';
import { intakeOne } from '@/server/intake';
import { cleanText } from '@/server/limits';
import { llmStatus } from '@/server/llm-router';
import { claim, getJob, reclaimExpired, type Job } from '@/server/queue';
import { readCounter } from '@/server/repos/daily-counters';
import { listEvents } from '@/server/repos/draft-events';
import { getDraft, listFields } from '@/server/repos/drafts';
import { defaultJobHandlers, createJobHandlers } from '@/server/job-handlers';
import { contentApi } from '@/server/content-api';
import { PgLlmCallStore } from '@/server/repos/llm-calls';
import { listProductTexts } from '@/server/repos/products';
import { approveDraft, rejectDraft, reprocessDraft } from '@/server/review';
import { draftDetail, drainJobs, productDetail } from '@/server/service';
import { at, count, dropWorkspaces, newWorkspace, reviewableDraft } from './helpers';
import { clock, drainAll, fakeContent, fakeRouter, goodsExtraction, goodsText, handlersFor, liveStub, MODEL, processed, router } from './pipeline-helpers';

const pool = () => getPool();
/** 실제 호출 상한 시험이 쓰는 날. 다른 시험의 하루 세기와 겹치지 않는다. */
const CAP_DAY = new Date('2003-03-03T03:00:00Z');
const savedKeys: string[] = [];

async function queueDepthOf(): Promise<{ queued: number; running: number }> {
  const { rows } = await pool().query<{ queued: string; running: string }>(
    `SELECT count(*) FILTER (WHERE status = 'queued') AS queued, count(*) FILTER (WHERE status = 'running') AS running FROM jobs`,
  );
  return { queued: Number(rows[0]?.queued), running: Number(rows[0]?.running) };
}

beforeEach(async () => {
  await pool().query('TRUNCATE jobs RESTART IDENTITY');
  await pool().query(`DELETE FROM daily_counters WHERE day >= '2003-03-01' AND day <= '2003-03-31'`);
});

afterAll(async () => {
  await pool().query('DELETE FROM llm_calls WHERE cache_key = ANY($1::text[])', [savedKeys]);
  await pool().query(`DELETE FROM daily_counters WHERE day >= '2003-03-01' AND day <= '2003-03-31'`);
  await dropWorkspaces();
  await closePool();
});

describe('한 바퀴', () => {
  it('글을 넣고 줄을 굴리면 칸이 채워진 초안이 된다', async () => {
    const ws = await newWorkspace();
    const { text, name } = goodsText();
    const doc = await intakeOne(text, { workspaceId: ws, now: at(0) });
    const result = await drainAll(handlersFor({ router: fakeRouter() }));
    expect(result).toMatchObject({ done: 1, dead: 0 });

    const detail = await draftDetail(ws, doc.draftId);
    expect(() => DraftDetailResponseSchema.parse(detail)).not.toThrow();
    expect(detail).toMatchObject({ status: 'READY', version: 2, type: 'goods', subtype: '인쇄물', extractedBy: 'llm', reasons: [] });
    expect(detail.source).toMatchObject({ kind: 'text', originName: null, text: cleanText(text) });
    // 그 종류의 칸 전부가 순서대로 들어 있다. 뽑히지 않은 칸은 값이 없는 채다.
    expect(detail.fields.map((f) => f.field)).toEqual(['name', 'price_krw', 'list_price_krw', 'vat_included', 'size_mm', 'material', 'lead_time_days', 'min_order_qty']);
    expect(detail.fields.find((f) => f.field === 'name')).toMatchObject({ finalValue: name, reasons: [] });
    expect(detail.fields.find((f) => f.field === 'size_mm')?.finalValue).toEqual({ width: 200, height: 600 });
    expect(detail.events.map((e) => [e.actor, e.from, e.to])).toEqual([['system', null, 'PROCESSING'], ['system', 'PROCESSING', 'READY']]);
    expect((await getJob(pool(), 'extract', doc.draftId))?.status).toBe('done');
  });

  it('필수 칸이 비면 확인 필요로 간다', async () => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText(false).text, handlersFor({ router: fakeRouter() }));
    expect(draft.status).toBe('NEEDS_REVIEW');
    expect((await listFields(pool(), draft.id)).find((f) => f.field === 'size_mm')?.reasons).toEqual(['REQUIRED_MISSING']);
  });

  it('줄 굴리기는 처리기가 있는 종류의 남은 일만 센다', async () => {
    const ws = await newWorkspace();
    await intakeOne(goodsText().text, { workspaceId: ws, now: at(0) });
    const { draftId, version } = await reviewableDraft(ws);
    await drainAll(handlersFor({ router: fakeRouter() }));
    await approveDraft({ workspaceId: ws, draftId, version, now: at(0) }); // 글 작업 한 건이 줄에 선다
    const drained = await drainJobs(() => at(0), handlersFor({ router: fakeRouter() }));
    expect(drained).toMatchObject({ done: 0, remaining: 0 });
    expect((await getJob(pool(), 'content', (await approvedProductId(ws)) as number))?.status).toBe('queued');
  });
});

async function approvedProductId(ws: string): Promise<number | null> {
  const { rows } = await pool().query<{ id: string }>('SELECT id FROM products WHERE workspace_id = $1', [ws]);
  return rows[0] ? Number(rows[0].id) : null;
}

describe('규칙만 길', () => {
  const cases = [
    ['녹화만 쓰는 방식인데 녹화가 없다', { providerKind: 'replay', apiKey: 'k' }, 'cache_miss'],
    ['키가 없다', { providerKind: 'anthropic', dailyCap: 5 }, 'no_key'],
    ['실제 호출이 꺼져 있다', { providerKind: 'anthropic', apiKey: 'k', dailyCap: 0 }, 'off'],
  ] as const;

  it.each(cases)('%s → LLM_SKIPPED 와 원인이 남는다', async (_label, config, cause) => {
    const ws = await newWorkspace();
    const draft = await processed(ws, goodsText().text, handlersFor({ router: router(config) }));
    // 규칙만으로 뽑은 것은 값이 다 있어도 사람이 본다.
    expect(draft).toMatchObject({ status: 'NEEDS_REVIEW', extractedBy: 'rules', llmSkipCause: cause, llmRecorded: null, model: null });
    expect(draft.reasons).toContain('LLM_SKIPPED');
    const detail = await draftDetail(ws, draft.id);
    expect(detail.llm).toEqual({ recorded: false, live: false, skipCause: cause, originalLatencyMs: null, originalCostUsd: null, model: null, promptVersion: null });
  });

  it('글이 2,000자를 넘으면 실제 호출을 하지 않는다', async () => {
    const ws = await newWorkspace();
    const live = liveStub();
    const long = `${goodsText().text}\n${'가나다라 '.repeat(450)}`;
    const draft = await processed(ws, long, handlersFor({ router: router({ providerKind: 'anthropic', liveProvider: live, dailyCap: 5 }) }, () => CAP_DAY));
    expect(draft).toMatchObject({ extractedBy: 'rules', llmSkipCause: 'too_long' });
    expect(live.calls).toBe(0);
    expect(await readCounter(pool(), 'live_llm', CAP_DAY)).toBe(0);
  });

  it('모델이 거절하면 다시 하지 않고 규칙만으로 내려간다', async () => {
    const ws = await newWorkspace();
    const live = liveStub({ fail: () => new LlmUnavailable('REFUSAL') });
    const draft = await processed(ws, goodsText().text, handlersFor({ router: router({ providerKind: 'anthropic', liveProvider: live, dailyCap: 5 }) }, () => CAP_DAY));
    expect(draft).toMatchObject({ extractedBy: 'rules', llmSkipCause: 'refusal', status: 'NEEDS_REVIEW' });
    expect(live.calls).toBe(1);
  });

  it('잠깐의 오류는 두 번 다시 해 보고, 세 번째에도 안 되면 실패가 아니라 규칙만으로 내려간다', async () => {
    const ws = await newWorkspace();
    const live = liveStub({ fail: () => new LlmUnavailable('TRANSIENT') });
    const doc = await intakeOne(goodsText().text, { workspaceId: ws, now: at(0) });
    const c = clock();
    const total = await drainAll(handlersFor({ router: router({ providerKind: 'anthropic', liveProvider: live, dailyCap: 9 }) }, () => CAP_DAY), c);
    expect(total).toMatchObject({ retried: 2, done: 1, dead: 0 });
    expect(live.calls).toBe(3);
    expect(await getDraft(pool(), ws, doc.draftId)).toMatchObject({ status: 'NEEDS_REVIEW', extractedBy: 'rules', llmSkipCause: 'error' });
    // 다시 한 시도도 하루 자리를 쓴다.
    expect(await readCounter(pool(), 'live_llm', CAP_DAY)).toBe(3);
  });

  it('잠깐의 오류 뒤에 되면 LLM 결과로 끝난다', async () => {
    const ws = await newWorkspace();
    let n = 0;
    const live = liveStub({ fail: () => ((n += 1) === 1 ? new LlmUnavailable('TRANSIENT') : null) });
    const draft = await processed(ws, goodsText().text, handlersFor({ router: router({ providerKind: 'anthropic', liveProvider: live, dailyCap: 9 }) }, () => CAP_DAY));
    expect(draft).toMatchObject({ status: 'READY', extractedBy: 'llm', llmSkipCause: null, llmRecorded: false });
  });
});

describe('실제 호출 상한', () => {
  it('상한이 1 이면 첫 글만 실제로 부르고 둘째 글은 규칙만으로 간다', async () => {
    const ws = await newWorkspace();
    const live = liveStub();
    const handlers = handlersFor({ router: router({ providerKind: 'anthropic', liveProvider: live, dailyCap: 1 }) }, () => CAP_DAY);
    const first = await processed(ws, goodsText().text, handlers);
    const second = await processed(ws, goodsText().text, handlers);

    expect(first).toMatchObject({ status: 'READY', extractedBy: 'llm', llmRecorded: false, llmLatencyMs: 1234, model: MODEL, promptVersion: 'extract-v1' });
    expect(first.llmCostUsd).toBeGreaterThan(0);
    expect((await draftDetail(ws, first.id)).llm).toMatchObject({ live: true, recorded: false, skipCause: null, originalLatencyMs: 1234 });
    expect(second).toMatchObject({ status: 'NEEDS_REVIEW', extractedBy: 'rules', llmSkipCause: 'daily_cap' });
    expect(live.calls).toBe(1);
    expect(await readCounter(pool(), 'live_llm', CAP_DAY)).toBe(1);
  });

  it('여럿이 한꺼번에 자리를 잡아도 상한을 넘지 않는다', async () => {
    const r = router({ providerKind: 'anthropic', liveProvider: liveStub(), dailyCap: 2 });
    const picks = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => r.pick({ task: 'extract', cacheKey: `없는-키-${i}`, textChars: 10, now: CAP_DAY })));
    expect(picks.filter((p) => p.route === 'anthropic')).toHaveLength(2);
    expect(picks.filter((p) => p.route === 'rules' && p.cause === 'daily_cap')).toHaveLength(4);
    expect(await readCounter(pool(), 'live_llm', CAP_DAY)).toBe(2);
  });

  it('살아 있는지 보기에 상한과 남은 수가 나온다', async () => {
    const r = router({ providerKind: 'anthropic', liveProvider: liveStub(), dailyCap: 3 });
    await r.pick({ task: 'extract', cacheKey: '없는-키', textChars: 10, now: CAP_DAY });
    expect(await llmStatus({ ANTHROPIC_API_KEY: 'k', LIVE_LLM_DAILY_CAP: '3' }, CAP_DAY)).toEqual({ provider: 'anthropic', live: true, model: MODEL, liveCap: 3, liveLeftToday: 2 });
    expect(await llmStatus({ LIVE_LLM_DAILY_CAP: '3' }, CAP_DAY)).toMatchObject({ provider: 'replay', live: false, liveCap: 0, liveLeftToday: 0 });
    expect(await llmStatus({ LLM_PROVIDER: '엉뚱한값' }, CAP_DAY)).toMatchObject({ provider: 'invalid', live: false });
  });
});

describe('녹화 재생', () => {
  it('장부에 답이 있으면 실제 호출이 켜져 있어도 그 답을 쓰고, 녹화할 때 잰 시간과 비용을 남긴다', async () => {
    const ws = await newWorkspace();
    const { text } = goodsText();
    const key = cacheKeyFor(buildExtractRequest(cleanText(text)), MODEL);
    savedKeys.push(key);
    await new PgLlmCallStore().save({
      task: 'extract', provider: 'anthropic', model: MODEL, promptVersion: 'extract-v1', cacheKey: key,
      response: goodsExtraction(text), stopReason: 'end_turn', inputTokens: 4000, outputTokens: 1000, costUsd: 0.0009, latencyMs: 5100, isRecorded: true,
    });

    const live = liveStub();
    const draft = await processed(ws, text, handlersFor({ router: router({ providerKind: 'anthropic', liveProvider: live, dailyCap: 5 }) }, () => CAP_DAY));
    expect(draft).toMatchObject({ status: 'READY', extractedBy: 'llm', llmRecorded: true, llmLatencyMs: 5100, llmSkipCause: null });
    expect(draft.llmCostUsd).toBeCloseTo(0.0009, 6);
    expect((await draftDetail(ws, draft.id)).llm).toMatchObject({ recorded: true, live: false, originalLatencyMs: 5100 });
    // 돈도 자리도 쓰지 않았다.
    expect(live.calls).toBe(0);
    expect(await readCounter(pool(), 'live_llm', CAP_DAY)).toBe(0);

    // 키가 없는 서버(녹화만)에서도 같은 답이 나온다.
    const other = await newWorkspace();
    expect(await processed(other, text, handlersFor({ router: router({}) }))).toMatchObject({ extractedBy: 'llm', llmRecorded: true });
  });
});

describe('여러 번 돌아도 한 번만', () => {
  it('같은 작업의 일을 두 번 하고 저장을 두 번 해도 초안은 한 번만 바뀐다', async () => {
    const ws = await newWorkspace();
    const doc = await intakeOne(goodsText().text, { workspaceId: ws, now: at(0) });
    const handler = handlersFor({ router: fakeRouter() }).extract;
    const [job] = await claim(pool(), at(0), 1);

    const save1 = await handler?.work(job as Job);
    const save2 = await handler?.work(job as Job);
    for (const save of [save1, save2, save1]) {
      await withTx(async (client) => {
        if (save) await save(client, at(1000));
      });
    }
    expect(await getDraft(pool(), ws, doc.draftId)).toMatchObject({ status: 'READY', version: 2 });
    expect((await listEvents(pool(), doc.draftId)).map((e) => e.to)).toEqual(['PROCESSING', 'READY']);
    expect(await count('draft_fields WHERE draft_id = $1', [doc.draftId])).toBe(8);

    // 이미 끝난 초안이면 모델을 부르지도 않는다.
    const live = liveStub();
    const again = handlersFor({ router: router({ providerKind: 'anthropic', liveProvider: live, dailyCap: 5 }) }, () => CAP_DAY).extract;
    expect(await again?.work(job as Job)).toBeUndefined();
    expect(live.calls).toBe(0);
  });

  it('사람이 반려한 뒤 늦게 온 저장은 버려진다', async () => {
    const ws = await newWorkspace();
    const doc = await intakeOne(goodsText(false).text, { workspaceId: ws, now: at(0) });
    const handler = handlersFor({ router: fakeRouter() }).extract;
    const [job] = await claim(pool(), at(0), 1);
    const save1 = await handler?.work(job as Job);
    const save2 = await handler?.work(job as Job);
    await withTx(async (client) => save1 && (await save1(client, at(1000))));
    const rejected = await rejectDraft({ workspaceId: ws, draftId: doc.draftId, version: 2, reasonCode: 'OTHER', now: at(2000) });
    await withTx(async (client) => save2 && (await save2(client, at(3000))));
    expect(await getDraft(pool(), ws, doc.draftId)).toMatchObject({ status: 'REJECTED', version: rejected.version });
  });
});

describe('다시 돌리기', () => {
  it('규칙만으로 뽑혔던 초안을 다시 돌리면 지난 길 기록이 비고, 이번 길이 새로 적힌다', async () => {
    const ws = await newWorkspace();
    const { text } = goodsText();
    const first = await processed(ws, text, handlersFor({ router: router({}) }));
    expect(first).toMatchObject({ extractedBy: 'rules', llmSkipCause: 'no_key' });

    const rejected = await rejectDraft({ workspaceId: ws, draftId: first.id, version: first.version, reasonCode: 'OTHER', now: at(1000) });
    const back = await reprocessDraft({ workspaceId: ws, draftId: first.id, version: rejected.version, now: at(2000) });
    expect(await getDraft(pool(), ws, first.id)).toMatchObject({ status: 'PROCESSING', llmSkipCause: null, version: back.version });

    await drainAll(handlersFor({ router: fakeRouter() }), clock(5000));
    expect(await getDraft(pool(), ws, first.id)).toMatchObject({ status: 'READY', extractedBy: 'llm', llmSkipCause: null, reasons: [] });
  });

  it('다시 돌리기 직후 처리 중인 초안에는 지난 결과(칸·종류·사유)가 보이지 않는다', async () => {
    const ws = await newWorkspace();
    const first = await processed(ws, goodsText(false).text, handlersFor({ router: router({}) }));
    expect(first.reasons).toContain('LLM_SKIPPED');
    expect((await listFields(pool(), first.id)).length).toBeGreaterThan(0);

    const rejected = await rejectDraft({ workspaceId: ws, draftId: first.id, version: first.version, reasonCode: 'OTHER', now: at(1000) });
    await reprocessDraft({ workspaceId: ws, draftId: first.id, version: rejected.version, now: at(2000) });
    const detail = await draftDetail(ws, first.id);
    expect(() => DraftDetailResponseSchema.parse(detail)).not.toThrow();
    expect(detail).toMatchObject({ status: 'PROCESSING', fields: [], reasons: [], type: null, subtype: null, extractedBy: null, reject: null });
    expect(detail.llm).toMatchObject({ recorded: false, live: false, skipCause: null, model: null, promptVersion: null });

    // 다시 뽑으면 칸이 돌아온다.
    await drainAll(handlersFor({ router: fakeRouter() }), clock(5000));
    const again = await draftDetail(ws, first.id);
    expect(again.type).toBe('goods');
    expect(again.fields.length).toBeGreaterThan(0);
  });
});

describe('작업이 죽었을 때의 뒷일(진짜 처리기)', () => {
  it('뽑기 작업의 임대가 세 번 끝나도록 못 끝내면 초안이 "처리 실패"가 되고 까닭(JOB_DEAD)이 변경 기록에 남는다', async () => {
    const ws = await newWorkspace();
    const doc = await intakeOne(goodsText().text, { workspaceId: ws, now: at(0) });
    const handlers = handlersFor({ router: fakeRouter() });
    // 작업자가 집기만 하고 죽기를 세 번 되풀이한다.
    for (let i = 0; i < 3; i += 1) {
      const [job] = await claim(pool(), at(i * 120_000), 1);
      expect(job?.attempts).toBe(i + 1);
      // 앞의 두 번은 임대가 끝난 뒤 줄로 돌아온다.
      if (i < 2) expect((await reclaimExpired(pool(), at(i * 120_000 + 61_000))).requeued).toHaveLength(1);
    }
    // 세 번째 임대도 끝났다. 굴리면 회수가 이 작업을 dead 로 보내고 뒷일이 초안을 실패로 돌린다.
    const result = await drainAll(handlers, clock(2 * 120_000 + 61_000));
    expect(result).toMatchObject({ dead: 1, done: 0 });

    expect((await getJob(pool(), 'extract', doc.draftId))?.status).toBe('dead');
    expect(await getDraft(pool(), ws, doc.draftId)).toMatchObject({ status: 'FAILED' });
    const events = await listEvents(pool(), doc.draftId);
    expect(events[events.length - 1]).toMatchObject({ actor: 'system', from: 'PROCESSING', to: 'FAILED', reasonCode: 'JOB_DEAD' });
  });

  it('뽑기가 세 번 던져도 같다: 초안은 "처리 실패", 다시 돌릴 수 있다', async () => {
    const ws = await newWorkspace();
    const doc = await intakeOne(goodsText().text, { workspaceId: ws, now: at(0) });
    const broken = handlersFor({ router: fakeRouter(), extract: async () => { throw new Error('뽑기 고장'); } });
    expect(await drainAll(broken)).toMatchObject({ retried: 2, dead: 1 });
    const failed = await getDraft(pool(), ws, doc.draftId);
    expect(failed).toMatchObject({ status: 'FAILED' });
    await expect(reprocessDraft({ workspaceId: ws, draftId: doc.draftId, version: failed!.version, now: at(900_000) })).resolves.toMatchObject({ status: 'PROCESSING' });
  });

  it('글 작업이 죽으면 상품의 글이 "만드는 중"으로 남지 않고 틀 문장 넷이 "글 확인 필요"로 남는다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    const approved = await approveDraft({ workspaceId: ws, draftId, version, now: at(0) });
    const broken = { ...contentApi!, generateContent: async () => { throw new Error('글 만들기 고장'); } };
    const result = await drainAll(createJobHandlers({ now: () => at(0), router: fakeRouter(), content: broken }));
    expect(result).toMatchObject({ retried: 2, dead: 1 });

    expect((await getJob(pool(), 'content', approved.productId))?.status).toBe('dead');
    const detail = await productDetail(ws, approved.productId);
    expect(detail.textState).toBe('needs_review');
    expect(detail.texts).toHaveLength(4);
    expect(detail.texts.every((t) => t.source === 'template' && t.status === 'needs_review' && t.text.length > 0)).toBe(true);
  });

  it('틀 문장 만들기가 따로 없는 글 만들기를 끼웠어도, 죽으면 모델 없이 만든 글이 남는다. 이미 있는 글은 건드리지 않는다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    const approved = await approveDraft({ workspaceId: ws, draftId, version, now: at(0) });
    const content = fakeContent();
    const handlers = handlersFor({ router: fakeRouter(), content });
    const job = (await getJob(pool(), 'content', approved.productId)) as Job;

    await withTx((client) => handlers.content!.onDead!(client, job, at(1000)));
    expect(content.seen).toEqual([{ provider: null, skipCause: 'error' }]);
    const texts = await listProductTexts(pool(), approved.productId);
    expect(texts.map((t) => t.source)).toEqual(['template', 'template', 'template', 'template']);

    await pool().query(`UPDATE product_texts SET text = '사람이 고친 글', source = 'human' WHERE product_id = $1`, [approved.productId]);
    await withTx((client) => handlers.content!.onDead!(client, job, at(2000)));
    expect((await listProductTexts(pool(), approved.productId)).every((t) => t.text === '사람이 고친 글')).toBe(true);
  });
});

describe('줄 굴리기의 남은 일', () => {
  it('remaining 은 기다리는 일과 돌고 있는 일을 함께 센다', async () => {
    const ws = await newWorkspace();
    await intakeOne(goodsText().text, { workspaceId: ws, now: at(0) });
    await intakeOne(goodsText().text, { workspaceId: ws, now: at(0) });
    // 한 건은 다른 작업자가 집어 돌리는 중이다.
    await claim(pool(), at(0), 1);
    const idle = await drainJobs(() => at(0), handlersFor({ router: fakeRouter() }));
    expect(idle).toMatchObject({ done: 1, remaining: 1 });
    expect(await queueDepthOf()).toEqual({ queued: 0, running: 1 });
  });
});

describe('글 만들기 작업', () => {
  it('승인된 상품에 두 언어 글 넷이 붙는다. 두 번 돌아도 넷이다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    const approved = await approveDraft({ workspaceId: ws, draftId, version, now: at(0) });
    const content = fakeContent();
    const handlers = handlersFor({ router: fakeRouter(), content });

    // 줄에는 이 초안의 뽑기 작업(이미 끝난 초안이라 아무것도 안 한다)과 글 작업이 있다.
    expect(await drainAll(handlers)).toMatchObject({ done: 2, dead: 0 });
    const texts = await listProductTexts(pool(), approved.productId);
    expect(texts).toHaveLength(4);
    // 숫자는 코드가 넣는다. 모델에게 가는 자료에는 글자 정보만 있다.
    expect(texts[0]).toMatchObject({ text: '응원 슬로건 5000', source: 'llm', status: 'ok' });
    expect(content.seen).toEqual([{ provider: 'fake', skipCause: null }]);

    const job = (await getJob(pool(), 'content', approved.productId)) as Job;
    const save = await handlers.content?.work({ ...job, attempts: 1 });
    await withTx(async (client) => save && (await save(client, at(1000))));
    expect(await count('product_texts WHERE product_id = $1', [approved.productId])).toBe(4);
  });

  it('녹화도 키도 없으면 모델 없이 틀 문장으로 내려가고 까닭이 넘어간다', async () => {
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    const approved = await approveDraft({ workspaceId: ws, draftId, version, now: at(0) });
    const content = fakeContent();
    await drainAll(handlersFor({ router: router({}), content }));
    expect(content.seen).toEqual([{ provider: null, skipCause: 'no_key' }]);
    expect((await listProductTexts(pool(), approved.productId)).every((t) => t.source === 'template' && t.status === 'needs_review')).toBe(true);
  });

  it('진짜 글 만들기를 끼워도 같다: 모델을 못 부르면 틀 문장 넷이 "글 확인 필요"로 남는다', async () => {
    expect(Object.keys(defaultJobHandlers(() => at(0))).sort()).toEqual(['content', 'extract']);
    const ws = await newWorkspace();
    const { draftId, version } = await reviewableDraft(ws);
    const approved = await approveDraft({ workspaceId: ws, draftId, version, now: at(0) });
    await drainAll(createJobHandlers({ now: () => at(0), router: router({}), content: contentApi }));
    const texts = await listProductTexts(pool(), approved.productId);
    expect(texts.map((t) => [t.lang, t.field, t.source, t.status])).toEqual([
      ['en', 'title', 'template', 'needs_review'],
      ['en', 'summary', 'template', 'needs_review'],
      ['zh-Hans', 'title', 'template', 'needs_review'],
      ['zh-Hans', 'summary', 'template', 'needs_review'],
    ]);
    // 숫자는 코드가 넣었다. 틀 문장에도 자리표시가 남아 있지 않다.
    expect(texts.every((t) => t.text.length > 0 && !/\{[a-z_]+\}/.test(t.text))).toBe(true);
    expect((await productDetail(ws, approved.productId)).textState).toBe('needs_review');
  });
});
