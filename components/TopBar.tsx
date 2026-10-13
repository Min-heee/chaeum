'use client';

// 틀: 왼쪽 옆 메뉴(화면 이동 세 묶음, 보는 사람 전환, 작업 공간 번호)와 본문 위의 알림 띠.
// 1080px 보다 좁으면 옆 메뉴는 위쪽 한 줄 머리와 "메뉴" 버튼으로 접힌다. 파일과 내보내는 이름은 예전 그대로 TopBar 다.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type FocusEvent } from 'react';
import type { HealthResponse } from '@/contract/api';
import { TOOLS } from '@/contract/tools';
import { call, ROLE_LABELS, setRole, useRole, useWorkspace, type Role } from './client';

interface NavItem {
  href: string;
  label: string;
  /** 마우스를 올리면 보이는 한 줄 소개 */
  title?: string;
}

/** 옆 메뉴의 묶음 셋. 순서가 곧 메뉴의 순서다. */
const GROUPS: readonly { id: string; label: string; items: readonly NavItem[] }[] = [
  {
    id: 'register',
    label: '등록',
    items: [
      { href: '/', label: '작업 화면' },
      { href: '/inbox', label: '검수함' },
      { href: '/products', label: '상품' },
    ],
  },
  {
    id: 'check',
    label: '확인',
    items: [
      { href: '/report', label: '성적표' },
      { href: '/api-guide', label: 'API' },
    ],
  },
  { id: 'tools', label: '도구', items: TOOLS.map((tool) => ({ href: tool.href, label: tool.label, title: tool.blurb })) },
];

function isCurrent(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  // 초안 한 건(/drafts/…)은 검수함에서 연 것이다.
  if (href === '/inbox') return pathname.startsWith('/inbox') || pathname.startsWith('/drafts');
  return pathname === href || pathname.startsWith(`${href}/`);
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
  // 좁은 화면에서만 뜻이 있다(넓은 화면에서는 메뉴가 늘 펴져 있다).
  const [open, setOpen] = useState(false);
  const [seenPath, setSeenPath] = useState(pathname);
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  // 화면을 옮기면 접힌 메뉴를 닫는다(뒤로 가기로 옮겨도 닫힌다).
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
  }

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

  // 펴져 있을 때 Esc 를 누르면 닫고, 초점을 "메뉴" 버튼으로 돌려 준다.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // 키보드 초점이 메뉴 밖(본문)으로 나가면 닫는다. 펴진 메뉴가 초점을 가리지 않게.
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    if (open && e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) setOpen(false);
  };

  return (
    <>
      <header className="side" data-open={open} data-static={pathname.startsWith('/label') ? 'true' : undefined} onBlur={onBlur}>
        <div className="side-head">
          <Link href="/" className="brand" onClick={() => setOpen(false)}>
            채움 <span className="brand-sub">응원장터 상품 등록</span>
          </Link>
          <button
            ref={toggleRef}
            type="button"
            className="btn small side-toggle"
            aria-expanded={open}
            aria-controls="side-menu"
            onClick={() => setOpen((was) => !was)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              {open ? <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /> : <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />}
            </svg>
            메뉴
          </button>
        </div>
        <div className="side-body" id="side-menu">
          <nav aria-label="화면 이동" className="side-nav">
            {GROUPS.map((group) => (
              <div className="side-group" key={group.id}>
                <p className="side-label" id={`side-${group.id}`}>
                  {group.label}
                </p>
                <ul className="side-list" aria-labelledby={`side-${group.id}`}>
                  {group.items.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className="side-link"
                        title={item.title}
                        aria-current={isCurrent(pathname, item.href) ? 'page' : undefined}
                        onClick={() => setOpen(false)}
                      >
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <div className="side-foot">
            <div className="who" role="group" aria-label="보는 사람 바꾸기">
              {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                <button key={r} type="button" className="seg" aria-pressed={role === r} onClick={() => setRole(r)}>
                  {ROLE_LABELS[r]}로 보기
                </button>
              ))}
            </div>
            <p className="space">
              작업 공간:{' '}
              {workspace ? (
                <code title={workspace}>{workspace.slice(0, 8)}…</code>
              ) : (
                <span>아직 없음 — 글을 처음 넣을 때 생기고 이 브라우저에 저장됩니다</span>
              )}
              <span className="space-note">로그인은 없습니다</span>
            </p>
          </div>
        </div>
        {/* 좁은 화면에서 펴진 메뉴 바깥을 누르면 닫힌다. 키보드로는 Esc 나 "메뉴" 버튼으로 닫는다. */}
        <div className="side-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
      </header>
      <aside className="notice" aria-label="이 사이트 안내">
        <span className="badge">데모</span>
        <p>
          가상 마켓 · 합성 자료(모으기의 공공 자료 30줄만 실제 자료) · 보기 글의 AI 답은 미리 받아 둔 실제 응답, {liveNotice(health)}
        </p>
      </aside>
    </>
  );
}
