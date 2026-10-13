// 없는 주소로 왔을 때의 화면. 기본 영어 문구 대신 한국어 한 줄과 돌아갈 곳을 둔다.
import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, PageHead } from '../components/bits';

export const metadata: Metadata = { title: '없는 화면 · 채움' };

export default function NotFound() {
  return (
    <main className="page">
      <PageHead title="없는 화면입니다" lead="이 주소에는 화면이 없습니다." />
      <EmptyState
        title="주소를 잘못 적었거나, 다른 작업 공간의 것일 수 있습니다."
        action={
          <>
            <Link className="btn primary" href="/">
              작업 화면으로
            </Link>
            <Link className="btn" href="/inbox">
              검수함
            </Link>
            <Link className="btn" href="/products">
              상품
            </Link>
          </>
        }
      >
        작업 화면으로 가거나 메뉴에서 골라 주세요.
      </EmptyState>
    </main>
  );
}
