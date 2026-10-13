import type { NextConfig } from 'next';

/**
 * 모든 응답에 붙이는 보안 헤더.
 * - 다른 사이트가 이 화면을 틀(iframe)에 넣어 승인 버튼을 누르게 하지 못하게 한다(X-Frame-Options, frame-ancestors).
 * - 브라우저가 응답의 형식을 짐작해 바꾸지 않게 한다(nosniff). 내려받는 CSV 가 화면으로 읽히지 않는다.
 * - 다른 사이트로 나갈 때 온 주소를 알리지 않는다.
 */
export const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
] as const;

const nextConfig: NextConfig = {
  // 무엇으로 만들었는지 응답 헤더로 알리지 않는다.
  poweredByHeader: false,
  // 개발할 때 왼쪽 아래에 뜨는 표시를 끈다(옆 메뉴 아래의 글자를 가린다). 오류는 그대로 화면에 뜬다.
  devIndicators: false,
  // pg 는 서버에서만 쓴다. 묶지 않고 그대로 불러온다.
  serverExternalPackages: ['pg'],
  // 양식 맞춤 파일은 실행 중에 폴더에서 읽는다. 배포 묶음에 이 폴더를 함께 싣는다.
  outputFileTracingIncludes: {
    '/api/export.csv': ['./data/export-templates/*.json'],
    '/api/export.xlsx': ['./data/export-templates/*.json'],
    '/api/audits': ['./data/export-templates/*.json'],
    '/products': ['./data/export-templates/*.json'],
  },
  // collector/ 는 파이썬 수집기다. 배포 묶음에 싣지 않는다(가상 환경과 받아 둔 원자료가 딸려 가지 않게).
  outputFileTracingExcludes: { '*': ['./collector/**'] },
  async headers() {
    return [{ source: '/:path*', headers: [...SECURITY_HEADERS] }];
  },
};

export default nextConfig;
