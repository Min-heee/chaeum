// 보안 헤더: 모든 경로에 붙는지, 틀에 넣기를 막는지 본다(설정 파일을 그대로 읽는다).
import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

describe('보안 헤더', () => {
  it('모든 경로에 틀 넣기 막기·형식 짐작 막기·온 주소 숨기기가 붙고, 만든 도구 이름은 알리지 않는다', async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]?.source).toBe('/:path*');
    const headers = new Map(rules[0]?.headers.map((h) => [h.key.toLowerCase(), h.value]));
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
  });
});
