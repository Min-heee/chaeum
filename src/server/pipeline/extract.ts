// 2) 뽑기 → 맞추기 → 따지기 → 갈래. DB 를 모른다(저장은 처리기가 한다).
// LLM 을 못 쓰면 규칙만 길로 내려가고 LLM_SKIPPED 와 그 원인을 남긴다. 이 길은 시연용이 아니라 실제 동작이다.
import type { DraftEvaluation } from '@/contract/core-api';
import { isLlmUnavailable } from '@/contract/llm-types';
import { afterLlmFailure, type ExtractInput, type ExtractOutcome, type ExtractStep } from '@/contract/pipeline-api';
import type { LlmSkipCause, ReasonCode } from '@/contract/reasons';
import { evaluateDraft, routeDraft, rulesExtract } from '@/core';
import { buildExtractRequest, cacheKeyFor } from '@/llm';
import { callInfo, chars, isRules } from './call';

/** 이 단계가 더하는 사유를 넣고 갈래를 다시 낸다. */
function withStepReasons(evaluation: DraftEvaluation, extra: ReasonCode[]): DraftEvaluation {
  const draftReasons = [...evaluation.draftReasons, ...extra.filter((code) => !evaluation.draftReasons.includes(code))];
  return { ...evaluation, draftReasons, route: routeDraft(evaluation.fields.map((f) => f.reasons), draftReasons) };
}

function byRules(input: ExtractInput, cause: LlmSkipCause): ExtractOutcome {
  const evaluation = evaluateDraft({ sourceText: input.sourceText, extraction: rulesExtract(input.sourceText), extractedBy: 'rules' });
  return {
    evaluation: withStepReasons(evaluation, ['LLM_SKIPPED', ...(input.transcribed ? (['TRANSCRIBED'] as const) : [])]),
    extractedBy: 'rules',
    skipCause: cause,
    llm: null,
  };
}

export const extract: ExtractStep = async (input, router) => {
  const req = buildExtractRequest(input.sourceText);
  const pick = await router.pick({ task: 'extract', cacheKey: cacheKeyFor(req, router.model), textChars: chars(input.sourceText), now: input.now });
  if (isRules(pick)) return byRules(input, pick.cause);

  let result;
  try {
    result = await pick.provider.complete(req);
  } catch (err) {
    if (!isLlmUnavailable(err)) throw err;
    const after = afterLlmFailure(err.code, input.attempt);
    // 잠깐의 오류이고 시도가 남았다. 그대로 던지면 작업 줄이 뒤로 미뤄 다시 한다.
    if (after === 'retry') throw err;
    return byRules(input, after);
  }

  const evaluation = evaluateDraft({ sourceText: input.sourceText, extraction: result.output, extractedBy: 'llm' });
  return {
    evaluation: input.transcribed ? withStepReasons(evaluation, ['TRANSCRIBED']) : evaluation,
    extractedBy: 'llm',
    skipCause: null,
    llm: callInfo(pick.route, pick.provider, req.promptVersion, result),
  };
};
