// 22. 용어 고치기·승인·승인 풀기. 내 공간의 줄만 고친다. 공용 줄은 403.
import { GlossaryPatchRequestSchema } from '@/contract/tools/glossary';
import { patchGlossaryTerm } from '@/server/glossary';
import { json, readId, readJson, readWorkspace, route, type IdParams } from '../../_lib/http';

export const PATCH = route('PATCH /glossary/:id', async (request: Request, { params }: IdParams) => {
  const workspaceId = readWorkspace(request);
  const termId = readId((await params).id, '용어');
  const body = await readJson(request, GlossaryPatchRequestSchema);
  return json(await patchGlossaryTerm(workspaceId, termId, body, new Date()));
});
