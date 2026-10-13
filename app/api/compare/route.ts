// 33. 비교. 등록된 상품을 같은 잣대로 나란히 놓는다.
// 읽기만 한다(모델을 부르지 않고 저장하지 않는다). 공간 헤더가 없으면 본보기 공간의 상품으로 견준다.
//   ?type=ad&subtype=전광판&region=합정   거르기   &sort=per_day_krw&order=asc   차례   &ids=5,7,10   2~4개를 나란히(모르는 번호면 404)
import { CompareQuerySchema } from '@/contract/tools/compare';
import { compareFor } from '@/server/compare';
import { json, readQuery, readWorkspace, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route('GET /compare', async (request: Request) => {
  const workspaceId = readWorkspace(request);
  const query = readQuery(request, CompareQuerySchema);
  return json(await compareFor(workspaceId, query));
});
