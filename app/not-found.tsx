// 없는 주소로 왔을 때의 화면. 기본 영어 문구 대신 한국어 한 줄과 돌아갈 곳을 둔다.
import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="page">
      <h1>없는 화면입니다</h1>
      <p>
        이 주소에는 화면이 없습니다. 주소를 잘못 적었거나, 다른 작업 공간의 것일 수 있습니다. <Link href="/">작업 화면</Link>으로 가거나 맨 위의 메뉴에서 골라
        주세요.
      </p>
    </main>
  );
}
