'use client';

// 상품 하나: 등록된 값, 영어·중국어 제목과 요약, 글 검사 5종 결과. 판 셋으로 나눠 보여 준다.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ProductDetailResponse } from '@/contract/api';
import { LANGS, LANG_LABELS, TEXT_FIELDS, type TextField } from '@/contract/content';
import { FIELD_KEYS, TYPE_LABELS } from '@/contract/fields';
import { CONTENT_CHECKS, CONTENT_FAILS, type ContentCheck } from '@/contract/reasons';
import { Badge, Loading, Notice, PageHead } from './bits';
import { call, failureMessage, pollUntil, useMounted } from './client';
import { fieldLabel, formatTime, formatValue, won } from './format';
import styles from './ProductDetail.module.css';
import { TEXT_STATE_LABELS, TEXT_STATE_TONES } from './Products';

const TEXT_FIELD_LABELS: Record<TextField, string> = { title: '제목', summary: '요약' };

const CHECK_LABELS: Record<ContentCheck, string> = {
  placeholder: '자리표시 보존',
  number: '자리표시 밖 숫자',
  language: '한글 섞임·빈 글',
  monologue: '혼잣말·머리말 흔적',
  glossary: '용어 사전 표기',
};

type Text = ProductDetailResponse['texts'][number];

const textLabel = (text: Text) => `${LANG_LABELS[text.lang]} ${TEXT_FIELD_LABELS[text.field]}`;

/** 글 검사 5종은 모델이 쓴 글에 한다. 모델의 글 없이 틀 문장이 들어간 줄에는 검사 결과가 없다. */
const unchecked = (text: Text) => text.source === 'template' && text.failCodes.length === 0;

/** 글 한 줄: 글, 누가 썼는지, 걸렸으면 그 까닭. 확인이 필요한 줄은 노랗게 표시한다. */
function TextBlock({ text }: { text: Text }) {
  return (
    <div className={`field${text.status === 'needs_review' ? ' field-flag' : ''}`}>
      <div className="field-name">{textLabel(text)}</div>
      <div className="field-body">
        <p className="text-out" lang={text.lang}>
          {text.text}
        </p>
        {/* 누가 쓴 글인지. 모델이 쓴 글의 긴 설명은 판 머리에 한 번만 적고, 줄에는 표만 둔다. 틀 문장의 경고는 그 줄에 그대로 둔다. */}
        <p className="small">
          {text.source === 'template' ? (
            <>
              <span className="flag">틀 문장</span> 모델의 글이 검사에 걸렸거나 모델을 부르지 못해, 코드가 만든 틀 문장을 넣었습니다. 사람이 확인해야 합니다.
            </>
          ) : text.source === 'human' ? (
            <>
              <Badge tone="info">사람이 고친 글</Badge> 사람이 고친 글입니다.
            </>
          ) : (
            <Badge>모델이 쓴 글</Badge>
          )}
        </p>
        {unchecked(text) ? (
          <p className="muted small">글 검사 5종은 모델이 쓴 글에 하는 검사입니다. 이 줄은 모델의 글 없이 틀 문장이 들어갔습니다.</p>
        ) : text.source === 'template' ? (
          <p className="muted small">아래는 모델이 마지막으로 쓴 글의 검사 결과입니다. 걸려서 틀 문장으로 바꿨습니다.</p>
        ) : null}
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

/** 글 검사 결과 표: 글 넷 × 검사 다섯. 걸린 칸만 빨간 배지로 눈에 띄게 한다. */
function CheckTable({ texts }: { texts: Text[] }) {
  return (
    <div className="table-wrap flush" tabIndex={0} role="region" aria-label="글 검사 결과 표">
      <table className={styles.checks}>
        <caption className="sr-only">글마다 검사 다섯 가지의 결과</caption>
        <thead>
          <tr>
            <th scope="col">글</th>
            {CONTENT_CHECKS.map((check) => (
              <th key={check} scope="col">
                {CHECK_LABELS[check]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {texts.map((text) => {
            const failed = new Set(text.failCodes.map((code) => CONTENT_FAILS[code].check));
            return (
              <tr key={`${text.lang}-${text.field}`}>
                <th scope="row">
                  {textLabel(text)}
                  {text.source === 'template' && !unchecked(text) ? <span className="muted small">모델이 마지막으로 쓴 글의 결과</span> : null}
                </th>
                {unchecked(text) ? (
                  <td colSpan={CONTENT_CHECKS.length} className="muted">
                    검사하지 않음 (모델의 글 없이 틀 문장이 들어갔습니다)
                  </td>
                ) : (
                  CONTENT_CHECKS.map((check) => (
                    <td key={check}>
                      {failed.has(check) ? <Badge tone="danger">걸림</Badge> : <span className="check-pass">통과</span>}
                    </td>
                  ))
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
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

  // 탭 제목에 상품 이름까지 적는다.
  useEffect(() => {
    if (product) document.title = `상품 #${product.id} ${product.name} · 채움`;
  }, [product]);

  const optionKey = product?.type === 'ad' ? 'period_options' : product?.type === 'catering' ? 'quantity_options' : null;

  /** 등록된 값의 줄들: 값 셋(판매가·정가·부가세) → 종류별 규격 칸 → 옵션. 없는 값은 "없음"으로 적는다. */
  const values: { key: string; label: string; value: string }[] = product
    ? [
        { key: 'price_krw', label: '판매가(원)', value: won(product.price_krw) },
        { key: 'list_price_krw', label: '정가(원)', value: product.list_price_krw === null ? '없음' : won(product.list_price_krw) },
        { key: 'vat_included', label: '부가세 포함', value: formatValue('vat_included', product.vat_included) },
        ...FIELD_KEYS.filter((key) => key in product.spec).map((key) => ({ key, label: fieldLabel(key), value: formatValue(key, product.spec[key]) })),
        ...(optionKey ? [{ key: optionKey, label: fieldLabel(optionKey), value: formatValue(optionKey, product.options) }] : []),
      ]
    : [];

  const texts = product
    ? LANGS.flatMap((lang) => TEXT_FIELDS.map((field) => product.texts.find((t) => t.lang === lang && t.field === field))).filter((t): t is Text => t !== undefined)
    : [];

  return (
    <main className="page wide">
      <PageHead
        crumb={<Link href="/products">← 상품</Link>}
        title={
          product ? (
            <>
              <span className={styles.no}>상품 #{product.id}</span> {product.name} <Badge tone={TEXT_STATE_TONES[product.textState]}>{TEXT_STATE_LABELS[product.textState]}</Badge>
            </>
          ) : (
            <>상품 #{productId}</>
          )
        }
        lead={
          product ? (
            <>
              {TYPE_LABELS[product.type]} · {product.subtype} · {formatTime(product.createdAt)}에 승인
            </>
          ) : undefined
        }
        actions={
          product ? (
            <>
              <Link className="btn" href={`/drafts/${product.draftId}${publicSpace ? '?pub=1' : ''}`}>
                초안 #{product.draftId}의 변경 기록 보기
              </Link>
              {/* 내려받기는 목록 화면의 도구 막대에서 한다(양식을 골라 여러 건을 한 번에 받는다). 여기서는 그리로 가는 길이다. */}
              <Link className="btn" href="/products#export">
                양식으로 내려받기
              </Link>
              <span className={`muted small ${styles.actionNote}`}>상품 목록 화면에서 받습니다</span>
            </>
          ) : undefined
        }
      />
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!product && !error ? <Loading /> : null}
      {product ? (
        <>
          {publicSpace ? (
            <Notice>
              <strong>읽기 전용 본보기</strong>(사이트를 처음 깔 때 보기 글의 초안을 미리 승인해 넣어 둔 것. 사람이 눌러 승인한 것이 아닙니다)
            </Notice>
          ) : null}

          <section className="panel" aria-labelledby="values-title">
            <h2 id="values-title" className="panel-title">
              등록된 값
            </h2>
            <dl className={styles.specs}>
              {values.map((row) => (
                <div key={row.key} className={styles.spec}>
                  <dt>{row.label}</dt>
                  <dd className={row.value === '없음' ? styles.none : undefined}>{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="panel" aria-labelledby="texts-title">
            <h2 id="texts-title" className="panel-title">
              영어·중국어 글 <Badge tone={TEXT_STATE_TONES[product.textState]}>{TEXT_STATE_LABELS[product.textState]}</Badge>
            </h2>
            <p className="muted small">
              값·일수·수량 숫자는 모델이 쓰지 않고 자리표시로 둡니다. 코드가 등록된 값에서 넣으므로 위의 값과 같습니다. 이름에 든 숫자(“7번 출구”의 7)는 모델이 그대로
              옮깁니다. 검사를 통과했다는 것은 아래 다섯 가지에 걸리지 않았다는 뜻이고, 글이 자연스러운지는 따로 보지 않았습니다. 모델의 글이 미리 받아 둔 답인지 방금 받은
              답인지는 글마다 따로 남기지 않습니다(이 서버에서 실제 호출이 닫혀 있으면 미리 받아 둔 답입니다).
            </p>
            {texts.some((t) => t.source !== 'template' && t.source !== 'human') ? (
              <p className="muted small">
                <Badge>모델이 쓴 글</Badge> 표가 붙은 줄: 모델이 쓴 글입니다. 값·일수·수량 숫자는 코드가 넣었습니다.
              </p>
            ) : null}
            {product.textState === 'pending' ? <Notice>글을 만드는 중입니다. 끝나면 여기에 나타납니다.</Notice> : null}
            <div className={styles.texts}>
              {texts.map((t) => (
                <TextBlock key={`${t.lang}-${t.field}`} text={t} />
              ))}
            </div>
          </section>

          {texts.length > 0 ? (
            <section className="panel" aria-labelledby="checks-title">
              <h2 id="checks-title" className="panel-title">
                글 검사 결과
              </h2>
              <p className="muted small">글 넷에 검사 다섯 가지를 한 결과입니다. 걸린 까닭은 위의 글마다 적혀 있습니다.</p>
              <CheckTable texts={texts} />
            </section>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
