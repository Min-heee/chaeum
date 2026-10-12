// 5. 칸 고치기. 고친 뒤의 초안 상세를 돌려준다. 낡은 version 이면 409 와 지금 상태.
import { PatchFieldsRequestSchema } from '@/contract/api';
import { patchFields } from '@/server/service';
import { json, readId, readJson, readWorkspace, route, type IdParams } from '../../../_lib/http';

export const PATCH = route('PATCH /drafts/:id/fields', async (request: Request, { params }: IdParams) => {
  // 헤더가 없으면 본보기 공간으로 읽히고, 본보기 공간은 쓰기를 받지 않는다(403).
  const workspaceId = readWorkspace(request);
  const draftId = readId((await params).id, '초안');
  const body = await readJson(request, PatchFieldsRequestSchema);
  return json(
    await patchFields({
      workspaceId, draftId, version: body.version, edits: body.edits, type: body.type, subtype: body.subtype, actor: body.actor,
      now: new Date(),
    }),
  );
});
