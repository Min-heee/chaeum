// 14. 줄 굴리기. 요청 본문은 없다. 시간 예산 6초·최대 5건 안에서 굴리고, 남은 일 수를 돌려준다.
import { drainJobs } from '@/server/service';
import { json, route } from '../../_lib/http';

// 예산은 6초지만 집어 든 마지막 일이 모델을 기다릴 수 있다(글 검사에 걸려 다시 부르면 80초까지).
export const maxDuration = 120;

export const POST = route('POST /jobs/drain', async () => json(await drainJobs(() => new Date())));
