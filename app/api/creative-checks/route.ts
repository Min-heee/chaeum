// 26. 시안 검사. 광고 시안 파일이 그 지면(상품)의 규격 칸에 맞는지 본다. 읽기만 한다(모델을 부르지 않고, 파일도 결과도 저장하지 않는다).
//   · multipart/form-data: 글자 칸 "productId" + 파일 칸 "file" 하나  → 서버가 파일 머리를 읽는다(readBy: 'server'). 4MB까지.
//   · JSON { productId, facts, fileName? }                            → 부르는 쪽이 읽은 값만 보낸다(readBy: 'client'). 서버는 파일을 보지 못한다.
// 공간 헤더가 없으면 본보기 공간의 상품과 견준다. 남의 공간의 상품은 없는 번호로 답한다(404).
// 판단은 src/tools/creative 의 순수 함수가 한다. 여기서는 요청을 읽고 상품 한 줄을 읽어 넘긴다.
import { CREATIVE_LIMITS, CreativeCheckRequestSchema } from '@/contract/tools/creative';
import { getPool } from '@/server/db';
import { AppError } from '@/server/errors';
import { getProduct } from '@/server/repos/products';
import {
  CREATIVE_PROBLEM_CODES,
  CREATIVE_PROBLEM_MESSAGES,
  creativeCheckResponse,
  readUploadedCreative,
  type CreativeCheckInput,
  type CreativeProblem,
} from '@/tools/creative';
import { json, readBytes, readJson, readWorkspace, route } from '../_lib/http';

type Asked = CreativeCheckInput & { productId: number };

const refuse = (problem: CreativeProblem) => new AppError(CREATIVE_PROBLEM_CODES[problem], CREATIVE_PROBLEM_MESSAGES[problem]);

/** 올린 파일을 읽는다. 파일을 풀기 전에 본문 크기부터 본다. */
async function readUpload(request: Request, contentType: string): Promise<Asked> {
  const body = await readBytes(request, CREATIVE_LIMITS.requestMaxBytes);
  if (!body) throw refuse('too_large');
  let form: FormData;
  try {
    form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new AppError('BAD_INPUT', '올린 내용을 읽지 못했습니다.');
  }
  const productId = form.get(CREATIVE_LIMITS.productField);
  if (typeof productId !== 'string' || !/^[1-9][0-9]{0,14}$/.test(productId)) {
    throw new AppError('BAD_INPUT', `"${CREATIVE_LIMITS.productField}" 칸에 견줄 상품의 번호를 넣어 주세요.`);
  }
  const files = form.getAll(CREATIVE_LIMITS.formField);
  const file = files[0];
  if (files.length !== 1 || !(file instanceof File)) {
    throw new AppError('BAD_INPUT', `"${CREATIVE_LIMITS.formField}" 칸에 파일 하나를 넣어 주세요.`);
  }
  const read = readUploadedCreative(new Uint8Array(await file.arrayBuffer()));
  if (!read.ok) throw refuse(read.problem);
  return { productId: Number(productId), facts: read.facts, rotation: read.rotation, wholeSeconds: read.wholeSeconds, readBy: 'server', fileName: file.name };
}

export const POST = route('POST /creative-checks', async (request: Request) => {
  const workspaceId = readWorkspace(request);
  const contentType = request.headers.get('content-type') ?? '';
  const asked: Asked = /^multipart\/form-data\b/i.test(contentType)
    ? await readUpload(request, contentType)
    : { ...(await readJson(request, CreativeCheckRequestSchema)), readBy: 'client' };

  const product = await getProduct(getPool(), workspaceId, asked.productId);
  if (!product) throw new AppError('NOT_FOUND', '상품이 없습니다.');
  return json(creativeCheckResponse(product, asked));
});
