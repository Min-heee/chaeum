// 28·29. 모으기: 수집기가 정리해 보낸 줄 묶음을 받고(POST, 202), 받은 묶음 목록과 합계를 준다(GET).
// 꼴은 docs/IMPORT-FORMAT.md 에 있다. 공간 헤더 없이 보내면 이때 새 공간이 생기고 응답의 workspace 에 실린다.
import { COLLECT_LIMITS, ImportRequestSchema } from '@/contract/tools/collect';
import { AppError } from '@/server/errors';
import { listImports, receiveImport } from '@/server/imports';
import { intakeWorkspace, json, readBytes, readWorkspace, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

export const POST = route('POST /imports', async (request: Request) => {
  const workspaceId = intakeWorkspace(request);
  // 한 번에 500줄이라 본문 상한이 다른 경로(1MB)보다 크다.
  const bytes = await readBytes(request, COLLECT_LIMITS.requestMaxBytes);
  if (!bytes) throw new AppError('FILE_TOO_LARGE', '요청 본문이 너무 큽니다. 줄을 나눠 보내 주세요.');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AppError('BAD_INPUT', '요청 본문이 JSON 이 아닙니다.');
  }
  return json(await receiveImport(ImportRequestSchema.parse(raw), { workspaceId, now: new Date() }), 202);
});

export const GET = route('GET /imports', async (request: Request) => {
  return json(await listImports(readWorkspace(request)));
});
