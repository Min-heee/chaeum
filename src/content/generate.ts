// 글 만들기: 모델을 한 번 부르고(두 언어 함께), 글 4줄을 검사하고, 걸리면 한 번만 다시 부른다.
// 그래도 걸린 줄은 틀 문장으로 바꾼다. 숫자는 맨 끝에 코드가 넣는다.
import type { ContentApi, ContentCall, ContentDraft, ContentInput, GeneratedText } from '@/contract/content';
import { isLlmUnavailable, type LlmProvider } from '@/contract/llm-types';
import { afterLlmFailure } from '@/contract/pipeline-api';
import type { ContentFailCode, LlmSkipCause } from '@/contract/reasons';
import { buildContentRequest } from '@/llm';
import { fillPlaceholders } from './format';
import { checkLine, lineRules, retryHintOf, type LineRule } from './line-check';
import { templateTexts } from './template';

/** 모델이 쓴 글 한 줄과 그 줄이 걸린 코드. */
interface JudgedLine {
  text: string;
  failCodes: ContentFailCode[];
}

type Answer = { ok: true; draft: ContentDraft } | { ok: false; cause: LlmSkipCause };

/**
 * 모델을 한 번 부른다.
 * 잠깐의 오류(retryable)는 그대로 던진다. 작업 줄이 다시 한다.
 * 그 밖의 실패(녹화 없음, 키 없음, 거절, 잘린 답, 형식 오류)는 던지지 않고 까닭을 돌려준다.
 */
async function ask(
  provider: LlmProvider,
  content: ContentInput,
  retryHint: string | undefined,
  attempt: ContentCall['attempt'],
  calls: ContentCall[],
): Promise<Answer> {
  try {
    const result = await provider.complete(buildContentRequest(content, retryHint));
    calls.push({ attempt, recorded: result.recorded, latencyMs: result.latencyMs, usage: result.usage });
    return { ok: true, draft: result.output };
  } catch (err) {
    if (!isLlmUnavailable(err) || err.retryable) throw err;
    // 답은 못 썼어도 토큰이 나간 호출이면 기록에 남긴다(비용을 세야 한다). 걸린 시간은 알 수 없어 0 이다.
    if (err.usage) calls.push({ attempt, recorded: false, latencyMs: 0, usage: err.usage });
    const after = afterLlmFailure(err.code, 1);
    return { ok: false, cause: after === 'retry' ? 'error' : after };
  }
}

function judge(rules: readonly LineRule[], draft: ContentDraft): JudgedLine[] {
  return rules.map((rule) => {
    const text = draft[rule.lang][rule.field].trim();
    return { text, failCodes: checkLine(rule, text) };
  });
}

const passed = (line: JudgedLine): boolean => line.failCodes.length === 0;

/**
 * 약속(ContentApi.generateContent)의 순서대로 돈다.
 *
 * 줄마다 "통과한 가장 최근 글"을 쓴다:
 *  - 다시 받은 답에서 통과했으면 그 글.
 *  - 다시 받은 답에서는 걸렸지만 첫 답에서 통과했던 줄이면 첫 답의 글.
 *  - 두 번 다 걸린 줄만 틀 문장. failCodes 에는 모델의 마지막 글이 걸린 코드를 남긴다.
 * 다시 부르다 실패하면(녹화 없음 등) 첫 답에서 통과한 줄은 살리고 걸린 줄만 틀 문장으로 바꾼다.
 */
export const generateContent: ContentApi['generateContent'] = async (input, provider, skipCause) => {
  const fallback = templateTexts(input);
  // 부르는 쪽이 모델을 쓰지 않기로 했다. 까닭을 안 줬으면 "꺼져 있음"으로 적는다.
  if (!provider) return { texts: fallback, calls: [], skipCause: skipCause ?? 'off' };

  const rules = lineRules(input);
  const calls: ContentCall[] = [];

  const first = await ask(provider, input.content, undefined, 1, calls);
  if (!first.ok) return { texts: fallback, calls, skipCause: first.cause };

  const firstLines = judge(rules, first.draft);
  let lastLines = firstLines;
  if (!firstLines.every(passed)) {
    const hint = retryHintOf(rules, firstLines.map((l) => l.failCodes));
    const second = await ask(provider, input.content, hint, 2, calls);
    if (second.ok) lastLines = judge(rules, second.draft);
  }

  const texts = rules.map((rule, i): GeneratedText => {
    const last = lastLines[i]!;
    const before = firstLines[i]!;
    const good = passed(last) ? last : passed(before) ? before : null;
    if (!good) return { ...fallback[i]!, failCodes: last.failCodes };
    return {
      field: rule.field,
      lang: rule.lang,
      text: fillPlaceholders(good.text, rule.values, rule.lang),
      source: 'llm',
      status: 'ok',
      failCodes: [],
      withPlaceholders: good.text,
    };
  });
  return { texts, calls, skipCause: null };
};
