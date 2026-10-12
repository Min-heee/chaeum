// 성적표.
import type { Metadata } from 'next';
import { Report } from '../../components/Report';

export const metadata: Metadata = { title: '성적표 · 채움' };

export default function ReportPage() {
  return <Report />;
}
