// 23. 문의 글 → 견적. 조건 뽑기(모델) → 고르기·총액·마감(코드) → 답장 초안(모델) → 글 검사(코드) → 저장.
// 조건 뽑기 모델을 못 부르면 접수하지 않는다(503, 오늘 상한이 찼으면 429. 본문의 skipCause 에 까닭).
import { QuoteCreateRequestSchema } from '@/contract/tools/quote';
import { createQuote } from '@/server/quotes';
import { intakeWorkspace, json, readJson, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

export const POST = route('POST /quotes', async (request: Request) => {
  // 헤더가 없으면 저장할 때 새 공간을 만들어 응답의 workspace 에 돌려준다.
  const workspaceId = intakeWorkspace(request);
  const body = await readJson(request, QuoteCreateRequestSchema);
  return json(await createQuote(workspaceId, body, new Date()), 201);
});
