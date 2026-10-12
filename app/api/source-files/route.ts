// 16. 그림·PDF 올리기(multipart/form-data, 파일 칸 이름 "file", 한 번에 하나).
// 요청 안에서 모델이 글로 옮기고 그 글이 1번과 같은 길로 접수된다. 파일은 저장하지 않는다.
import { UPLOAD_LIMITS } from '@/contract/pipeline-api';
import { AppError } from '@/server/errors';
import { intakeFile } from '@/server/service';
import { intakeWorkspace, json, readBytes, route } from '../_lib/http';

// 모델이 파일을 읽는 동안 기다린다.
export const maxDuration = 60;

/** 본문에서 파일 하나를 꺼낸다. 파일을 읽기 전에 본문 크기부터 본다. */
async function readFile(request: Request): Promise<File> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\b/i.test(contentType)) {
    throw new AppError('BAD_INPUT', `파일은 multipart/form-data 의 "${UPLOAD_LIMITS.formField}" 칸으로 올려 주세요.`);
  }
  const bytes = await readBytes(request, UPLOAD_LIMITS.requestMaxBytes);
  if (!bytes) throw new AppError('FILE_TOO_LARGE', '요청이 너무 큽니다. 파일은 3MB까지 올릴 수 있습니다.');

  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new AppError('BAD_INPUT', '올린 내용을 읽지 못했습니다.');
  }
  const files = form.getAll(UPLOAD_LIMITS.formField);
  if (files.length === 0) throw new AppError('BAD_INPUT', `"${UPLOAD_LIMITS.formField}" 칸에 파일이 없습니다.`);
  if (files.length > UPLOAD_LIMITS.filesPerRequest) throw new AppError('BAD_INPUT', '파일은 한 번에 하나만 올릴 수 있습니다.');
  const file = files[0];
  if (!(file instanceof File)) throw new AppError('BAD_INPUT', `"${UPLOAD_LIMITS.formField}" 칸에는 파일을 넣어 주세요.`);
  return file;
}

export const POST = route('POST /source-files', async (request: Request) => {
  const workspaceId = intakeWorkspace(request);
  const file = await readFile(request);
  const { body, created } = await intakeFile(
    { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name },
    { workspaceId, now: new Date() },
  );
  return json(body, created ? 201 : 200);
});
