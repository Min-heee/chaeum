// 24. 저장된 견적 한 건. 다른 공간의 견적이면 404.
import { getQuote } from '@/server/quotes';
import { json, readId, readWorkspace, route, type IdParams } from '../../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route('GET /quotes/:id', async (request: Request, { params }: IdParams) => {
  const workspaceId = readWorkspace(request);
  const quoteId = readId((await params).id, '견적');
  return json(await getQuote(workspaceId, quoteId));
});
