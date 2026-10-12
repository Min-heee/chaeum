// 3. 검수함. 주소 값: status, reason, type, cursor(모두 선택).
import { DraftListQuerySchema } from '@/contract/api';
import { draftList } from '@/server/service';
import { json, readQuery, readWorkspace, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route('GET /drafts', async (request: Request) => {
  const workspaceId = readWorkspace(request);
  return json(await draftList(workspaceId, readQuery(request, DraftListQuerySchema)));
});
