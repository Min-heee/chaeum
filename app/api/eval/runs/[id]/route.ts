// 13. 평가 실행 하나: 지표와 문서별 결과. against=<번호> 를 주면 그 실행과 견준 결과가 함께 온다.
import { EvalRunQuerySchema } from '@/contract/api';
import { evalRunDetail } from '../../../_lib/eval-read';
import { json, readId, readQuery, route, type IdParams } from '../../../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route('GET /eval/runs/:id', async (request: Request, { params }: IdParams) => {
  const runId = readId((await params).id, '평가 실행');
  const { against } = readQuery(request, EvalRunQuerySchema);
  return json(await evalRunDetail(runId, against));
});
