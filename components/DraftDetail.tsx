'use client';

// 초안 상세(검수 화면). 초안을 읽어 와 DraftPanel 에 넘긴다.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { DraftDetailResponse, IntakeResponse } from '@/contract/api';
import { Notice } from './bits';
import { ApiFailure, call, failureMessage, useMounted, waitForDraft } from './client';
import { DraftPanel } from './DraftPanel';

export function DraftDetail({ draftId, publicSpace }: { draftId: number; publicSpace: boolean }) {
  const router = useRouter();
  const mounted = useMounted();
  const [draft, setDraft] = useState<DraftDetailResponse | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    if (!mounted) return;
    let alive = true;
    // 처리 중이면 줄을 굴리며 기다린다(이 사이트에는 따로 도는 작업자가 없다).
    waitForDraft(draftId, { publicSpace })
      .then((d) => {
        if (alive) setDraft(d);
      })
      .catch((err: unknown) => {
        if (alive) setError({ message: failureMessage(err), missing: err instanceof ApiFailure && err.status === 404 });
      });
    return () => {
      alive = false;
    };
  }, [draftId, publicSpace, mounted]);

  /** 본보기 초안의 원문을 내 공간에 그대로 접수한다. 내 공간의 초안은 고치고 승인할 수 있다. */
  const copyToMine = async () => {
    if (!draft) return;
    setCopying(true);
    try {
      const got = await call<IntakeResponse>('POST', '/api/source-docs', { body: { text: draft.source.text }, label: '본보기 글을 내 작업 공간에 접수' });
      await waitForDraft(got.draftId, { label: '줄 굴리기' });
      router.push(`/drafts/${got.draftId}`);
    } catch (err) {
      setError({ message: failureMessage(err), missing: false });
      setCopying(false);
    }
  };

  return (
    <main className="page wide">
      <p className="crumb">
        <Link href="/inbox">← 검수함</Link>
      </p>
      <h1 className="sr-only">초안 상세</h1>
      {error ? (
        <Notice kind="error">
          {error.message}
          {error.missing ? ' 이 브라우저의 작업 공간에 없는 초안입니다. 이틀 넘게 쓰지 않은 공간은 지워집니다.' : ''}
        </Notice>
      ) : null}
      {copying ? <Notice>내 작업 공간으로 가져오는 중입니다…</Notice> : null}
      {!draft && !error ? <p className="muted">읽어 오는 중…</p> : null}
      {draft ? <DraftPanel draft={draft} onDraft={setDraft} publicSpace={publicSpace} mode="detail" onCopyToMine={publicSpace ? copyToMine : undefined} /> : null}
    </main>
  );
}
