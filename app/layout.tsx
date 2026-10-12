import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { TopBar } from '../components/TopBar';
import './globals.css';

export const metadata: Metadata = {
  title: '채움',
  description: '제각각인 상품 소개 글에서 등록 양식 칸을 채우고, 확인할 칸을 표시합니다.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <a className="skip" href="#main">
          본문으로 건너뛰기
        </a>
        <TopBar />
        <div id="main">{children}</div>
      </body>
    </html>
  );
}
