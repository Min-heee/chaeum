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
  // pg 는 서버에서만 쓴다. 묶지 않고 그대로 불러온다.
  serverExternalPackages: ['pg'],
  // 양식 맞춤 파일은 실행 중에 폴더에서 읽는다. 배포 묶음에 이 폴더를 함께 싣는다.
  outputFileTracingIncludes: {
    '/api/export.csv': ['./data/export-templates/*.json'],
    '/products': ['./data/export-templates/*.json'],
  },
  async headers() {
    return [{ source: '/:path*', headers: [...SECURITY_HEADERS] }];
  },
};

export default nextConfig;
