import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: '채움',
  description: '제각각인 상품 소개 글에서 등록 양식 칸을 채우고, 확인할 칸을 표시합니다.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <p className="notice">가상 마켓 · 합성 자료 · 이 사이트의 AI 답은 미리 받아 둔 실제 응답</p>
        {children}
      </body>
    </html>
  );
}
