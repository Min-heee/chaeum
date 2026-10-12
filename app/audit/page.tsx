// 점검. 등록된 상품 전체(또는 양식 꼴 파일)를 한 번에 살피는 화면. 약속은 src/contract/tools/audit.ts 에 있다.
import type { Metadata } from 'next';
import { AuditTool } from './AuditTool';

export const metadata: Metadata = { title: '점검 · 채움' };

export default function AuditPage() {
  return <AuditTool />;
}
