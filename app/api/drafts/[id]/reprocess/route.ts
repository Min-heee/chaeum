// 8. 다시 돌리기(실패·반려 → 처리 중). 뽑기 작업이 줄에 다시 선다.
import { DecisionRequestSchema } from '@/contract/api';
import { reprocess } from '@/server/service';
import { json, readId, readJson, readWorkspace, route, type IdParams } from '../../../_lib/http';

export const POST = route('POST /drafts/:id/reprocess', async (request: Request, { params }: IdParams) => {
  const workspaceId = readWorkspace(request);
  const draftId = readId((await params).id, '초안');
  const { version, actor } = await readJson(request, DecisionRequestSchema);
  return json(await reprocess({ workspaceId, draftId, version, actor: actor ?? 'admin', now: new Date() }));
});
