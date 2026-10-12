// 30. 모은 줄 목록. 주소 값: sourceId, flag, drafted(yes|no), q, cursor(모두 선택). 헤더가 없으면 본보기 공간을 본다.
import { CollectedQuerySchema } from '@/contract/tools/collect';
import { listCollected } from '@/server/collected';
import { json, readQuery, readWorkspace, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route('GET /collected', async (request: Request) => {
  const workspaceId = readWorkspace(request);
  return json(await listCollected(workspaceId, readQuery(request, CollectedQuerySchema)));
});
