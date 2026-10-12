// 19. 점검. 등록된 상품 전체(JSON { "source": "workspace" }) 또는 양식 꼴 파일 하나(multipart, 칸 이름 "file")를 살핀다.
// 저장하지 않고 LLM 을 부르지 않는다. 주소 값 format=csv 를 주면 같은 결과를 CSV 로 내려준다.
import { AUDIT_LIMITS, AuditQuerySchema, AuditRequestSchema, type AuditResponse } from '@/contract/tools/audit';
import { auditCsv, auditFile, auditWorkspace } from '@/server/audit';
import { AppError } from '@/server/errors';
import { json, readBytes, readJson, readQuery, readWorkspace, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

/** multipart 본문의 상한. 파일 상한에 칸 이름과 경계 글자의 몫을 조금 더한다. */
const REQUEST_MAX_BYTES = AUDIT_LIMITS.fileMaxBytes + 16 * 1024;

async function readUpload(request: Request, contentType: string): Promise<{ file: File; template: string | undefined }> {
  const bytes = await readBytes(request, REQUEST_MAX_BYTES);
  if (!bytes) throw new AppError('FILE_TOO_LARGE', '파일이 너무 큽니다. 1MB까지 살필 수 있습니다.');
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new AppError('BAD_INPUT', '올린 내용을 읽지 못했습니다.');
  }
  const files = form.getAll(AUDIT_LIMITS.formField);
  const file = files[0];
  if (files.length !== 1 || !(file instanceof File)) {
    throw new AppError('BAD_INPUT', `"${AUDIT_LIMITS.formField}" 칸에 파일 하나를 넣어 주세요.`);
  }
  const template = form.get(AUDIT_LIMITS.templateField);
  return { file, template: typeof template === 'string' && template !== '' ? template : undefined };
}

export const POST = route('POST /audits', async (request: Request) => {
  const workspaceId = readWorkspace(request);
  const { format } = readQuery(request, AuditQuerySchema);
  const contentType = request.headers.get('content-type') ?? '';

  let result: AuditResponse;
  if (/^multipart\/form-data\b/i.test(contentType)) {
    const { file, template } = await readUpload(request, contentType);
    result = await auditFile({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name.slice(0, 200) || null, template }, workspaceId);
  } else {
    await readJson(request, AuditRequestSchema);
    result = await auditWorkspace(workspaceId);
  }

  if (format === 'json') return json(result);
  const csv = auditCsv(result);
  return new Response(csv.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csv.filename}"`,
      'Cache-Control': 'no-store',
    },
  });
});
