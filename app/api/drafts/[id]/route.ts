// 4. 초안 상세. 남의 공간의 초안도 없는 번호로 답한다(404).
import { draftDetail } from '@/server/service';
import { json, readId, readWorkspace, route, type IdParams } from '../../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route('GET /drafts/:id', async (request: Request, { params }: IdParams) => {
  const workspaceId = readWorkspace(request);
  return json(await draftDetail(workspaceId, readId((await params).id, '초안')));
});
