// 6. 승인. 상품 한 줄과 글 작업 한 건이 생긴다. 등록할 수 없는 값이면 422(PRODUCT_INVALID)와 지금 상태.
import { DecisionRequestSchema } from '@/contract/api';
import { approve } from '@/server/service';
import { json, readId, readJson, readWorkspace, route, type IdParams } from '../../../_lib/http';

export const POST = route('POST /drafts/:id/approve', async (request: Request, { params }: IdParams) => {
  const workspaceId = readWorkspace(request);
  const draftId = readId((await params).id, '초안');
  const { version, actor } = await readJson(request, DecisionRequestSchema);
  return json(await approve({ workspaceId, draftId, version, actor: actor ?? 'admin', now: new Date() }));
});
