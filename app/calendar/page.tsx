// 달력. 기념일에 맞추려면 지면마다 언제까지 무엇을 해야 하는지 세는 화면. 약속은 src/contract/tools/calendar.ts 에 있다.
import type { Metadata } from 'next';
import { CalendarTool } from './CalendarTool';

export const metadata: Metadata = { title: '달력 · 채움' };

export default function CalendarPage() {
  return <CalendarTool />;
}
