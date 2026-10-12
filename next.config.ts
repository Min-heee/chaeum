import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // pg 는 서버에서만 쓴다. 묶지 않고 그대로 불러온다.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
