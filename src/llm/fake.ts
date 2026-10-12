// 시험용. 정해 둔 답을 준다. 네트워크도 키도 쓰지 않는다.
import type { ContentDraft } from '@/contract/content';
import type { Extraction } from '@/contract/fields';
import { LlmUnavailable, type LlmCallStore, type LlmProvider, type LlmRequest, type LlmResult, type Transcription } from '@/contract/llm-types';
import { checkAttachments } from './attachments';
import { cacheKeyFor } from './keys';

/** 답을 따로 정하지 않았을 때의 기본 답. */
export function defaultFakeAnswer(req: LlmRequest<unknown>): unknown {
  if (req.task === 'extract') {
    const empty: Extraction = { type: 'not_product', subtype: null, fields: [] };
    return empty;
  }
  if (req.task === 'transcribe') {
    const transcription: Transcription = { text: '옮긴 글 보기: 합정역 커피차 100잔 80만원', readable: true };
    return transcription;
  }
  const name = (req.input as { name?: unknown } | null)?.name;
  const title = typeof name === 'string' && name ? name : 'Sample';
  const draft: ContentDraft = {
    en: { title, summary: `${title}, from {price}.` },
    'zh-Hans': { title, summary: `${title}，{price}起。` },
  };
  return draft;
}

export function createFakeProvider(options: {
  model: string;
  store?: LlmCallStore;
  fakeAnswer?: (req: LlmRequest<unknown>) => unknown;
}): LlmProvider {
  const { model, store } = options;
  const answer = options.fakeAnswer ?? defaultFakeAnswer;
  return {
    name: 'fake',
    model,
    async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      const plain = req as LlmRequest<unknown>;
      // 붙은 파일은 진짜 호출과 같은 검사를 거친다. 파일 내용은 읽지 않는다(답은 정해 둔 것이다).
      checkAttachments(plain);
      // 정해 둔 답도 진짜 답처럼 스키마로 검사한다.
      const parsed = req.schema.safeParse(answer(plain));
      if (!parsed.success) throw new LlmUnavailable('BAD_OUTPUT', '정해 둔 답이 스키마와 다르다');
      const result: LlmResult<T> = {
        output: parsed.data,
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
        latencyMs: 0,
        recorded: false,
      };
      // 장부를 넘겨받았으면 적어 둔다(provider = 'fake'). 녹화 재생은 이 줄을 녹화로 치지 않는다.
      await store?.save({
        task: req.task,
        provider: 'fake',
        model,
        promptVersion: req.promptVersion,
        cacheKey: cacheKeyFor(plain, model),
        response: result.output,
        stopReason: result.stopReason,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        isRecorded: false,
      });
      return result;
    },
  };
}
