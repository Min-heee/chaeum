// 10. 상품 하나와 언어별 글. 남의 공간의 상품도 없는 번호로 답한다(404).
import { productDetail } from '@/server/service';
import { json, readId, readWorkspace, route, type IdParams } from '../../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route('GET /products/:id', async (request: Request, { params }: IdParams) => {
  const workspaceId = readWorkspace(request);
  return json(await productDetail(workspaceId, readId((await params).id, '상품')));
});
