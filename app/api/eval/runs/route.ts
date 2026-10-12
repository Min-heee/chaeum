// 12. 평가 실행 목록. 새것부터. 공간과 상관없는 공용 읽기다(평가를 돌리는 것은 로컬 명령이다).
import { evalRunList } from '../../_lib/eval-read';
import { json, route } from '../../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route('GET /eval/runs', async () => json(await evalRunList()));
