// 27. 달력. 기념일(또는 날짜)에 맞추려면 지면마다 언제까지 무엇을 해야 하는지 거꾸로 센다.
// 읽기만 한다(모델을 부르지 않고 저장하지 않는다). 공간 헤더가 없으면 본보기 공간의 상품으로 센다.
//   ?date=2027-03-09 | ?anniversary=ann-04   (둘 다 주면 400, 둘 다 없으면 기념일 목록만)   &today=2026-10-12 (비우면 서버의 한국 날짜)
import { CalendarQuerySchema } from '@/contract/tools/calendar';
import { calendarFor } from '@/server/calendar';
import { json, readQuery, readWorkspace, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route('GET /calendar', async (request: Request) => {
  const workspaceId = readWorkspace(request);
  const query = readQuery(request, CalendarQuerySchema);
  return json(await calendarFor(workspaceId, query, new Date()));
});
