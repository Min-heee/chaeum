// 검수함.
import type { Metadata } from 'next';
import { Inbox } from '../../components/Inbox';

export const metadata: Metadata = { title: '검수함 · 채움' };

export default function InboxPage() {
  return <Inbox />;
}
