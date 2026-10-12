// 1. 글 한 건 접수. 새 글이면 201, 같은 글이면 200(duplicate).
// 공간 헤더가 없으면 이때 새 공간이 생기고 응답의 workspace 에 실린다.
import { IntakeRequestSchema } from '@/contract/api';
import { intakeText } from '@/server/service';
import { intakeWorkspace, json, readJson, route } from '../_lib/http';

export const POST = route('POST /source-docs', async (request: Request) => {
  const workspaceId = intakeWorkspace(request);
  const { text } = await readJson(request, IntakeRequestSchema);
  const { body, created } = await intakeText(text, { workspaceId, now: new Date() });
  return json(body, created ? 201 : 200);
});
