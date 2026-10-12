'use client';

// 맨 위 띠: 이 사이트가 무엇으로 도는지 한 줄, 화면 이동, 보는 사람 전환, 작업 공간 번호.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { HealthResponse } from '@/contract/api';
import { call, ROLE_LABELS, setRole, useRole, useWorkspace, type Role } from './client';

const TABS = [
  { href: '/', label: '작업 화면' },
  { href: '/inbox', label: '검수함' },
  { href: '/products', label: '상품' },
  { href: '/report', label: '성적표' },
  { href: '/api-guide', label: 'API' },
] as const;

function isCurrent(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  if (href === '/inbox') return pathname.startsWith('/inbox') || pathname.startsWith('/drafts');
  return pathname.startsWith(href);
}

/** 띠의 뒷부분. 서버가 실제 호출을 열어 두었는지에 따라 달라진다. 아직 모르면 어느 쪽이라고도 말하지 않는다. */
export function liveNotice(health: HealthResponse | null): string {
  if (!health) return '직접 넣은 글은 서버 설정에 따라 실제 호출 또는 규칙만';
  if (!health.llm.live) return '직접 넣은 글은 지금 규칙만(이 서버는 실제 호출이 닫혀 있습니다)';
  if (health.llm.liveLeftToday <= 0) return '직접 넣은 글은 지금 규칙만(오늘 실제 호출 상한이 찼습니다)';
  return `직접 넣은 글은 실제 호출(오늘 남은 ${health.llm.liveLeftToday}건)`;
}

export function TopBar() {
  const pathname = usePathname() ?? '/';
  const role = useRole();
  const workspace = useWorkspace();
  const [health, setHealth] = useState<HealthResponse | null>(null);

  // 화면을 옮길 때마다 다시 읽는다(남은 건수가 바뀐다). 못 읽으면 어느 쪽이라고도 말하지 않는다.
  useEffect(() => {
    let alive = true;
    call<HealthResponse>('GET', '/api/health')
      .then((h) => {
        if (alive) setHealth(h);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pathname]);

  return (
    <header className="top">
      <p className="notice">
        가상 마켓 · 합성 자료 · 보기 글의 AI 답은 미리 받아 둔 실제 응답, {liveNotice(health)}
      </p>
      <div className="bar">
        <Link href="/" className="brand">
          채움 <span className="brand-sub">응원장터 상품 등록</span>
        </Link>
        <nav aria-label="화면 이동" className="tabs">
          {TABS.map((tab) => (
            <Link key={tab.href} href={tab.href} className="tab" aria-current={isCurrent(pathname, tab.href) ? 'page' : undefined}>
              {tab.label}
            </Link>
          ))}
        </nav>
        <div className="who" role="group" aria-label="보는 사람 바꾸기">
          {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
            <button key={r} type="button" className="seg" aria-pressed={role === r} onClick={() => setRole(r)}>
              {ROLE_LABELS[r]}로 보기
            </button>
          ))}
        </div>
      </div>
      <p className="space">
        작업 공간:{' '}
        {workspace ? (
          <code title={workspace}>{workspace.slice(0, 8)}…</code>
        ) : (
          <span>아직 없음 — 글을 처음 넣을 때 생기고 이 브라우저에 저장됩니다</span>
        )}
        <span className="space-note"> · 로그인은 없습니다</span>
      </p>
    </header>
  );
}
