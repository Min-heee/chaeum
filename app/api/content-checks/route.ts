// 17. 번역 검사. 이미 번역된 제목·요약을 넣으면 글 검사 5종의 결과를 돌려준다.
// 모델을 부르지 않고 DB 에 쓰지 않는다. 용어집은 저장소의 씨앗 파일이다.
import { ContentCheckRequestSchema } from '@/contract/content';
import { checkTranslations } from '@/content';
import { seedGlossary } from '@/server/job-handlers';
import { json, readJson, route } from '../_lib/http';

export const POST = route('POST /content-checks', async (request: Request) => {
  const body = await readJson(request, ContentCheckRequestSchema);
  return json(checkTranslations(body, seedGlossary()));
});
