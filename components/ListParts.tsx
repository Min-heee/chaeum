'use client';

// 검수함과 상품 목록이 함께 쓰는 조각: 공간 탭, 눌러서 거르는 요약 숫자, 줄 전체가 눌리는 표의 줄.
// 꼴은 전역(.tabs .tab .stats .stat .table-wrap)을 그대로 쓰고, 모자란 것만 ListParts.module.css 에 둔다.
import { useRouter } from 'next/navigation';
import { useCallback, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import styles from './ListParts.module.css';

/** 내 작업 공간(고치고 승인할 수 있다)과 본보기 공간(읽기 전용). */
export type SpaceKey = 'mine' | 'demo';

export const SPACE_LABELS: Record<SpaceKey, string> = { mine: '내 작업 공간', demo: '본보기 공간 (읽기 전용)' };

const SPACE_KEYS: readonly SpaceKey[] = ['mine', 'demo'];

export const spaceTabId = (prefix: string, key: SpaceKey) => `${prefix}-tab-${key}`;
export const spacePanelId = (prefix: string, key: SpaceKey) => `${prefix}-panel-${key}`;

/**
 * 공간 탭. 화살표 키로 옮겨 다닌다(탭 하나만 Tab 차례에 든다).
 * counts 는 탭 이름 옆의 작은 글씨다(아직 모르면 비워 둔다).
 */
export function SpaceTabs({
  prefix,
  value,
  onChange,
  counts,
}: {
  prefix: string;
  /** 고른 공간. 아직 어느 쪽을 보여 줄지 모르면 null(어느 탭도 고른 표시를 하지 않는다). */
  value: SpaceKey | null;
  onChange: (key: SpaceKey) => void;
  counts?: Partial<Record<SpaceKey, ReactNode>>;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const at = SPACE_KEYS.indexOf(value ?? 'mine');
    const next = event.key === 'Home' ? 'mine' : event.key === 'End' ? 'demo' : step !== 0 ? SPACE_KEYS[(at + step + SPACE_KEYS.length) % SPACE_KEYS.length] : null;
    if (!next) return;
    event.preventDefault();
    onChange(next);
    document.getElementById(spaceTabId(prefix, next))?.focus();
  };
  return (
    <div className={`tabs ${styles.spaceTabs}`} role="tablist" aria-label="공간 고르기" onKeyDown={onKeyDown}>
      {SPACE_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          id={spaceTabId(prefix, key)}
          className="tab"
          aria-selected={value === key}
          aria-controls={spacePanelId(prefix, key)}
          tabIndex={(value ?? 'mine') === key ? 0 : -1}
          onClick={() => onChange(key)}
        >
          {SPACE_LABELS[key]}
          {counts?.[key] !== undefined && counts[key] !== null ? <span className={`count ${styles.tabCount}`}> {counts[key]}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** 탭 하나의 내용. 고르지 않은 쪽은 숨긴다(안의 상태는 그대로 남는다). */
export function SpacePanel({ prefix, space, active, children }: { prefix: string; space: SpaceKey; active: boolean; children: ReactNode }) {
  return (
    <section role="tabpanel" id={spacePanelId(prefix, space)} aria-labelledby={spaceTabId(prefix, space)} hidden={!active}>
      <h2 className="sr-only">{SPACE_LABELS[space]}</h2>
      {children}
    </section>
  );
}

export interface StatOption<K extends string> {
  key: K;
  label: string;
  /** 숫자(단위까지 글자로. 예: "5건") */
  value: string;
  tone?: 'ok' | 'warn' | 'danger';
  disabled?: boolean;
}

/**
 * 요약 숫자이면서 거르는 버튼. 누른 칸의 것만 아래 표에 나온다.
 * 꼴은 Stats 와 같고, 고른 칸에 파란 밑줄이 붙는다.
 */
export function StatFilter<K extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly StatOption<K>[];
  value: K;
  onChange: (key: K) => void;
}) {
  return (
    <div className={`stats ${styles.statFilter}`} role="group" aria-label={label} data-count={options.length}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          className={`stat${option.tone ? ` stat-${option.tone}` : ''} ${styles.statBtn}`}
          aria-pressed={option.key === value}
          disabled={option.disabled}
          onClick={() => onChange(option.key)}
        >
          <span className="stat-label">{option.label}</span> <span className="stat-value">{option.value}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * 표의 줄 전체를 누르면 그 건으로 간다. 줄 안의 링크·버튼을 눌렀거나 글자를 긁는 중이면 가만히 둔다.
 * 키보드와 화면 읽기 도구는 이름 칸의 링크로 간다.
 */
export function useRowOpen(): (href: string) => (event: MouseEvent<HTMLTableRowElement>) => void {
  const router = useRouter();
  return (href) => (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('a, button, input, select, textarea, label')) return;
    if (window.getSelection()?.toString()) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    router.push(href);
  };
}

/**
 * 표 싸개(.table-wrap)에 붙이는 ref. 싸개가 minWidth 보다 좁아지면 data-stacked 를 붙여, 표가 가로로 밀리는 대신
 * 한 건이 한 덩이로 쌓이게 한다(꼴은 ListParts.module.css). 화면 너비가 아니라 표가 놓인 자리의 너비를 본다.
 * 그리기 전에 한 번 재고, 너비가 바뀔 때마다 다시 잰다.
 */
export function useStackBelow(minWidth: number): (node: HTMLDivElement | null) => (() => void) | undefined {
  return useCallback(
    (node) => {
      if (!node) return undefined;
      const apply = (width: number) => node.toggleAttribute('data-stacked', width < minWidth);
      apply(node.clientWidth);
      const observer = new ResizeObserver((entries) => apply(entries[0]?.contentRect.width ?? node.clientWidth));
      observer.observe(node);
      return () => observer.disconnect();
    },
    [minWidth],
  );
}
