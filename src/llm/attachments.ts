// 요청에 붙은 파일(그림·PDF)을 부르기 전에 본다. 구현 셋(실제 호출 / 녹화 재생 / 시험용)이 같은 검사를 쓴다.
// 그래야 시험용 구현에서 통과한 요청이 실제 호출에서만 거절되는 일이 없다.
import { isMediaTypeOf, LlmUnavailable, type LlmRequest } from '@/contract/llm-types';

/** 한 요청에 붙이는 파일 수. 지금은 하나다. */
export const MAX_ATTACHMENTS = 1;

/** 줄바꿈 없는 표준 base64 글. API 는 줄바꿈이 섞인 것을 받지 않는다. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * 붙은 파일이 약속대로인지 본다. 아니면 부르지 않고 BAD_REQUEST 를 던진다(다시 해도 같다).
 * - 글로 옮기기에는 파일이 꼭 하나, 다른 일에는 파일이 없어야 한다.
 * - 종류와 형식이 맞아야 한다(그림인데 PDF 형식이면 안 된다).
 * - 내용은 비지 않은, 줄바꿈 없는 base64 글이어야 한다.
 * 파일 크기, 쪽수, 머리 바이트는 올리기 검사(checkUpload)가 본다. 여기서는 보지 않는다.
 * 오류 글에 파일 내용은 담지 않는다.
 */
export function checkAttachments(req: Pick<LlmRequest<unknown>, 'task' | 'attachments'>): void {
  const files = req.attachments ?? [];
  if (req.task !== 'transcribe') {
    if (files.length > 0) throw new LlmUnavailable('BAD_REQUEST', `${req.task} 요청에는 파일을 붙이지 않는다`);
    return;
  }
  if (files.length === 0) throw new LlmUnavailable('BAD_REQUEST', '글로 옮길 파일이 없다');
  if (files.length > MAX_ATTACHMENTS) throw new LlmUnavailable('BAD_REQUEST', `파일은 한 요청에 ${MAX_ATTACHMENTS}개까지다`);
  for (const file of files) {
    if (!isMediaTypeOf(file.kind, file.mediaType)) {
      throw new LlmUnavailable('BAD_REQUEST', `파일 종류(${file.kind})와 형식(${file.mediaType})이 맞지 않는다`);
    }
    if (file.dataBase64.length % 4 !== 0 || !BASE64.test(file.dataBase64)) {
      throw new LlmUnavailable('BAD_REQUEST', '파일 내용이 줄바꿈 없는 base64 글이 아니다');
    }
  }
}
