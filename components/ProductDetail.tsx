'use client';

// 상품 하나: 등록된 값, 영어·중국어 제목과 요약, 글 검사 5종 결과.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ProductDetailResponse } from '@/contract/api';
import { LANGS, LANG_LABELS, TEXT_FIELDS, type TextField } from '@/contract/content';
import { FIELD_KEYS, TYPE_LABELS } from '@/contract/fields';
import { CONTENT_CHECKS, CONTENT_FAILS, type ContentCheck } from '@/contract/reasons';
import { Notice } from './bits';
import { call, failureMessage, pollUntil, useMounted } from './client';
import { fieldLabel, formatTime, formatValue, won } from './format';
import { TEXT_STATE_LABELS } from './Products';

const TEXT_FIELD_LABELS: Record<TextField, string> = { title: '제목', summary: '요약' };

const CHECK_LABELS: Record<ContentCheck, string> = {
  placeholder: '자리표시 보존',
  number: '자리표시 밖 숫자',
  language: '한글 섞임·빈 글',
  monologue: '혼잣말·머리말 흔적',
  glossary: '용어 사전 표기',
};

type Text = ProductDetailResponse['texts'][number];

function TextBlock({ text }: { text: Text }) {
  const failed = new Set(text.failCodes.map((code) => CONTENT_FAILS[code].check));
  return (
    <div className={`field${text.status === 'needs_review' ? ' field-flag' : ''}`}>
      <div className="field-name">
        {LANG_LABELS[text.lang]} {TEXT_FIELD_LABELS[text.field]}
      </div>
      <div className="field-body">
        <p className="text-out" lang={text.lang}>
          {text.text}
        </p>
        <p className="small">
          {text.source === 'template' ? <span className="flag">틀 문장</span> : null}{' '}
          {text.source === 'template'
            ? '모델의 글이 검사에 걸렸거나 모델을 부르지 못해, 코드가 만든 틀 문장을 넣었습니다. 사람이 확인해야 합니다.'
            : text.source === 'human'
              ? '사람이 고친 글입니다.'
              : '모델이 쓴 글입니다. 값·일수·수량 숫자는 코드가 넣었습니다.'}
        </p>
        {text.source === 'template' && text.failCodes.length === 0 ? (
          <p className="muted small">글 검사 5종은 모델이 쓴 글에 하는 검사입니다. 이 줄은 모델의 글 없이 틀 문장이 들어갔습니다.</p>
        ) : (
          <>
            {text.source === 'template' ? <p className="muted small">아래는 모델이 마지막으로 쓴 글의 검사 결과입니다. 걸려서 틀 문장으로 바꿨습니다.</p> : null}
            <ul className="checks" aria-label="글 검사 결과">
              {CONTENT_CHECKS.map((check) => (
                <li key={check} className={failed.has(check) ? 'check-fail' : 'check-pass'}>
                  {CHECK_LABELS[check]}: {failed.has(check) ? '걸림' : '통과'}
                </li>
              ))}
            </ul>
          </>
        )}
        {text.failCodes.length > 0 ? (
          <ul className="reasons">
            {text.failCodes.map((code) => (
              <li key={code}>
                <span className="flag">{CONTENT_FAILS[code].label}</span> {CONTENT_FAILS[code].description}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function ProductDetail({ productId, publicSpace = false }: { productId: number; publicSpace?: boolean }) {
  const mounted = useMounted();
  const [product, setProduct] = useState<ProductDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mounted) return;
    let alive = true;
    const read = () => call<ProductDetailResponse>('GET', `/api/products/${productId}`, { publicSpace });
    // 먼저 지금 것을 보여 주고, 글이 아직이면 줄을 굴리며 기다린다.
    read()
      .then((first) => {
        if (!alive) return undefined;
        setProduct(first);
        return first.textState === 'pending' ? pollUntil(read, (p) => p.textState !== 'pending') : undefined;
      })
      .then((later) => {
        if (alive && later) setProduct(later);
      })
      .catch((err: unknown) => {
        if (alive) setError(failureMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [mounted, productId, publicSpace]);

  const optionKey = product?.type === 'ad' ? 'period_options' : product?.type === 'catering' ? 'quantity_options' : null;

  return (
    <main className="page">
      <p className="crumb">
        <Link href="/products">← 상품</Link>
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!product && !error ? <p className="muted">읽어 오는 중…</p> : null}
      {product ? (
        <>
          <h1>
            #{product.id} {product.name}
          </h1>
          <p className="muted">
            {TYPE_LABELS[product.type]} · {product.subtype} · {formatTime(product.createdAt)}에 승인
            {publicSpace ? ' · 읽기 전용 본보기(사이트를 처음 깔 때 보기 글의 초안을 미리 승인해 넣어 둔 것. 사람이 눌러 승인한 것이 아닙니다)' : ''} ·{' '}
            <Link href={`/drafts/${product.draftId}${publicSpace ? '?pub=1' : ''}`}>초안 #{product.draftId}의 변경 기록 보기</Link>
          </p>

          <section aria-label="등록된 값">
            <h2>등록된 값</h2>
            <div className="field">
              <div className="field-name">판매가(원)</div>
              <div className="field-body">{won(product.price_krw)}</div>
            </div>
            <div className="field">
              <div className="field-name">정가(원)</div>
              <div className="field-body">{product.list_price_krw === null ? '없음' : won(product.list_price_krw)}</div>
            </div>
            <div className="field">
              <div className="field-name">부가세 포함</div>
              <div className="field-body">{formatValue('vat_included', product.vat_included)}</div>
            </div>
            {FIELD_KEYS.filter((key) => key in product.spec)
              .map((key) => [key, product.spec[key]] as const)
              .map(([key, value]) => (
                <div className="field" key={key}>
                  <div className="field-name">{fieldLabel(key)}</div>
                  <div className="field-body">{formatValue(key, value)}</div>
                </div>
              ))}
            {optionKey ? (
              <div className="field">
                <div className="field-name">{fieldLabel(optionKey)}</div>
                <div className="field-body">{formatValue(optionKey, product.options)}</div>
              </div>
            ) : null}
          </section>

          <section aria-label="다른 언어 글">
            <h2>
              영어·중국어 글 <span className={`status text-${product.textState}`}>{TEXT_STATE_LABELS[product.textState]}</span>
            </h2>
            <p className="muted small">
              값·일수·수량 숫자는 모델이 쓰지 않고 자리표시로 둡니다. 코드가 등록된 값에서 넣으므로 위의 값과 같습니다. 이름에 든 숫자(“7번 출구”의 7)는 모델이 그대로
              옮깁니다. 검사를 통과했다는 것은 아래 다섯 가지에 걸리지 않았다는 뜻이고, 글이 자연스러운지는 따로 보지 않았습니다. 모델의 글이 미리 받아 둔 답인지 방금 받은
              답인지는 글마다 따로 남기지 않습니다(이 서버에서 실제 호출이 닫혀 있으면 미리 받아 둔 답입니다).
            </p>
            {product.textState === 'pending' ? <Notice>글을 만드는 중입니다. 끝나면 여기에 나타납니다.</Notice> : null}
            {LANGS.flatMap((lang) => TEXT_FIELDS.map((field) => product.texts.find((t) => t.lang === lang && t.field === field)))
              .filter((t): t is Text => t !== undefined)
              .map((t) => (
                <TextBlock key={`${t.lang}-${t.field}`} text={t} />
              ))}
          </section>

          <p className="next">
            <Link className="btn primary" href="/products">
              양식으로 내려받기
            </Link>
          </p>
        </>
      ) : null}
    </main>
  );
}
