// 31. 모은 줄 하나를 본체의 초안으로. 새 초안이면 201, 이 줄로 이미 만들었으면 200(duplicate). 요청 본문은 없다.
// 모델을 부르지 않는다. 남의 공간의 줄도 없는 번호로 답한다(404).
import { draftFromCollected } from '@/server/collected';
import { intakeWorkspace, json, readId, route, type IdParams } from '../../../_lib/http';

export const POST = route('POST /collected/:id/draft', async (request: Request, { params }: IdParams) => {
  const workspaceId = intakeWorkspace(request);
  const itemId = readId((await params).id, '모은 줄');
  const { body, created } = await draftFromCollected({ workspaceId, itemId, now: new Date() });
  return json(body, created ? 201 : 200);
});
