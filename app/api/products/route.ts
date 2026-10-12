// 9. 등록된 상품. 새것부터.
import { productList } from '@/server/service';
import { json, readWorkspace, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route('GET /products', async (request: Request) => {
  return json(await productList(readWorkspace(request)));
});
