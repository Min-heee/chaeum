// 견적. 문의 글에서 조건을 뽑아 맞는 상품과 총액·마감을 내고 답장 초안을 쓰는 화면. 약속은 src/contract/tools/quote.ts 에 있다.
import type { Metadata } from 'next';
import { QuoteTool } from './QuoteTool';

export const metadata: Metadata = { title: '견적 · 채움' };

export default function QuotePage() {
  return <QuoteTool />;
}
