// 파이프라인 시험이 함께 쓰는 것: 정해 둔 답, 길을 고르는 자리, 줄을 끝까지 굴리기.
import type { ContentApi, ContentGeneration, GeneratedText } from '@/contract/content';
import { LANGS, TEXT_FIELDS } from '@/contract/content';
import type { Extraction } from '@/contract/fields';
import type { LlmProvider, LlmRequest, LlmResult } from '@/contract/llm-types';
import type { LlmRouter } from '@/contract/pipeline-api';
import { getPool } from '@/server/db';
import { intakeOne } from '@/server/intake';
import { createJobHandlers, type JobHandlerDeps } from '@/server/job-handlers';
import { createLlmRouter, type LlmRouterConfig } from '@/server/llm-router';
import { drain, type DrainResult, type JobHandlers } from '@/server/queue';
import { getDraft, type Draft } from '@/server/repos/drafts';
import { at } from './helpers';

export const MODEL = 'claude-haiku-5-5';

let serial = 0;
/** 서로 다른 굿즈 글. 이름·값·크기가 원문에 그대로 있다. withSize 가 거짓이면 필수 칸(크기)이 빠진다. */
export function goodsText(withSize = true): { text: string; name: string } {
  serial += 1;
  const name = `별빛 응원 슬로건 ${serial}호`;
  return { name, text: `${name} 판매합니다.\n가격은 5,000원입니다.${withSize ? '\n크기는 200x600mm 입니다.' : ''}` };
}

/** 위 글을 모델이 뽑았다고 치는 답. 원문에 있는 것만 뽑는다. */
export function goodsExtraction(text: string): Extraction {
  const name = /별빛 응원 슬로건 \d+호/.exec(text)?.[0] ?? '별빛 응원 슬로건';
  const fields: Extraction['fields'] = [
    { field: 'name', raw: name, value: name, evidence: `${name} 판매합니다.` },
    { field: 'price_krw', raw: '5,000원', value: 5000, evidence: '가격은 5,000원입니다.' },
  ];
  if (text.includes('200x600mm')) {
    fields.push({ field: 'size_mm', raw: '200x600mm', value: { width: 200, height: 600 }, evidence: '크기는 200x600mm 입니다.' });
  }
  return { type: 'goods', subtype: '인쇄물', fields };
}

/** 시험용 구현의 답: 뽑기는 위 답, 글로 옮기기는 넘겨받은 글. */
export function fakeAnswer(transcribed = '옮긴 글'): (req: LlmRequest<unknown>) => unknown {
  return (req) => {
    if (req.task === 'extract') return goodsExtraction((req.input as { text: string }).text);
    if (req.task === 'transcribe') return { text: transcribed, readable: true };
    return { en: { title: 'T', summary: 'S {price}' }, 'zh-Hans': { title: 'T', summary: 'S {price}' } };
  };
}

export function fakeRouter(answer = fakeAnswer()): LlmRouter {
  return createLlmRouter({ providerKind: 'fake', dailyCap: 0, model: MODEL, fakeAnswer: answer });
}

export function router(config: Partial<LlmRouterConfig>): LlmRouter {
  return createLlmRouter({ providerKind: 'replay', dailyCap: 0, model: MODEL, ...config });
}

/** 네트워크 없이 실제 호출 길을 시험하는 공급자. 부른 횟수를 센다. fail 을 주면 그 오류를 던진다. */
export function liveStub(options: { fail?: () => Error | null } = {}): LlmProvider & { calls: number } {
  const stub = {
    name: 'anthropic' as const,
    model: MODEL,
    calls: 0,
    async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      stub.calls += 1;
      const err = options.fail?.();
      if (err) throw err;
      const output = req.schema.parse(fakeAnswer()(req as LlmRequest<unknown>));
      return { output, stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 200 }, latencyMs: 1234, recorded: false };
    },
  };
  return stub;
}

/** 손으로 돌리는 시계. */
export function clock(startMs = 0) {
  let ms = startMs;
  return { now: () => at(ms), add: (v: number) => (ms += v) };
}

export function handlersFor(deps: Partial<JobHandlerDeps> & { router: LlmRouter }, now: () => Date = () => at(0)): JobHandlers {
  return createJobHandlers({ now, ...deps });
}

/** 줄이 빌 때까지 굴린다. 다시 하기를 기다리지 않게 시계를 한 바퀴마다 1분씩 돌린다. */
export async function drainAll(handlers: JobHandlers, c = clock()): Promise<DrainResult> {
  const total: DrainResult = { done: 0, retried: 0, dead: 0, lost: 0, reclaimed: 0 };
  for (let round = 0; round < 20; round += 1) {
    const r = await drain({ handlers, now: c.now, maxJobs: 50, budgetMs: 60_000 });
    for (const key of Object.keys(total) as (keyof DrainResult)[]) total[key] += r[key];
    if (r.done + r.retried + r.dead + r.lost + r.reclaimed === 0) break;
    c.add(60_000);
  }
  return total;
}

/** 글을 접수하고 뽑기까지 끝낸 초안. */
export async function processed(workspaceId: string, text: string, handlers: JobHandlers): Promise<Draft> {
  const doc = await intakeOne(text, { workspaceId, now: at(0) });
  await drainAll(handlers);
  return (await getDraft(getPool(), workspaceId, doc.draftId)) as Draft;
}

/** 가짜 글 만들기. 부른 기록을 남긴다. */
export function fakeContent(): Pick<ContentApi, 'generateContent' | 'pickGlossary'> & { seen: { provider: string | null; skipCause: string | null }[] } {
  const seen: { provider: string | null; skipCause: string | null }[] = [];
  return {
    seen,
    pickGlossary: (glossary) => glossary.slice(0, 1),
    async generateContent(input, provider, skipCause): Promise<ContentGeneration> {
      seen.push({ provider: provider?.name ?? null, skipCause: skipCause ?? null });
      const texts: GeneratedText[] = LANGS.flatMap((lang) =>
        TEXT_FIELDS.map((field) => ({
          field,
          lang,
          text: `${input.content.name} ${input.values.price ?? ''}`.trim(),
          withPlaceholders: `${input.content.name} {price}`,
          source: provider ? ('llm' as const) : ('template' as const),
          status: provider ? ('ok' as const) : ('needs_review' as const),
          failCodes: [],
        })),
      );
      return { texts, calls: [], skipCause: provider ? null : (skipCause ?? null) };
    },
  };
}
