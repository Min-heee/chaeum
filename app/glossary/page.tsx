// 용어 사전. 번역 표기를 한곳에서 정하는 화면. 약속은 src/contract/tools/glossary.ts 에 있다.
import type { Metadata } from 'next';
import { GlossaryTool } from './GlossaryTool';

export const metadata: Metadata = { title: '용어 사전 · 채움' };

export default function GlossaryPage() {
  return <GlossaryTool />;
}
