'use client';

// 여러 화면이 함께 쓰는 작은 조각들. 쓰는 법은 docs/UI.md 에 있다.
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { DraftLlmBody, SourceKind } from '@/contract/api';
import type { ExtractedBy } from '@/contract/fields';
import { LLM_SKIP_LABELS, REASONS, type ReasonCode } from '@/contract/reasons';
import { STATUS_LABELS, type DraftStatus } from '@/contract/transitions';
import { seconds, usd } from './format';

/** 글자를 클립보드에 넣는 버튼. */
export function CopyButton({ text, label = '복사' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('done');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 1800);
  };
  return (
    <button type="button" className="btn small" onClick={copy}>
      {state === 'done' ? '복사됨' : state === 'failed' ? '복사하지 못함' : label}
    </button>
  );
}

/** 사유 표시. 노란 딱지와 한 줄 설명. */
export function ReasonList({ codes }: { codes: readonly ReasonCode[] }) {
  if (codes.length === 0) return null;
  return (
    <ul className="reasons">
      {codes.map((code) => (
        <li key={code}>
          <span className="flag">{REASONS[code].label}</span> {REASONS[code].description}
        </li>
      ))}
    </ul>
  );
}

/** 사유 이름만 줄지어. 목록에서 쓴다. */
export function ReasonChips({ codes }: { codes: readonly ReasonCode[] }) {
  if (codes.length === 0) return null;
  return (
    <span className="chips">
      {codes.map((code) => (
        <span key={code} className="flag" title={REASONS[code].description}>
          {REASONS[code].label}
        </span>
      ))}
    </span>
  );
}

export function StatusBadge({ status }: { status: DraftStatus }) {
  return <span className={`status status-${status}`}>{STATUS_LABELS[status]}</span>;
}

/** 알림 상자(정보·좋음·주의·오류). 오류면 화면 읽기 도구가 바로 읽는다. */
export function Notice({ kind = 'info', children }: { kind?: 'info' | 'ok' | 'warn' | 'error'; children: ReactNode }) {
  return (
    <div className={`box box-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/**
 * 화면 머리. 모든 화면이 같은 꼴을 쓴다: 제목 + 한 줄 설명 + 오른쪽에 그 화면의 주요 행동.
 * 긴 설명은 about 에 넣는다. 기본으로 닫힌 "이 화면 설명" 안에 들어간다(글은 줄이지 않고 그대로 옮긴다).
 */
export function PageHead({
  title,
  lead,
  actions,
  about,
  aboutLabel = '이 화면 설명',
  crumb,
}: {
  title: ReactNode;
  /** 제목 아래 한 줄 설명 */
  lead?: ReactNode;
  /** 오른쪽에 놓는 주요 행동(버튼, 링크) */
  actions?: ReactNode;
  /** 접어 두는 긴 설명 */
  about?: ReactNode;
  aboutLabel?: string;
  /** 제목 위의 돌아가는 길(← 검수함 같은 링크) */
  crumb?: ReactNode;
}) {
  return (
    <header className="page-head">
      {crumb ? <p className="crumb">{crumb}</p> : null}
      {/* 제목 줄의 오른쪽에 행동이 서고, 한 줄 설명은 그 아래에 온다(좁은 화면에서도 버튼이 제목 옆에 남는다). */}
      <div className="page-head-row">
        <h1>{title}</h1>
        {actions ? <div className="page-actions">{actions}</div> : null}
        {lead ? (
          <p className="page-lead">
            <span>{lead}</span>
          </p>
        ) : null}
      </div>
      {about ? (
        <details className="about">
          <summary>{aboutLabel}</summary>
          <div className="about-body">{about}</div>
        </details>
      ) : null}
    </header>
  );
}

export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger';

/** 배지: 옅은 바탕의 작은 상태 표. 초안 상태는 StatusBadge, 확인할 까닭은 ReasonChips 를 쓴다. */
export function Badge({ tone = 'neutral', title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  return (
    <span className={tone === 'neutral' ? 'badge' : `badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** 빈 상태: 무엇이 없는지 한 줄 + 다음에 할 일. */
export function EmptyState({ title, children, action }: { title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {title ? <p className="empty-title">{title}</p> : null}
      {children ? <div>{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

/**
 * 읽는 중 표시. 글자는 화면 읽기 도구가 읽고(role="status"), 눈에는 자리 잡힌 줄이 보인다.
 * lines 가 0 이면 버튼 옆에 두는 한 줄짜리가 된다.
 */
export function Loading({ label = '읽어 오는 중…', lines = 3 }: { label?: string; lines?: number }) {
  if (lines <= 0) {
    return (
      <span className="loading-inline" role="status" aria-live="polite">
        <span className="loading-dot" aria-hidden="true" />
        {label}
      </span>
    );
  }
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="loading-text">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton" aria-hidden="true" />
      ))}
    </div>
  );
}

export interface StatItem {
  /** 이름표 */
  label: ReactNode;
  /** 숫자(단위까지 글자로 넣는다. 예: "5건") */
  value: ReactNode;
  /** 숫자 아래 작은 글씨(분모, 단서) */
  note?: ReactNode;
  tone?: 'ok' | 'warn' | 'danger';
}

/** 요약 숫자 줄: 이름표 + 숫자를 한 줄에 나란히. 목록 위에 둔다. */
export function Stats({ items }: { items: readonly StatItem[] }) {
  return (
    <dl className="stats">
      {items.map((item, index) => (
        <div key={index} className={item.tone ? `stat stat-${item.tone}` : 'stat'}>
          <dt className="stat-label">{item.label}</dt>
          <dd className="stat-value">{item.value}</dd>
          {item.note ? <dd className="stat-note">{item.note}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

export type StepState = 'done' | 'now' | 'todo' | 'warn';

const STEP_STATE_TEXT: Record<StepState, string> = { done: '끝남', now: '지금 할 단계', todo: '아직', warn: '살펴야 함' };

export interface StepItem {
  n: number;
  label: ReactNode;
  state: StepState;
  /** 누르면 갈 곳. '#…' 이면 이 화면 안의 자리, '/…' 이면 다른 화면. 없으면 눌리지 않는다. */
  href?: string | null;
  /** 이름 뒤에 붙는 작은 글씨(갈 화면의 이름, "0개" 같은 단서) */
  note?: ReactNode;
}

/**
 * 단계 줄. 어디까지 왔고 지금 무엇을 할 차례인지 한 줄로 보여 준다.
 * 끝난 단계는 체크, 지금 할 단계는 파랑(aria-current="step"), 살펴야 할 단계는 노란 느낌표다. 색만으로 알리지 않는다.
 */
export function Steps({ items, label }: { items: readonly StepItem[]; label: string }) {
  return (
    <nav aria-label={label}>
      <ol className="steps">
        {items.map((step) => {
          const body = (
            <>
              <span className="step-no" aria-hidden="true">
                {step.state === 'done' ? (
                  <svg viewBox="0 0 12 12" width="12" height="12" focusable="false">
                    <path d="M2.5 6.4 5 8.8l4.5-5.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : step.state === 'warn' ? (
                  '!'
                ) : (
                  step.n
                )}
              </span>
              <span className="step-label">
                <span className="sr-only">{step.n}. </span>
                {step.label}
                {step.note ? <span className="step-note"> · {step.note}</span> : null}
              </span>
              <span className="sr-only"> ({STEP_STATE_TEXT[step.state]})</span>
            </>
          );
          const current = step.state === 'now' ? ('step' as const) : undefined;
          return (
            <li key={step.n} className="step" data-state={step.state}>
              {!step.href ? (
                <span aria-current={current}>{body}</span>
              ) : step.href.startsWith('#') ? (
                <a href={step.href} aria-current={current}>
                  {body}
                </a>
              ) : (
                <Link href={step.href} aria-current={current}>
                  {body}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** 도구 막대: 거르기(왼쪽)와 버튼(end, 오른쪽)을 한 줄에. 좁으면 줄이 바뀐다. */
export function Toolbar({ children, end, label }: { children?: ReactNode; end?: ReactNode; label?: string }) {
  return (
    <div className="toolbar" role={label ? 'group' : undefined} aria-label={label}>
      {children}
      {end ? <div className="toolbar-end">{end}</div> : null}
    </div>
  );
}

/** 로컬에서 진짜 LLM 으로 돌리는 법. 값이나 환경 변수 이름은 적지 않는다(.env.example 에 있다). */
export function LocalRunHelp() {
  const lines = [
    'git clone <이 저장소 주소> && cd chaeum',
    'npm install',
    'cp .env.example .env.local   # DB 주소, API 키, 하루 상한을 직접 적는다',
    'npm run db:migrate',
    'npm run db:seed',
    'npm run dev',
  ].join('\n');
  return (
    <details className="help">
      <summary>내 컴퓨터에서 진짜 AI로 돌리기</summary>
      <pre className="code">{lines}</pre>
      <CopyButton text={lines} label="명령 복사" />
    </details>
  );
}

/**
 * 이 초안이 어떤 길로 뽑혔는지 적는 띠.
 * 미리 받아 둔 답 / 방금 실제 호출 / 규칙만(까닭과 함께) 셋 가운데 하나다.
 */
export function RouteBanner({
  llm,
  sourceKind,
  status,
  extractedBy,
}: {
  llm: DraftLlmBody;
  sourceKind: SourceKind;
  status: DraftStatus;
  extractedBy: ExtractedBy | null;
}) {
  if (status === 'PROCESSING') return null;
  const transcribed = sourceKind === 'image' || sourceKind === 'pdf';
  const measured =
    llm.originalLatencyMs !== null && llm.originalCostUsd !== null
      ? `원래 걸린 시간 ${seconds(llm.originalLatencyMs)}, 원래 비용 ${usd(llm.originalCostUsd)}`
      : null;

  let body: ReactNode;
  let kind: 'recorded' | 'live' | 'rules' | 'unknown';
  if (llm.recorded) {
    kind = 'recorded';
    body = (
      <>
        <strong>미리 받아 둔 실제 응답</strong>으로 뽑았습니다{measured ? ` (${measured})` : ''}. 지금 모델을 부르지는 않았습니다.
      </>
    );
  } else if (llm.live) {
    kind = 'live';
    body = (
      <>
        <strong>방금 실제로 호출</strong>해 뽑았습니다{measured ? ` (${measured.replaceAll('원래 ', '')})` : ''}.
      </>
    );
  } else if (extractedBy === 'import') {
    // 모으기 도구가 정리해 온 줄이다. 글에서 뽑은 것이 아니고 모델도 거치지 않았다.
    kind = 'rules';
    body = (
      <>
        <strong>모으기 도구가 가져온 줄입니다. AI를 거치지 않았습니다.</strong> 줄에 적힌 값을 코드가 그대로 맞추고 따졌습니다. 자료에 없는 칸(값 등)은
        비어 있습니다.
      </>
    );
  } else if (extractedBy === 'rules' || llm.skipCause !== null) {
    kind = 'rules';
    body = (
      <>
        <strong>규칙만으로 뽑았습니다. AI를 거치지 않았습니다.</strong>
        {llm.skipCause ? ` 이유: ${LLM_SKIP_LABELS[llm.skipCause]}` : ''}
        <LocalRunHelp />
      </>
    );
  } else if (extractedBy === 'llm') {
    // 시험용 방식으로 띄운 서버에서만 나온다. 진짜 모델의 답이 아니다.
    kind = 'unknown';
    body = <>시험용 가짜 응답으로 뽑았습니다. 진짜 모델의 답이 아닙니다.</>;
  } else {
    kind = 'unknown';
    body = <>처리를 끝내지 못했습니다. 다시 돌려 볼 수 있습니다.</>;
  }

  // 한 줄 띠다. 모델·프롬프트는 같은 줄 끝에 작은 글씨로 붙인다(문장은 줄이지 않는다).
  return (
    <div className={`route route-${kind}`} role="status">
      <div>
        {body}
        {llm.model && kind !== 'rules' ? (
          <span className="route-meta">
            {' '}
            모델 {llm.model}
            {llm.promptVersion ? ` · 프롬프트 ${llm.promptVersion}` : ''}
          </span>
        ) : null}
      </div>
      {transcribed ? (
        <p>
          <span className="flag">원본과 대조 필요</span> {sourceKind === 'pdf' ? 'PDF' : '그림'}에서 AI가 옮긴 글입니다. 옮기다 틀렸을 수 있으니 원본과
          견주어 주세요. 파일 자체는 저장하지 않았습니다.
        </p>
      ) : null}
    </div>
  );
}
