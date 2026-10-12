// 실제 호출. 한 요청에 한 번만 부른다. 다시 할지는 작업 줄이 정한다.
import Anthropic from '@anthropic-ai/sdk';
import {
  LlmUnavailable,
  type LlmAttachment,
  type LlmCallStore,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
} from '@/contract/llm-types';
import { checkAttachments } from './attachments';
import { cacheKeyFor } from './keys';
import { costUsd } from './pricing';
import { jsonSchemaOf, LLM_EFFORT, wireFor } from './wire';

/** 한 번 부르는 데 기다리는 시간. 작업 줄이 작업을 붙잡아 두는 시간(60초)보다 짧아야 한다. */
export const LLM_TIMEOUT_MS = 40_000;
export { LLM_EFFORT } from './wire';

/** 이 파일이 SDK 에서 쓰는 부분만. 시험에서는 가짜를 끼운다. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/** SDK 클라이언트. SDK 가 스스로 다시 부르지 않게 한다(다시 하기는 작업 줄 한 곳에서만). */
export function newAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 0 });
}

/**
 * SDK 오류를 LlmUnavailable 로 바꾼다.
 * - 다시 해 볼 만한 것(연결 실패, 시간 초과, 408·409·429, 5xx): TRANSIENT
 * - 키가 거절됨(401·403): NO_KEY
 * - 그 밖의 4xx(요청이 틀림, 모델 이름 없음, 잔액 부족 등): 다시 해도 같으므로 BAD_REQUEST.
 * 오류 글에는 상태 번호와 종류만 담는다. 응답 본문은 담지 않는다.
 */
export function toLlmUnavailable(err: unknown): LlmUnavailable | null {
  if (err instanceof LlmUnavailable) return err;
  if (err instanceof Anthropic.APIConnectionError) return new LlmUnavailable('TRANSIENT', '연결 실패 또는 시간 초과');
  if (err instanceof Anthropic.APIError) {
    const status: number | undefined = err.status;
    const label = `HTTP ${status ?? '?'} ${err.type ?? ''}`.trim();
    if (status === undefined) return new LlmUnavailable('TRANSIENT', label);
    if (status === 408 || status === 409 || status === 429 || status >= 500) return new LlmUnavailable('TRANSIENT', label);
    if (status === 401 || status === 403) return new LlmUnavailable('NO_KEY', `키가 거절됐다 (${label})`);
    return new LlmUnavailable('BAD_REQUEST', `요청이 거절됐다 (${label})`);
  }
  return null;
}

/**
 * 붙은 파일 하나를 SDK 의 내용 토막으로 바꾼다. 그림은 image, PDF 는 document 다. 둘 다 base64 글로 싣는다.
 * - 그림: API 가 받는 형식은 JPEG·PNG·GIF·WebP 이고, 이 서비스는 그 가운데 셋만 받는다(약속의 ATTACHMENT_MEDIA_TYPES).
 *   큰 그림은 API 가 스스로 줄여서 본다(긴 변 2576px, 그림 하나에 4784토큰까지). 그래서 그림 하나의 입력 토큰에는 위쪽 한도가 있다.
 *   가장 작은 모델도 이 구간이다(2240x1680 그림 한 장을 보낸 호출의 입력이 6,867토큰이었다. 시스템 글 몫 약 2,000을 빼면 한도와 맞는다).
 *   한 변이 8000px 을 넘는 그림은 API 가 거절한다. 세로로 아주 긴 그림은 받더라도 줄어들어 글자가 뭉개진다.
 * - PDF: API 가 쪽마다 "쪽 그림 + 뽑아낸 글자"로 바꿔 모델에게 준다. 쪽수만큼 토큰이 는다. 암호가 걸린 PDF 는 받지 않는다(400).
 * - 인용(citations)은 켜지 않는다. 답의 꼴을 스키마로 묶는 것(output_config.format)과 함께 쓸 수 없다.
 * 한도의 출처: platform.claude.com/docs 의 vision, pdf-support 쪽(2026-10-12 확인).
 */
export function attachmentBlock(file: LlmAttachment): Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam {
  if (file.mediaType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.dataBase64 } };
  }
  return { type: 'image', source: { type: 'base64', media_type: file.mediaType, data: file.dataBase64 } };
}

/**
 * 사용자 메시지의 내용. 붙은 파일이 없으면 JSON 글 하나다(전과 같다).
 * 있으면 파일 토막을 앞에, JSON 글을 뒤에 둔다(파일이 글보다 앞에 올 때 모델이 더 잘 읽는다).
 */
export function userContent(req: Pick<LlmRequest<unknown>, 'input' | 'attachments'>): Anthropic.MessageParam['content'] {
  const text = JSON.stringify(req.input);
  if (!req.attachments || req.attachments.length === 0) return text;
  return [...req.attachments.map(attachmentBlock), { type: 'text', text }];
}

export function createAnthropicProvider(options: {
  model: string;
  apiKey?: string;
  store?: LlmCallStore;
  /** 시험용. 비우면 apiKey 로 SDK 클라이언트를 만든다. */
  client?: MessagesClient;
}): LlmProvider {
  const { model, apiKey, store } = options;
  let client = options.client;

  return {
    name: 'anthropic',
    model,
    async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      // 붙은 파일이 약속과 다르면 부르지 않는다. 키가 있든 없든 틀린 요청이다.
      checkAttachments(req as LlmRequest<unknown>);
      if (!client) {
        if (!apiKey) throw new LlmUnavailable('NO_KEY', 'API 키가 없다');
        client = newAnthropicClient(apiKey);
      }
      const plain = req as LlmRequest<unknown>;
      const wire = wireFor(plain);

      const started = performance.now();
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          // 입력은 JSON 글 하나로만 보낸다. 원문은 그 안의 값이다. 그림·PDF 가 붙으면 그 앞에 파일 토막이 온다.
          messages: [{ role: 'user', content: userContent(plain) }],
          // 온도 같은 표본 설정과 생각 설정은 보내지 않는다(새 모델은 기본값이 아니면 400 을 낸다).
          output_config: { effort: LLM_EFFORT, format: { type: 'json_schema', schema: jsonSchemaOf(wire.wire) } },
        });
      } catch (err) {
        const mapped = toLlmUnavailable(err);
        if (mapped) throw mapped;
        throw err;
      }
      const latencyMs = Math.round(performance.now() - started);

      // 답을 못 쓰게 돼도 토큰은 나갔다. 오류에 실어 보내 부르는 쪽이 비용을 셀 수 있게 한다.
      // 그림과 PDF 쪽의 토큰도 input_tokens 에 들어 있다.
      const usage = {
        inputTokens:
          message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0),
        outputTokens: message.usage.output_tokens,
      };

      // 멈춘 까닭부터 본다. 거절이나 잘린 답은 스키마와 맞지 않을 수 있다.
      const stopReason = message.stop_reason ?? 'unknown';
      if (stopReason === 'refusal') throw new LlmUnavailable('REFUSAL', '모델이 거절했다', usage);
      if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') {
        throw new LlmUnavailable('MAX_TOKENS', `답이 잘렸다 (${stopReason})`, usage);
      }

      // 답은 종류로 찾는다. 맨 앞에는 생각 토막이 올 수 있다.
      const text = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
      if (text === undefined) throw new LlmUnavailable('BAD_OUTPUT', '답에 글 토막이 없다', usage);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new LlmUnavailable('BAD_OUTPUT', '답이 JSON 이 아니다', usage);
      }
      const wired = wire.wire.safeParse(json);
      if (!wired.success) throw new LlmUnavailable('BAD_OUTPUT', '답이 요구한 꼴과 다르다', usage);
      const parsed = req.schema.safeParse(wire.toOutput(wired.data));
      if (!parsed.success) throw new LlmUnavailable('BAD_OUTPUT', '답이 스키마와 다르다', usage);

      await store?.save({
        task: req.task,
        provider: 'anthropic',
        model,
        promptVersion: req.promptVersion,
        cacheKey: cacheKeyFor(plain, model),
        response: parsed.data,
        stopReason,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: costUsd(model, usage),
        latencyMs,
        isRecorded: false,
      });
      return { output: parsed.data, stopReason, usage, latencyMs, recorded: false };
    },
  };
}
