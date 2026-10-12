// 글로 옮기기 단계: 읽지 못한 파일, 빈 글, 모델을 못 부른 까닭, 녹화본과 실제 호출의 구분. 공급자는 정해 둔 답을 내주는 가짜다.
import { describe, expect, it } from 'vitest';
import type { LlmAttachment } from '@/contract/attachments';
import { LlmUnavailable, type LlmProvider, type LlmRequest, type LlmResult, type LlmUnavailableCode } from '@/contract/llm-types';
import type { LlmPick, LlmRoute, LlmRouter } from '@/contract/pipeline-api';
import type { LlmSkipCause } from '@/contract/reasons';
import { transcribe } from '@/server/pipeline/transcribe';

const NOW = new Date('2001-06-01T03:00:00Z');
const MODEL = 'claude-haiku-5-5';
const PNG: LlmAttachment = { kind: 'image', mediaType: 'image/png', dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') };

/** 정해 둔 답(또는 오류)을 내주는 공급자와, 그것을 정해 둔 길로 내주는 길 고르기. */
function routed(route: Exclude<LlmRoute, 'rules'>, answer: { text: string; readable: boolean } | Error, recorded = false): LlmRouter {
  const provider: LlmProvider = {
    name: route,
    model: MODEL,
    async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      if (answer instanceof Error) throw answer;
      return { output: req.schema.parse(answer), stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 200 }, latencyMs: 777, recorded };
    },
  };
  return { model: MODEL, pick: async (): Promise<LlmPick> => ({ route, provider }) };
}

describe('글로 옮기기 단계', () => {
  it('옮긴 글의 앞뒤 공백을 떼어 돌려준다', async () => {
    const out = await transcribe({ attachment: PNG, now: NOW }, routed('fake', { text: '  단가표\n1주 150만원 \n', readable: true }));
    expect(out).toMatchObject({ ok: true, text: '단가표\n1주 150만원' });
  });

  it('모델이 읽지 못했다고 하면, 글이 딸려 와도 읽지 못한 파일이다', async () => {
    const out = await transcribe({ attachment: PNG, now: NOW }, routed('fake', { text: '흐릿한 글자 몇 개', readable: false }));
    expect(out).toMatchObject({ ok: false, problem: 'unreadable' });
  });

  it('읽었다고 했는데 글이 비었으면(공백뿐이어도) 읽지 못한 파일이다', async () => {
    const out = await transcribe({ attachment: PNG, now: NOW }, routed('fake', { text: ' \n ', readable: true }));
    expect(out).toMatchObject({ ok: false, problem: 'unreadable' });
  });

  it('길이 막혔으면 부르지 않고 그 까닭을 돌려준다', async () => {
    const closed: LlmRouter = { model: MODEL, pick: async () => ({ route: 'rules', provider: null, cause: 'daily_cap' }) };
    expect(await transcribe({ attachment: PNG, now: NOW }, closed)).toEqual({ ok: false, problem: 'llm_skipped', cause: 'daily_cap' });
  });

  const failures: [LlmUnavailableCode, LlmSkipCause][] = [
    ['TRANSIENT', 'error'],
    ['NO_KEY', 'no_key'],
    ['CACHE_MISS', 'cache_miss'],
    ['REFUSAL', 'refusal'],
    ['MAX_TOKENS', 'error'],
    ['BAD_OUTPUT', 'error'],
  ];
  it.each(failures)('공급자 오류 %s → 던지지 않고 까닭 %s', async (code, cause) => {
    const out = await transcribe({ attachment: PNG, now: NOW }, routed('anthropic', new LlmUnavailable(code)));
    expect(out).toEqual({ ok: false, problem: 'llm_skipped', cause });
  });

  it('공급자 오류가 아닌 고장도 던지지 않는다', async () => {
    const out = await transcribe({ attachment: PNG, now: NOW }, routed('anthropic', new Error('뜻밖의 고장')));
    expect(out).toEqual({ ok: false, problem: 'llm_skipped', cause: 'error' });
  });

  it('녹화본·실제 호출·시험용 구현을 가른다', async () => {
    const answer = { text: '단가표', readable: true };
    const recorded = await transcribe({ attachment: PNG, now: NOW }, routed('replay', answer, true));
    const live = await transcribe({ attachment: PNG, now: NOW }, routed('anthropic', answer));
    const fake = await transcribe({ attachment: PNG, now: NOW }, routed('fake', answer));
    expect(recorded).toMatchObject({ ok: true, llm: { recorded: true, live: false, latencyMs: 777 } });
    expect(live).toMatchObject({ ok: true, llm: { recorded: false, live: true } });
    expect(fake).toMatchObject({ ok: true, llm: { recorded: false, live: false } });
    // 실제 길로 갔어도 장부에서 꺼낸 답이면 녹화본이다.
    const cached = await transcribe({ attachment: PNG, now: NOW }, routed('anthropic', answer, true));
    expect(cached).toMatchObject({ ok: true, llm: { recorded: true, live: false } });
  });
});
