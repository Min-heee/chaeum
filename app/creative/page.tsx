// 시안 검사. 광고 시안 파일이 지면 규격에 맞는지 보는 화면. 약속은 src/contract/tools/creative.ts 에 있다.
import type { Metadata } from 'next';
import { CreativeTool } from './CreativeTool';

export const metadata: Metadata = { title: '시안 검사 · 채움' };

export default function CreativePage() {
  return <CreativeTool />;
}
