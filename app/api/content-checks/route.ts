// 17. 번역 검사. 이미 번역된 제목·요약을 넣으면 글 검사 5종의 결과를 돌려준다.
// 모델을 부르지 않고 DB 에 쓰지 않는다. 용어집은 용어 사전의 승인된 줄이다(공용 줄 + 요청 헤더의 공간의 줄).
import { ContentCheckRequestSchema } from '@/contract/content';
import { checkTranslations } from '@/content';
import { getPool } from '@/server/db';
import { approvedGlossary } from '@/server/repos/glossary-terms';
import { json, readJson, readWorkspace, route } from '../_lib/http';

export const POST = route('POST /content-checks', async (request: Request) => {
  const workspaceId = readWorkspace(request);
  const body = await readJson(request, ContentCheckRequestSchema);
  return json(checkTranslations(body, await approvedGlossary(getPool(), workspaceId)));
});
