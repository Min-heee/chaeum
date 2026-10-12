'use client';

// 여러 화면이 함께 쓰는 작은 조각들.
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

/** 알림 상자. 오류면 화면 읽기 도구가 바로 읽는다. */
export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  return (
    <div className={`box box-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
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

  return (
    <div className={`route route-${kind}`} role="status">
      <div>{body}</div>
      {llm.model && kind !== 'rules' ? (
        <p className="muted small">
          모델 {llm.model}
          {llm.promptVersion ? ` · 프롬프트 ${llm.promptVersion}` : ''}
        </p>
      ) : null}
      {transcribed ? (
        <p>
          <span className="flag">원본과 대조 필요</span> {sourceKind === 'pdf' ? 'PDF' : '그림'}에서 AI가 옮긴 글입니다. 옮기다 틀렸을 수 있으니 원본과
          견주어 주세요. 파일 자체는 저장하지 않았습니다.
        </p>
      ) : null}
    </div>
  );
}
