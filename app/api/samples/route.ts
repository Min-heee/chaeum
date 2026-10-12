// 18. 보기 글 목록. 첫 줄이 첫 화면에 미리 들어가는 글이다.
import { sampleList } from '@/server/service';
import { json, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route('GET /samples', async () => json(await sampleList()));
