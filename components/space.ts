'use client';

// 도구 화면(견적·시안 검사·달력·비교·점검)이 어느 공간의 상품으로 일할지 정하는 한 곳.
import { useEffect, useState } from 'react';
import type { ProductListResponse } from '@/contract/api';
import { call, setPref, useMounted, usePref, useWorkspace } from './client';

/** mine: 내 작업 공간, public: 본보기 공간(읽기 전용). */
export type ToolSpace = 'mine' | 'public';

const PREF = 'toolSpace';

/** 사람이 공간을 골랐을 때 부른다. 이 탭에서 다른 도구로 옮겨도 그 공간이 먼저 열린다. */
export function setToolSpace(next: ToolSpace): void {
  setPref(PREF, next);
}

/**
 * 지금 살필 공간. 고른 적이 있으면 그것, 없으면 내 작업 공간에 상품이 있을 때 내 작업 공간, 아니면 본보기 공간이다.
 * 내 작업 공간이 아직 없으면 볼 수 있는 것은 본보기 공간뿐이다. 내 상품이 있는지 읽는 동안은 null 이다.
 */
export function useToolSpace(): ToolSpace | null {
  const mounted = useMounted();
  const workspace = useWorkspace();
  const picked = usePref(PREF);
  const [known, setKnown] = useState<{ workspace: string; has: boolean } | null>(null);
  const hasPick = picked === 'mine' || picked === 'public';

  useEffect(() => {
    if (!mounted || !workspace || hasPick) return undefined;
    let alive = true;
    call<ProductListResponse>('GET', '/api/products')
      .then((list) => {
        if (alive) setKnown({ workspace, has: list.items.length > 0 });
      })
      .catch(() => {
        // 읽지 못하면 본보기 공간을 먼저 연다(본보기는 늘 읽힌다).
        if (alive) setKnown({ workspace, has: false });
      });
    return () => {
      alive = false;
    };
  }, [mounted, workspace, hasPick]);

  if (!mounted) return null;
  if (!workspace) return 'public';
  if (picked === 'mine' || picked === 'public') return picked;
  if (!known || known.workspace !== workspace) return null;
  return known.has ? 'mine' : 'public';
}
