// 달력의 판단 코드(순수 함수)의 문. 약속은 src/contract/tools/calendar.ts 에 있다.
// 시계·난수·DB·네트워크를 쓰지 않는다(린트가 본다). 오늘 날짜는 인자로 받는다. 시험은 같은 폴더의 *.test.ts.
// 브라우저 코드(app/calendar)도 이 문을 가져다 쓴다. 서버 전용 모듈을 여기서 가져오지 않는다.
//
//   occurrence.ts  해마다 돌아오는 달·일 → 오늘 이후 처음 오는 날짜(2월 29일은 평년에 2월 28일)
//   plan.ts        기념일 날짜 + 오늘 + 상품의 마감 일수 → 지면별 마감일·남은 날·상태, 급한 순서
//   words.ts       날짜와 남은 날을 사람 말로
//   query.ts       화면에서 고른 값 → 경로에 보낼 주소 값
//
// 날짜 더하기·빼기와 마감 판정은 src/tools/shared/deadline.ts 것을 쓴다(견적과 같은 함수).
import type { CalendarApi } from '@/contract/tools/calendar';
import { nextOccurrence } from './occurrence';
import { planCalendar, planItem } from './plan';

export { isMonthDay, nextOccurrence, occurrenceIn, parseAnniversaries, TODAY_MAX, upcomingAnniversaries, type UpcomingAnniversary } from './occurrence';
export { CALENDAR_STATUS_LABELS, doableFirst, lastDayOfRun, planCalendar, planItem } from './plan';
export { calendarPath, calendarQuery, isCounting, isUsableToday, type CalendarBasis, type CalendarChoice } from './query';
export { dateText, daysLeftText, daysUntilText, monthDayText, weekdayOf } from './words';

// 내보낸 것이 약속과 같은 꼴인지 타입 검사가 본다.
const api: CalendarApi = { nextOccurrence, planItem, planCalendar };
export default api;
