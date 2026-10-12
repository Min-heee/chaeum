// 1) 글로 옮기기. 그림·PDF 를 모델에게 그대로 넘겨 보이는 글자를 받아 적게 한다.
// 올리기 요청 안에서 돈다. 던지지 않는다(잠깐의 오류도 한 번만 해 보고 'error' 로 돌려준다).
import { isLlmUnavailable } from '@/contract/llm-types';
import { afterLlmFailure, type TranscribeStep } from '@/contract/pipeline-api';
import { buildTranscribeRequest, cacheKeyFor } from '@/llm';
import { callInfo, isRules } from './call';

export const transcribe: TranscribeStep = async (input, router) => {
  const req = buildTranscribeRequest(input.attachment);
  // 글이 아니라 파일이 가므로 글 길이는 0 이다. 파일 크기는 올리기 검사가 이미 봤다.
  const pick = await router.pick({ task: 'transcribe', cacheKey: cacheKeyFor(req, router.model), textChars: 0, now: input.now });
  if (isRules(pick)) return { ok: false, problem: 'llm_skipped', cause: pick.cause };

  try {
    const result = await pick.provider.complete(req);
    const llm = callInfo(pick.route, pick.provider, req.promptVersion, result);
    const text = result.output.text.trim();
    if (!result.output.readable || text === '') return { ok: false, problem: 'unreadable', llm };
    return { ok: true, text, llm };
  } catch (err) {
    if (!isLlmUnavailable(err)) return { ok: false, problem: 'llm_skipped', cause: 'error' };
    // 요청 안이라 기다렸다 다시 할 수 없다. 마지막 시도인 것처럼 본다.
    const after = afterLlmFailure(err.code, 1, 1);
    return { ok: false, problem: 'llm_skipped', cause: after === 'retry' ? 'error' : after };
  }
};
