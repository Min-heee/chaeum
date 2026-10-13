// 비교. 등록된 상품을 같은 잣대로 나란히 놓는 화면. 약속은 src/contract/tools/compare.ts 에 있다.
import type { Metadata } from 'next';
import { CompareTool } from './CompareTool';

export const metadata: Metadata = { title: '비교 · 채움' };

export default function ComparePage() {
  return <CompareTool />;
}
