// 실행 몸통과 회귀 문지기의 시험. 모델은 부르지 않는다(정해 둔 답을 주는 가짜 공급자와 메모리 장부).
import { describe, expect, it } from 'vitest';
import type { EvalBaseline, GoldDoc } from '@/contract/eval-types';
import type { Extraction } from '@/contract/fields';
import { LlmUnavailable, type LlmCallStore, type LlmProvider, type LlmRequest, type LlmResult, type LlmUsage } from '@/contract/llm-types';
import { cacheKeyFor, costUsd, MemoryCallStore } from '@/llm';
import { buildExtractRequestV1 } from '@/llm/prompts/extract.v1';
import { checkGate } from './replay';
import { estimateRun, GUESS_USAGE, methodOutputs, metricsByMethod, runDocs, selectDocs, type ReviewLine, type RunnerDeps } from './runner';

const MODEL = 'claude-haiku-5-5';
/** 한 건에 0.002 달러가 되는 토큰 수(입력 0.1, 출력 0.5 달러 / 100만 토큰) */
const USAGE: LlmUsage = { inputTokens: 10_000, outputTokens: 2_000 };
const priceUsd = (usage: LlmUsage) => costUsd(MODEL, usage);

const nameOf = (n: number) => `별무리 엽서 세트 ${n}호`;
const contentOf = (n: number) => `${nameOf(n)}\n사이즈 100x148mm\n판매가 15,000원`;

function goodsDoc(n: number): GoldDoc {
  return {
    id: `dev-90${n}`,
    split: 'dev',
    goldVersion: 1,
    content: contentOf(n),
    author: 'ai',
    traps: [],
    truth: {
      type: 'goods',
      subtype: '인쇄물',
      fields: {
        name: nameOf(n),
        price_krw: 15000,
        list_price_krw: null,
        vat_included: null,
        size_mm: { width: 100, height: 148 },
        material: null,
        lead_time_days: null,
        min_order_qty: null,
      },
    },
  };
}

/** 원문에 적힌 대로 뽑은 답. */
function rightAnswer(text: string): Extraction {
  const name = text.split('\n')[0]!;
  return {
    type: 'goods',
    subtype: '인쇄물',
    fields: [
      { field: 'name', raw: name, value: name, evidence: name },
      { field: 'price_krw', raw: '15,000원', value: 15000, evidence: '판매가 15,000원' },
      { field: 'size_mm', raw: '100x148mm', value: { width: 100, height: 148 }, evidence: '사이즈 100x148mm' },
    ],
  };
}

/** 실제 공급자처럼 구는 가짜: 답을 주고 장부에 적는다. 오류를 돌려주면 그대로 던진다. */
function stubLive(store: LlmCallStore, answer: (text: string) => Extraction | LlmUnavailable = rightAnswer) {
  const asked: string[] = [];
  const provider: LlmProvider = {
    name: 'anthropic',
    model: MODEL,
    async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      const text = (req.input as { text: string }).text;
      asked.push(text);
      const out = answer(text);
      if (out instanceof LlmUnavailable) throw out;
      await store.save({
        task: req.task,
        provider: 'anthropic',
        model: MODEL,
        promptVersion: req.promptVersion,
        cacheKey: cacheKeyFor(req as LlmRequest<unknown>, MODEL),
        response: out,
        stopReason: 'end_turn',
        inputTokens: USAGE.inputTokens,
        outputTokens: USAGE.outputTokens,
        costUsd: priceUsd(USAGE),
        latencyMs: 1200,
        isRecorded: false,
      });
      return { output: req.schema.parse(out), stopReason: 'end_turn', usage: USAGE, latencyMs: 1200, recorded: false };
    },
  };
  return { provider, asked };
}

const deps = (store: LlmCallStore, live: LlmProvider | null, maxUsd: number | null = null): RunnerDeps => ({
  model: MODEL,
  buildRequest: buildExtractRequestV1,
  store,
  live,
  maxUsd,
  priceUsd,
});

const docs = [1, 2, 3, 4, 5].map(goodsDoc);

describe('확인 안 한 건 빼기', () => {
  const reviews: ReviewLine[] = [
    { goldDocId: 'dev-901', pass: 1, verdict: 'ok' },
    { goldDocId: 'dev-902', pass: 1, verdict: 'fixed' },
    { goldDocId: 'dev-903', pass: 1, verdict: 'ok' },
    { goldDocId: 'dev-903', pass: 1, verdict: 'dropped' },
    { goldDocId: 'dev-905', pass: 1, verdict: 'dropped' },
    { goldDocId: 'dev-905', pass: 1, verdict: 'ok' },
    // 다시 보기(pass 2)의 판정은 채점 대상을 바꾸지 않는다
    { goldDocId: 'dev-901', pass: 2, verdict: 'dropped' },
  ];

  it('가장 최근 첫 확인이 맞음·고침인 문서만 남고, 뺀 건수를 센다', () => {
    const picked = selectDocs(docs, reviews);
    expect(picked.docs.map((d) => d.id)).toEqual(['dev-901', 'dev-902', 'dev-905']);
    expect(picked.excludedUnreviewed).toBe(1);
    expect(picked.excludedDropped).toBe(1);
    expect(picked.includesUnreviewed).toBe(false);
  });

  it('확인 기록이 하나도 없으면 한 건도 채점하지 않는다', () => {
    const picked = selectDocs(docs, []);
    expect(picked.docs).toEqual([]);
    expect(picked.excludedUnreviewed).toBe(5);
  });

  it('--include-unreviewed 면 확인 전 문서도 넣고 "확인 전 포함"이 선다. 버림은 그래도 뺀다', () => {
    const picked = selectDocs(docs, reviews, { includeUnreviewed: true });
    expect(picked.docs.map((d) => d.id)).toEqual(['dev-901', 'dev-902', 'dev-904', 'dev-905']);
    expect(picked.includesUnreviewed).toBe(true);
    expect(picked.excludedUnreviewed).toBe(0);
    expect(picked.excludedDropped).toBe(1);
  });
});

describe('세 방식의 답', () => {
  it('모델 값이 틀리고 원문 표현이 맞으면: llm_only 는 틀리고, llm_code 는 맞되 표시가 붙는다', () => {
    const text = contentOf(1);
    const answer = rightAnswer(text);
    answer.fields[1] = { field: 'price_krw', raw: '15,000원', value: 150000, evidence: '판매가 15,000원' };
    const out = methodOutputs(text, answer);
    expect(out.llm_only.values.price_krw).toBe(150000);
    expect(out.llm_only.docFlagged).toBe(false);
    expect(out.llm_code.values.price_krw).toBe(15000);
    expect(out.llm_code.fieldFlags.price_krw).toBe(true);
    expect(out.llm_code.docFlagged).toBe(true);
  });

  it('답을 못 받으면 llm 두 방식은 빈 답이고, llm_code 는 표시가 붙은 것으로 친다. rules 는 그대로 나온다', () => {
    const out = methodOutputs(contentOf(1), null);
    expect(out.llm_only.type).toBeNull();
    expect(out.llm_code.type).toBeNull();
    expect(out.llm_code.docFlagged).toBe(true);
    expect(out.rules.type).not.toBeNull();
  });
});

describe('돌리기', () => {
  it('문서마다 한 번 부르고, 그 한 번에서 세 방식의 결과 줄이 나온다', async () => {
    const store = new MemoryCallStore();
    const live = stubLive(store);
    const out = await runDocs(docs, deps(store, live.provider));
    expect(live.asked).toHaveLength(5);
    expect(out.docIds).toHaveLength(5);
    // 문서 하나에 type + subtype + 굿즈 칸 8 = 10줄
    for (const method of ['rules', 'llm_only', 'llm_code'] as const) expect(out.cells[method]).toHaveLength(50);
    const m = metricsByMethod(out);
    expect(m.llm_only.docsAllCorrect).toEqual({ num: 5, den: 5 });
    expect(m.llm_code.docsAllCorrect).toEqual({ num: 5, den: 5 });
    expect(m.llm_only.fieldAccuracy.overall).toEqual({ num: 15, den: 15 });
    expect(m.llm_only.fabricated.overall).toEqual({ num: 0, den: 25 });
    expect(m.llm_only.autoApprove).toBeNull();
    expect(m.rules.costTime).toBeNull();
    expect(m.llm_code.costTime).toMatchObject({ costUsdTotal: 0.01, costUsdPerDoc: 0.002, latencyMsP50: 1200, fromRecording: false });
    expect(out.spentUsd).toBe(0.01);
  });

  it('--max-usd: 넘을 것 같으면 멈추고 끝난 데까지만 돌려준다', async () => {
    const store = new MemoryCallStore();
    const live = stubLive(store);
    // 한 건 0.002. 두 건 뒤 0.004 이고 한 건 더 부르면 0.006 으로 상한 0.005 를 넘는다.
    const out = await runDocs(docs, deps(store, live.provider, 0.005));
    expect(out.stoppedByBudget).toBe(true);
    expect(out.docIds).toEqual(['dev-901', 'dev-902']);
    expect(out.notRun).toEqual(['dev-903', 'dev-904', 'dev-905']);
    expect(out.spentUsd).toBe(0.004);
    expect(live.asked).toHaveLength(2);
    expect(metricsByMethod(out).llm_code.docs).toBe(2);
    expect(store.size).toBe(2);
  });

  it('장부에 있는 답은 부르지 않고 돈으로 세지 않는다', async () => {
    const store = new MemoryCallStore();
    await runDocs(docs.slice(0, 2), deps(store, stubLive(store).provider));
    const live = stubLive(store);
    const out = await runDocs(docs, deps(store, live.provider, 0.0001));
    // 앞의 두 건은 장부에서 읽는다. 셋째 건을 부른 뒤 상한(0.0001)을 넘어 멈춘다.
    expect(live.asked).toHaveLength(1);
    expect(out.docIds).toEqual(['dev-901', 'dev-902', 'dev-903']);
    expect(out.calls.map((c) => c.recorded)).toEqual([true, true, false]);
    expect(out.spentUsd).toBe(0.002);
    expect(out.stoppedByBudget).toBe(true);
    // 녹화본에서 읽은 건의 비용·시간은 녹화할 때 잰 값이다
    expect(metricsByMethod(out).llm_code.costTime).toMatchObject({ costUsdTotal: 0.006, fromRecording: true });
  });

  it('답을 못 쓴 호출의 토큰도 돈으로 센다(LlmUnavailable.usage)', async () => {
    const store = new MemoryCallStore();
    const live = stubLive(store, (text) =>
      text.includes('2호') ? new LlmUnavailable('BAD_OUTPUT', '답이 스키마와 다르다', USAGE) : text.includes('3호') ? new LlmUnavailable('TRANSIENT') : rightAnswer(text),
    );
    const out = await runDocs(docs.slice(0, 4), deps(store, live.provider, 0.007));
    expect(out.failures).toEqual([
      { goldDocId: 'dev-902', code: 'BAD_OUTPUT' },
      { goldDocId: 'dev-903', code: 'TRANSIENT' },
    ]);
    // 901 성공(0.002) + 902 실패했지만 토큰 나감(0.002) + 903 은 토큰 없음 = 0.004. 904 를 부르면 0.006 으로 0.007 안이다.
    expect(out.spentUsd).toBe(0.006);
    expect(out.docIds).toHaveLength(4);
    // 실패한 문서도 빼지 않고 빈 답으로 채점한다
    const m = metricsByMethod(out);
    expect(m.llm_code.docs).toBe(4);
    expect(m.llm_code.docsAllCorrect).toEqual({ num: 2, den: 4 });
    expect(m.llm_code.typeAccuracy).toEqual({ num: 2, den: 4 });
    expect(m.llm_code.autoApprove?.ready.den).toBe(4);
  });

  it('실패한 호출의 돈 때문에 상한에 걸리면 거기서 멈춘다', async () => {
    const store = new MemoryCallStore();
    const live = stubLive(store, () => new LlmUnavailable('MAX_TOKENS', '답이 잘렸다', USAGE));
    const out = await runDocs(docs, deps(store, live.provider, 0.003));
    expect(out.stoppedByBudget).toBe(true);
    expect(out.docIds).toEqual(['dev-901']);
    expect(out.spentUsd).toBe(0.002);
  });

  it('공급자가 없으면 장부에 없는 문서는 CACHE_MISS 로 적힌다(조용히 빼지 않는다)', async () => {
    const out = await runDocs(docs.slice(0, 2), deps(new MemoryCallStore(), null));
    expect(out.failures.map((f) => f.code)).toEqual(['CACHE_MISS', 'CACHE_MISS']);
    expect(out.docIds).toHaveLength(2);
    expect(out.spentUsd).toBe(0);
  });

  it('LLM 과 상관없는 오류는 삼키지 않는다', async () => {
    const store = new MemoryCallStore();
    const broken: LlmProvider = { name: 'anthropic', model: MODEL, complete: async () => Promise.reject(new Error('버그')) };
    await expect(runDocs(docs.slice(0, 1), deps(store, broken))).rejects.toThrow('버그');
  });
});

describe('돌리기 전의 어림', () => {
  it('장부가 비었으면 정해 둔 어림값으로, 있으면 장부 평균으로 낸다', async () => {
    const store = new MemoryCallStore();
    const base = { model: MODEL, buildRequest: buildExtractRequestV1, store, priceUsd };
    const empty = await estimateRun('dev', docs, base);
    expect(empty).toMatchObject({ docs: 5, cached: 0, toCall: 5, basis: 'default_guess' });
    expect(empty.estCostUsd).toBeCloseTo(priceUsd(GUESS_USAGE) * 5, 6);

    await runDocs(docs.slice(0, 2), deps(store, stubLive(store).provider));
    const some = await estimateRun('dev', docs, base);
    expect(some).toMatchObject({ docs: 5, cached: 2, toCall: 3, basis: 'ledger_average' });
    expect(some.estCostUsd).toBeCloseTo(0.006, 6);
  });
});

describe('회귀 문지기', () => {
  const baseline = (over: Partial<EvalBaseline> = {}): EvalBaseline => ({
    split: 'dev',
    method: 'llm_code',
    model: MODEL,
    promptVersion: 'extract-v1',
    goldVersion: 1,
    docs: 5,
    docsAllCorrect: 5,
    gitCommit: 'abc1234',
    recordedOn: '2026-10-12',
    ...over,
  });
  const gate = (store: LlmCallStore, b: EvalBaseline | null, list: readonly GoldDoc[] = docs) =>
    checkGate({ docs: list, excludedUnreviewed: 0, baseline: b, model: MODEL, build: buildExtractRequestV1, store });

  async function recorded(answer?: (text: string) => Extraction): Promise<MemoryCallStore> {
    const store = new MemoryCallStore();
    await runDocs(docs, deps(store, stubLive(store, answer).provider));
    return store;
  }

  it('기준 파일이 없으면 "기준 없음"을 적고 통과한다(숨기지 않는다)', async () => {
    const result = await gate(await recorded(), null);
    expect(result.status).toBe('no_baseline');
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('기준 없음 — 첫 실행 뒤 만든다');
    expect(result.nextBaseline).toMatchObject({ docs: 5, docsAllCorrect: 5, promptVersion: 'extract-v1' });
  });

  it('기준도 없고 확인한 문서도 없으면 통과하되 아무것도 지키지 않았다고 적는다', async () => {
    const result = await checkGate({ docs: [], excludedUnreviewed: 40, baseline: null, model: MODEL, build: buildExtractRequestV1, store: new MemoryCallStore() });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('아무것도 지키지 않는다');
  });

  it('기준과 같거나 나으면 통과', async () => {
    const result = await gate(await recorded(), baseline({ docsAllCorrect: 4 }));
    expect(result.status).toBe('ok');
    expect(result.exitCode).toBe(0);
  });

  it('전부 맞은 문서 수가 기준 아래면 실패하고 틀린 문서를 적는다', async () => {
    // 2호 문서의 값을 틀리게 녹화한다(원문 표현도 없어 코드가 바로잡지 못한다)
    const store = await recorded((text) => {
      const answer = rightAnswer(text);
      if (text.includes('2호')) answer.fields[1] = { field: 'price_krw', raw: null, value: 99000, evidence: '판매가 15,000원' };
      return answer;
    });
    const result = await gate(store, baseline());
    expect(result.status).toBe('regressed');
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('dev-902: price_krw wrong');
  });

  it('녹화본이 없는 문서가 있으면 "다시 녹화 필요"로 실패한다(빼고 채점하지 않는다)', async () => {
    const store = new MemoryCallStore();
    await runDocs(docs.slice(0, 3), deps(store, stubLive(store).provider));
    const result = await gate(store, baseline());
    expect(result.status).toBe('needs_rerecord');
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('녹화본이 없는 문서 2건: dev-904, dev-905');
  });

  it('프롬프트가 바뀌면(시스템 글이 달라지면) 키가 달라져 "다시 녹화 필요"가 된다', async () => {
    const store = await recorded();
    const changed = (text: string) => ({ ...buildExtractRequestV1(text), system: `${buildExtractRequestV1(text).system}\n한 줄 더` });
    const result = await checkGate({ docs, excludedUnreviewed: 0, baseline: baseline(), model: MODEL, build: changed, store });
    expect(result.status).toBe('needs_rerecord');
    expect(result.exitCode).toBe(1);
  });

  it('프롬프트 버전·정답 버전·문서 수가 기준과 다르면 견주지 않고 실패한다', async () => {
    const store = await recorded();
    expect((await gate(store, baseline({ promptVersion: 'extract-v0' }))).status).toBe('needs_rerecord');
    expect((await gate(store, baseline({ goldVersion: 2 }))).status).toBe('needs_rerecord');
    expect((await gate(store, baseline({ docs: 4 }))).status).toBe('needs_rerecord');
    expect((await gate(store, baseline(), [])).exitCode).toBe(1);
  });

  it('시험용 구현이 적은 줄은 녹화본으로 치지 않는다', async () => {
    const store = new MemoryCallStore();
    const req = buildExtractRequestV1(contentOf(1));
    await store.save({
      task: 'extract', provider: 'fake', model: MODEL, promptVersion: req.promptVersion,
      cacheKey: cacheKeyFor(req as LlmRequest<unknown>, MODEL), response: rightAnswer(contentOf(1)),
      stopReason: 'end_turn', inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, isRecorded: false,
    });
    const result = await gate(store, baseline({ docs: 1 }), docs.slice(0, 1));
    expect(result.status).toBe('needs_rerecord');
  });
});
