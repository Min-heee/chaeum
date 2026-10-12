// 녹화 재생. 장부에서 같은 키의 답을 찾아 준다. 네트워크를 쓰지 않는다.
import { LlmUnavailable, type LlmCallStore, type LlmProvider, type LlmRequest, type LlmResult } from '@/contract/llm-types';
import { checkAttachments } from './attachments';
import { cacheKeyFor } from './keys';

export function createReplayProvider(options: { model: string; store?: LlmCallStore }): LlmProvider {
  const { model, store } = options;
  return {
    name: 'replay',
    model,
    async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      const plain = req as LlmRequest<unknown>;
      checkAttachments(plain);
      // 파일이 붙은 요청은 파일의 해시가 키에 들어 있다. 같은 파일을 다시 올렸을 때만 녹화가 맞는다.
      const found = store ? await store.find(cacheKeyFor(plain, model)) : null;
      // 시험용 구현이 적은 줄은 녹화가 아니다. 가짜 답을 "녹화본"이라며 내주지 않는다.
      const record = found && found.provider !== 'fake' ? found : null;
      if (!record) throw new LlmUnavailable('CACHE_MISS', '이 요청의 녹화가 없다');
      // 녹화본도 믿지 않고 다시 검사한다.
      const parsed = req.schema.safeParse(record.response);
      if (!parsed.success) throw new LlmUnavailable('BAD_OUTPUT', '녹화된 답이 스키마와 다르다');
      return {
        output: parsed.data,
        stopReason: record.stopReason,
        usage: { inputTokens: record.inputTokens, outputTokens: record.outputTokens },
        latencyMs: record.latencyMs,
        recorded: true,
      };
    },
  };
}
