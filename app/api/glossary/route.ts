// 20·21. 용어 목록(공용 줄 + 내 공간의 줄)과 용어 더하기(내 공간에, 기본은 제안 상태).
import { GlossaryCreateRequestSchema, GlossaryListQuerySchema } from '@/contract/tools/glossary';
import { createGlossaryTerm, listGlossary } from '@/server/glossary';
import { intakeWorkspace, json, readJson, readQuery, readWorkspace, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route('GET /glossary', async (request: Request) => {
  const workspaceId = readWorkspace(request);
  const { status } = readQuery(request, GlossaryListQuerySchema);
  return json(await listGlossary(workspaceId, { status }));
});

export const POST = route('POST /glossary', async (request: Request) => {
  // 헤더가 없으면 그때 새 공간을 만들어 응답의 workspace 에 돌려준다.
  const workspaceId = intakeWorkspace(request);
  const body = await readJson(request, GlossaryCreateRequestSchema);
  return json(await createGlossaryTerm(workspaceId, body, new Date()), 201);
});
