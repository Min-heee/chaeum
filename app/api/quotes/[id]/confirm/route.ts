// 25. 답장 확정. 사람이 본(고친) 글을 표에 적는다. 보내기는 흉내만 낸다(어디로도 보내지 않는다).
import { QuoteConfirmRequestSchema } from '@/contract/tools/quote';
import { confirmQuote } from '@/server/quotes';
import { json, readId, readJson, readWorkspace, route, type IdParams } from '../../../_lib/http';

export const POST = route('POST /quotes/:id/confirm', async (request: Request, { params }: IdParams) => {
  const workspaceId = readWorkspace(request);
  const quoteId = readId((await params).id, '견적');
  const body = await readJson(request, QuoteConfirmRequestSchema);
  return json(await confirmQuote(workspaceId, quoteId, body, new Date()));
});
