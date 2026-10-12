// 7. 반려. 사유 코드가 꼭 있다.
import { RejectRequestSchema } from '@/contract/api';
import { reject } from '@/server/service';
import { json, readId, readJson, readWorkspace, route, type IdParams } from '../../../_lib/http';

export const POST = route('POST /drafts/:id/reject', async (request: Request, { params }: IdParams) => {
  const workspaceId = readWorkspace(request);
  const draftId = readId((await params).id, '초안');
  const { version, reasonCode, memo, actor } = await readJson(request, RejectRequestSchema);
  return json(await reject({ workspaceId, draftId, version, reasonCode, memo, actor: actor ?? 'admin', now: new Date() }));
});
