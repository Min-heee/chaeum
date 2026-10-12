// 모으기. 로컬의 수집기가 정리해 보낸 줄(묶음·줄 목록)을 보고, 고른 줄을 초안으로 보낸다.
// 약속은 src/contract/tools/collect.ts, 수집기와의 꼴은 docs/IMPORT-FORMAT.md 에 있다.
import type { Metadata } from 'next';
import { Collect } from './Collect';

export const metadata: Metadata = { title: '모으기 · 채움' };

export default function CollectPage() {
  return <Collect />;
}
