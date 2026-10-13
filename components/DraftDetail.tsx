'use client';

// 초안 상세(검수 화면). 초안을 읽어 와 머리(상품 이름·상태·돌아가기)를 그리고, 본문은 DraftPanel 에 넘긴다.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { DraftDetailResponse, IntakeResponse } from '@/contract/api';
import { TYPE_LABELS } from '@/contract/fields';
import { Loading, Notice, PageHead, StatusBadge } from './bits';
import { ApiFailure, call, failureMessage, productHref, useMounted, waitForDraft } from './client';
import styles from './DraftDetail.module.css';
import { DraftPanel } from './DraftPanel';
import { formatTime } from './format';

const SOURCE_KIND_LABELS = { text: '글', image: '그림', pdf: 'PDF', import: '가져온 줄' } as const;

/** 머리에 적을 상품 이름. 이름 칸이 비었으면 까닭을 괄호로 적는다(검수함의 줄과 같은 말). */
function draftTitle(draft: DraftDetailResponse): string {
  const name = draft.fields.find((f) => f.field === 'name')?.finalValue;
  if (typeof name === 'string' && name.trim() !== '') return name;
  if (draft.type === 'not_product') return '(등록 대상이 아닌 글)';
  if (draft.status === 'PROCESSING') return '(처리 중인 글)';
  return '(이름을 찾지 못함)';
}

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

  // 탭 제목에 상품 이름까지 적는다(여러 건을 탭으로 열어도 구별된다).
  useEffect(() => {
    if (draft) document.title = `초안 #${draft.id} ${draftTitle(draft)} · 채움`;
  }, [draft]);

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

  // 주요 행동(승인·반려·가져와 고치기)은 DraftPanel 의 아래 막대에 있다. 머리에는 그 막대에 없는 길만 둔다:
  // 본보기 초안이 이미 상품이 됐으면 그 상품으로 가는 길.
  const productLink =
    draft && publicSpace && draft.status === 'APPROVED' && draft.productId ? (
      <Link className="btn" href={productHref(draft.productId, true)}>
        상품 보기
      </Link>
    ) : undefined;

  return (
    <main className="page wide">
      <PageHead
        crumb={<Link href="/inbox">← 검수함</Link>}
        title={
          draft ? (
            <>
              <span className={styles.no}>초안 #{draft.id}</span> {draftTitle(draft)} <StatusBadge status={draft.status} />
            </>
          ) : (
            <>초안 #{draftId}</>
          )
        }
        lead={
          draft ? (
            <>
              {draft.type ? TYPE_LABELS[draft.type] : '종류 모름'}
              {draft.subtype ? ` · ${draft.subtype}` : ''} · {SOURCE_KIND_LABELS[draft.source.kind]}로 들어옴 · {formatTime(draft.createdAt)}에 접수
              {publicSpace ? ' · 읽기 전용 본보기' : ''}
            </>
          ) : undefined
        }
        actions={productLink}
      />
      {error ? (
        <Notice kind="error">
          {error.message}
          {error.missing ? ' 이 브라우저의 작업 공간에 없는 초안입니다. 이틀 넘게 쓰지 않은 공간은 지워집니다.' : ''}
        </Notice>
      ) : null}
      {copying ? <Notice>내 작업 공간으로 가져오는 중입니다…</Notice> : null}
      {!draft && !error ? <Loading /> : null}
      {draft ? <DraftPanel draft={draft} onDraft={setDraft} publicSpace={publicSpace} mode="detail" onCopyToMine={publicSpace ? copyToMine : undefined} copying={copying} /> : null}
    </main>
  );
}
