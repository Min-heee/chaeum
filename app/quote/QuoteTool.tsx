'use client';

// 견적 화면. 문의 글 → 뽑힌 조건(고칠 수 있다) → 맞는 상품과 총액·마감(왜 빠졌는지도) → 답장 초안과 글 검사 → 확인.
// 서버가 하는 일: 조건 뽑기(모델), 답장 초안(모델), 저장. 이 화면이 하는 일: 사람이 조건을 고치거나 직접 고르면
// 같은 순수 함수(src/tools/quote)로 브라우저에서 다시 계산한다. 그 계산에는 모델이 끼지 않는다.
// 화면의 꼴: 화면 머리 → 단계 줄(1~5, 지금 할 단계가 표시된다) → 단계마다 판 하나.
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { kstDay, type ProductListResponse } from '@/contract/api';
import type { GlossaryEntry } from '@/contract/content';
import { PRODUCT_TYPES, SUBTYPES, TYPE_LABELS, type ProductType } from '@/contract/fields';
import { CONTENT_FAILS, LLM_SKIP_LABELS, type ContentFailCode } from '@/contract/reasons';
import { DEADLINE_KIND_LABELS, DEADLINE_STATUS_LABELS, isRealDate, type DeadlineStatus } from '@/contract/tools/dates';
import { effectiveGlossary, type GlossaryListResponse } from '@/contract/tools/glossary';
import {
  QUOTE_EXCLUDE_LABELS,
  QUOTE_LANG_LABELS,
  QUOTE_LANGS,
  QUOTE_LIMITS,
  QUOTE_MATCH_LABELS,
  type QuoteCall,
  type QuoteCandidate,
  type QuoteCatalog,
  type QuoteConditions,
  type QuoteExcluded,
  type QuoteLang,
  type QuoteProduct,
  type QuoteResponse,
} from '@/contract/tools/quote';
import { pickGlossary } from '@/content/glossary';
import {
  askReply,
  checkReply,
  fillReply,
  formatDate,
  hasLeftoverPlaceholder,
  hasSearchCondition,
  matchQuote,
  quoteSamples,
  rangeDays,
  replyInputOf,
  replyValues,
  templateReply,
  vatNote,
} from '@/tools/quote';
import { Badge, CopyButton, Loading, Notice, PageHead, Steps, Toolbar, type StepItem, type StepState, type Tone } from '../../components/bits';
import { ApiFailure, call, failureMessage, productHref, useMounted, useWorkspace } from '../../components/client';
import { setToolSpace, useToolSpace } from '../../components/space';
import { formatTime, usd, won } from '../../components/format';
import styles from './quote.module.css';

const SAMPLES = quoteSamples();

/** 어느 공간의 상품으로 계산하나. mine: 내 작업 공간, public: 본보기 공간(읽기 전용). */
type Source = 'mine' | 'public';

/** 화면이 보여 주는 한 건. 서버가 저장한 견적에서 오거나, 브라우저가 다시 계산한 것이다. */
interface View {
  today: string;
  conditions: QuoteConditions;
  candidates: QuoteCandidate[];
  candidateCount: number;
  excluded: QuoteExcluded[];
  productCount: number;
  source: Source;
  selectedId: number | null;
  replyTemplate: string;
  replySource: 'llm' | 'template';
  failCodes: ContentFailCode[];
  /** 브라우저가 다시 계산한 것인가(서버에 저장된 값과 다를 수 있다) */
  local: boolean;
}

/**
 * 지금 어느 자리의 일을 하고 있나. 읽는 중 표시와 오류를 누른 자리 가까이에 두려고 적어 둔다.
 * create: 1단계의 견적 만들기, calc: 2단계의 다시 계산, catalog·pick: 3단계, reply: 4단계의 AI 답장 받기, confirm: 5단계.
 */
type At = 'create' | 'calc' | 'catalog' | 'pick' | 'reply' | 'confirm';

const BUSY_LABELS: Record<At, string> = {
  create: '조건을 뽑고 견적을 만드는 중입니다…',
  calc: '계산하는 중입니다…',
  catalog: '본보기 공간의 상품으로 계산하는 중입니다…',
  pick: '고른 상품으로 답장을 다시 쓰는 중입니다…',
  reply: 'AI 답장을 받는 중입니다…',
  confirm: '확정하는 중입니다…',
};

const DEADLINE_TONES: Record<DeadlineStatus, Tone> = { open: 'ok', closing: 'warn', late: 'danger' };

const EMPTY_CONDITIONS: QuoteConditions = {
  lang: 'ko', budgetKrw: null, budgetBy: null, region: null, dateFrom: null, dateTo: null, dateProblem: false, type: null, subtype: null, qty: null, days: null,
};

const toQuoteProduct = (p: ProductListResponse['items'][number]): QuoteProduct => ({
  id: p.id, type: p.type, subtype: p.subtype, name: p.name, price_krw: p.price_krw, vat_included: p.vat_included, spec: p.spec, options: p.options,
});

const positiveInt = (text: string): number | null => {
  const n = Number(text.replace(/,/g, '').trim());
  return text.trim() !== '' && Number.isSafeInteger(n) && n > 0 ? n : null;
};

function fillFor(view: View, template: string): string {
  const candidate = view.candidates.find((c) => c.productId === view.selectedId) ?? null;
  return fillReply(template, replyValues(candidate), view.conditions.lang, { vatIncluded: candidate?.pricing.vatIncluded ?? null });
}

function callText(info: QuoteCall): string {
  const how = info.recorded ? '미리 받아 둔 답' : info.live ? '방금 실제 호출' : '시험용 답(모델을 부르지 않음)';
  return `${how} · ${info.model} · ${usd(info.costUsd)}`;
}

/** 모델을 어떤 길로 불렀는지에 맞는 띠의 꼴(작업 화면의 띠와 같은 클래스). */
const routeClass = (info: QuoteCall): string => (info.recorded ? 'route route-recorded' : info.live ? 'route route-live' : 'route route-unknown');

/** 총액을 어떻게 냈는지 한 줄로. 옵션에 없는 기간·수량이면 그렇게 적는다. 나눠서 값을 지어내지 않는다. */
function pricingNote(candidate: QuoteCandidate, conditions: QuoteConditions): string {
  const p = candidate.pricing;
  if (p.basis === 'unit_price') return `낱개 ${won(p.unitKrw)} × ${p.qty?.toLocaleString('ko-KR')}개`;
  const isPeriod = p.basis === 'period_option';
  const size = isPeriod ? `${p.days}일` : `${p.qty?.toLocaleString('ko-KR')}개(잔)`;
  const wanted = isPeriod ? conditions.days : conditions.qty;
  if (!p.exact && wanted !== null) {
    return `바라는 ${isPeriod ? `${wanted}일` : `${wanted.toLocaleString('ko-KR')}개(잔)`}과 같은 옵션이 없어, 그보다 큰 옵션 가운데 가장 작은 ${size} 옵션의 값입니다. 날 수나 수량으로 나눠 계산하지 않습니다.`;
  }
  return `${size} 옵션의 값${wanted === null ? ` (${isPeriod ? '기간' : '수량'} 조건이 없어 가장 작은 옵션)` : ''}`;
}

function ConditionsForm({
  value,
  busy,
  working,
  primary = false,
  onApply,
}: {
  value: QuoteConditions;
  busy: boolean;
  /** 이 양식이 시킨 계산이 도는 중인가 */
  working: boolean;
  /** 이 단계에서 지금 할 일이 이 양식인가(조건을 직접 고를 때). 그러면 단추가 주요 단추가 된다. */
  primary?: boolean;
  onApply: (next: QuoteConditions) => void;
}) {
  const [lang, setLang] = useState<QuoteLang>(value.lang);
  const [type, setType] = useState<ProductType | ''>(value.type ?? '');
  const [subtype, setSubtype] = useState(value.subtype ?? '');
  const [region, setRegion] = useState(value.region ?? '');
  const [budget, setBudget] = useState(value.budgetKrw === null ? '' : String(value.budgetKrw));
  const [dateFrom, setDateFrom] = useState(value.dateFrom ?? '');
  const [dateTo, setDateTo] = useState(value.dateTo ?? '');
  const [qty, setQty] = useState(value.qty === null ? '' : String(value.qty));
  const [days, setDays] = useState(value.days === null ? '' : String(value.days));
  const [error, setError] = useState<string | null>(null);

  const subtypes: readonly string[] = type === '' ? PRODUCT_TYPES.flatMap((t) => [...SUBTYPES[t]]) : SUBTYPES[type];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const from = dateFrom || dateTo;
    const to = dateTo || dateFrom;
    if ((from && !isRealDate(from)) || (to && !isRealDate(to))) return setError('날짜의 꼴이 틀렸습니다.');
    if (from && to && from > to) return setError('끝 날짜가 시작 날짜보다 앞입니다.');
    for (const [label, text] of [['예산', budget], ['수량', qty], ['기간', days]] as const) {
      if (text.trim() !== '' && positiveInt(text) === null) return setError(`${label}: 0보다 큰 정수로 적어 주세요.`);
    }
    setError(null);
    onApply({
      lang,
      budgetKrw: positiveInt(budget),
      budgetBy: positiveInt(budget) === null ? null : 'code',
      region: region.trim() === '' ? null : region.trim(),
      dateFrom: from || null,
      dateTo: to || null,
      dateProblem: false,
      type: type === '' ? null : type,
      subtype: subtype !== '' && subtypes.includes(subtype) ? subtype : null,
      qty: positiveInt(qty),
      days: positiveInt(days),
    });
  };

  return (
    <form onSubmit={submit} aria-label="조건">
      <div className={`form-grid ${styles.conditions}`}>
        <label className="stack">
          답장 언어
          <select value={lang} onChange={(e) => setLang(e.target.value as QuoteLang)}>
            {QUOTE_LANGS.map((l) => (
              <option key={l} value={l}>{QUOTE_LANG_LABELS[l]}</option>
            ))}
          </select>
        </label>
        <label className="stack">
          종류
          <select value={type} onChange={(e) => { setType(e.target.value as ProductType | ''); setSubtype(''); }}>
            <option value="">없음(거르지 않음)</option>
            {PRODUCT_TYPES.map((t) => (
              <option key={t} value={t}>{TYPE_LABELS[t]}</option>
            ))}
          </select>
        </label>
        <label className="stack">
          갈래
          <select value={subtype} onChange={(e) => setSubtype(e.target.value)}>
            <option value="">없음(거르지 않음)</option>
            {subtypes.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="stack">
          지역(한국어 지명)
          <input value={region} maxLength={60} placeholder="예: 홍대" onChange={(e) => setRegion(e.target.value)} />
        </label>
        <label className="stack">
          예산(원)
          <input className={styles.numInput} value={budget} inputMode="numeric" placeholder="예: 3000000" onChange={(e) => setBudget(e.target.value)} />
        </label>
        <label className="stack">
          희망 날짜(시작)
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </label>
        <label className="stack">
          희망 날짜(끝)
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </label>
        <label className="stack">
          수량
          <input className={styles.numInput} value={qty} inputMode="numeric" placeholder="예: 200" onChange={(e) => setQty(e.target.value)} />
        </label>
        <label className="stack">
          기간(일)
          <input className={styles.numInput} value={days} inputMode="numeric" placeholder="예: 14" onChange={(e) => setDays(e.target.value)} />
        </label>
      </div>
      <div className="actions">
        <button type="submit" className={primary ? 'btn primary' : 'btn'} disabled={busy}>이 조건으로 계산</button>
        {working ? <Loading label={BUSY_LABELS.calc} lines={0} /> : null}
        <span className="muted small">비운 조건으로는 거르지 않습니다. 이 계산은 브라우저에서 코드가 합니다. AI를 부르지 않습니다.</span>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
    </form>
  );
}

export function QuoteTool() {
  const mounted = useMounted();
  const workspace = useWorkspace();
  const [text, setText] = useState('');
  const [todayInput, setTodayInput] = useState('');
  /** 살필 상품의 자리. 고른 적이 없으면 알아서: 내 작업 공간에 상품이 있으면 그 공간, 없으면 본보기 공간(다른 도구와 같은 규칙). */
  const toolSpace = useToolSpace();
  const catalog: QuoteCatalog = toolSpace === 'mine' ? 'own' : 'public';
  const setCatalogPick = (next: QuoteCatalog) => setToolSpace(next === 'own' ? 'mine' : 'public');
  /** 지금 도는 일의 자리. null 이면 쉬는 중이다. */
  const [busyAt, setBusyAt] = useState<At | null>(null);
  const busy = busyAt !== null;
  /** 마지막 오류와 그것이 난 자리. 그 자리의 판에 적는다. */
  const [error, setError] = useState<{ at: At; message: string } | null>(null);
  /** 조건 뽑기 모델을 못 불렀을 때의 까닭. 있으면 조건을 직접 고르는 양식으로 내려간 것이다. */
  const [skipped, setSkipped] = useState<{ message: string } | null>(null);
  const [saved, setSaved] = useState<QuoteResponse | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [reply, setReply] = useState('');
  /** 조건 양식을 새 값으로 다시 그리게 하는 번호 */
  const [formTurn, setFormTurn] = useState(0);
  const inquiryRef = useRef<HTMLTextAreaElement | null>(null);
  const resultRef = useRef<HTMLElement | null>(null);
  /** 결과가 나오면 "3. 맞는 상품" 판으로 화면과 초점을 옮긴다(총액과 답장이 화면 아래 밖에 생기므로). */
  const goResult = useRef(false);
  useEffect(() => {
    if (!goResult.current || !resultRef.current) return;
    goResult.current = false;
    resultRef.current.focus({ preventScroll: true });
    resultRef.current.scrollIntoView({ block: 'start' });
  });

  const show = (next: View) => {
    setView(next);
    setReply(fillFor(next, next.replyTemplate));
  };

  const fromSaved = (quote: QuoteResponse): View => ({
    today: quote.today,
    conditions: quote.conditions,
    candidates: quote.candidates,
    candidateCount: quote.candidateCount,
    excluded: quote.excluded,
    productCount: quote.productCount,
    source: quote.catalog === 'public' ? 'public' : 'mine',
    selectedId: quote.selectedProductId,
    replyTemplate: quote.reply.template,
    replySource: quote.reply.source,
    failCodes: quote.reply.failCodes,
    local: false,
  });

  /** 답장을 코드의 틀 문장으로 다시 만든다(고른 상품이 바뀌었거나 브라우저에서 다시 계산했을 때). */
  const withTemplate = (base: Omit<View, 'replyTemplate' | 'replySource' | 'failCodes'>, glossaryAll: readonly GlossaryEntry[]): View => {
    const candidate = base.candidates.find((c) => c.productId === base.selectedId) ?? null;
    const glossary = candidate && base.conditions.lang !== 'ko'
      ? pickGlossary([...glossaryAll], { type: candidate.type, subtype: candidate.subtype, name: candidate.name, region: candidate.region })
      : [];
    const input = replyInputOf({ lang: base.conditions.lang, inquiry: text, candidate, candidateCount: base.candidateCount, glossary });
    // 고른 상품이 없고 무엇을 찾는지도 알 수 없으면 되묻는 글이다(서버와 같은 규칙).
    const template = !candidate && !hasSearchCondition(base.conditions) ? askReply(base.conditions.lang) : templateReply(input);
    return { ...base, replyTemplate: template, replySource: 'template', failCodes: checkReply(template, input) };
  };

  const readGlossary = async (publicSpace: boolean): Promise<GlossaryEntry[]> => {
    const list = await call<GlossaryListResponse>('GET', '/api/glossary', { publicSpace });
    const row = (t: GlossaryListResponse['items'][number]) => ({ ko: t.ko, en: t.en, 'zh-Hans': t['zh-Hans'], status: t.status });
    return effectiveGlossary(list.items.filter((t) => !t.shared).map(row), list.items.filter((t) => t.shared).map(row));
  };

  /** 브라우저에서 다시 계산한다. 상품은 서버에서 읽고, 고르기·총액·마감은 같은 순수 함수가 한다. */
  const computeLocal = async (conditions: QuoteConditions, source: Source, at: At = 'calc', selectedId?: number) => {
    setBusyAt(at);
    setError(null);
    try {
      const publicSpace = source === 'public' || !workspace;
      const today = todayInput || saved?.today || kstDay(new Date());
      const products = (await call<ProductListResponse>('GET', '/api/products', { publicSpace })).items.map(toQuoteProduct);
      const glossary = conditions.lang === 'ko' ? [] : await readGlossary(publicSpace);
      const matched = matchQuote(conditions, products, today);
      const selected = matched.candidates.find((c) => c.productId === selectedId) ?? (hasSearchCondition(conditions) ? (matched.candidates[0] ?? null) : null);
      show(withTemplate({
        today, conditions, candidates: matched.candidates, candidateCount: matched.candidates.length, excluded: matched.excluded,
        productCount: products.length, source: publicSpace ? 'public' : 'mine', selectedId: selected?.productId ?? null, local: true,
      }, glossary));
      setFormTurn((n) => n + 1);
      goResult.current = true;
    } catch (err) {
      setError({ at, message: failureMessage(err) });
    } finally {
      setBusyAt(null);
    }
  };

  /** 서버에 견적을 만든다(조건 뽑기 → 계산 → 답장 초안 → 저장). productId 를 주면 그 상품으로 답장을 쓴다. */
  const create = async (productId?: number, from: QuoteCatalog = catalog, at: At = 'create') => {
    setBusyAt(at);
    setError(null);
    setSkipped(null);
    try {
      const body = { text, ...(productId ? { productId } : {}), ...(todayInput ? { today: todayInput } : {}), ...(from === 'public' ? { catalog: from } : {}) };
      const quote = await call<QuoteResponse>('POST', '/api/quotes', { body, label: '견적 만들기' });
      setSaved(quote);
      show(fromSaved(quote));
      setFormTurn((n) => n + 1);
      goResult.current = true;
    } catch (err) {
      const llmDown = err instanceof ApiFailure && (err.code === 'LLM_UNAVAILABLE' || (err.code === 'LIMIT_EXCEEDED' && err.skipCause));
      if (llmDown) {
        // 조건 뽑기를 못 했다. 조건을 사람이 직접 고르는 양식으로 내려간다. 계산은 그대로 된다.
        setSkipped({ message: err.message });
        setSaved(null);
        setView(null);
        setFormTurn((n) => n + 1);
      } else setError({ at, message: failureMessage(err) });
    } finally {
      setBusyAt(null);
    }
  };

  const pick = async (productId: number) => {
    if (!view) return;
    setBusyAt('pick');
    try {
      const glossary = view.conditions.lang === 'ko' ? [] : await readGlossary(view.source === 'public' || !workspace);
      show(withTemplate({ ...view, selectedId: productId, local: true }, glossary));
    } catch (err) {
      setError({ at: 'pick', message: failureMessage(err) });
    } finally {
      setBusyAt(null);
    }
  };

  const confirm = async () => {
    if (!saved) return;
    setBusyAt('confirm');
    setError(null);
    try {
      setSaved(await call<QuoteResponse>('POST', `/api/quotes/${saved.id}/confirm`, { body: { reply }, label: '답장 확정' }));
    } catch (err) {
      setError({ at: 'confirm', message: failureMessage(err) });
    } finally {
      setBusyAt(null);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void create();
  };

  /** 한 건을 끝내고 다음 문의를 받는다: 글 칸과 결과를 비우고 맨 위로 간다. */
  const newInquiry = () => {
    setText('');
    setSaved(null);
    setView(null);
    setSkipped(null);
    setError(null);
    setReply('');
    setFormTurn((n) => n + 1);
    inquiryRef.current?.focus({ preventScroll: true });
    document.getElementById('quote-step-1')?.scrollIntoView({ block: 'start' });
  };

  const selected = view?.candidates.find((c) => c.productId === view.selectedId) ?? null;
  const confirmed = saved?.status === 'confirmed';
  const leftover = hasLeftoverPlaceholder(reply);
  const c = view?.conditions;

  // 단계 줄: 확정했으면 다 끝났다. 결과가 있을 때, 맞는 상품이 0개면 조건을 고칠 차례(2단계)이고 3단계는 살펴야 할 단계로 표시한다.
  // 맞는 상품은 있는데 아직 고르지 않았으면 고를 차례(3단계), 골랐으면 확인할 차례(5단계)다. 조건을 직접 고르는 중이면 2단계, 아니면 1단계다.
  const noMatch = view !== null && view.candidateCount === 0;
  const stage = confirmed ? 6 : view ? (noMatch ? 2 : selected ? 5 : 3) : skipped ? 2 : 1;
  const stepState = (n: number): StepState => (noMatch && !confirmed && n === 3 ? 'warn' : n < stage ? 'done' : n === stage ? 'now' : 'todo');
  const steps: StepItem[] = [
    { n: 1, label: '문의 글', state: stepState(1), href: '#quote-step-1' },
    { n: 2, label: skipped ? '조건 직접 고르기' : '뽑힌 조건', state: stepState(2), href: skipped || view ? '#quote-step-2' : null },
    { n: 3, label: '맞는 상품', note: noMatch ? '0개' : undefined, state: stepState(3), href: view ? '#quote-step-3' : null },
    { n: 4, label: '답장 초안', state: stepState(4), href: view ? '#quote-step-4' : null },
    { n: 5, label: '확인', state: stepState(5), href: view ? '#quote-step-5' : null },
  ];
  const errorAt = (...at: At[]) => (error && at.includes(error.at) ? <Notice kind="error">{error.message}</Notice> : null);

  return (
    <main className="page">
      <PageHead
        title="견적"
        lead={
          <>
            문의 글에서 조건을 뽑아 맞는 상품·총액·마감과 답장 초안을 냅니다. <strong>돈과 날짜는 코드가 셉니다.</strong> 지어낸 상품으로 돌고, 보내기는
            흉내만 냅니다.
          </>
        }
        about={
          <>
            <p>
              손님이 한국어·영어·중국어로 보낸 문의 글에서 조건을 뽑아, 등록된 상품 가운데 맞는 것과 총액·마감을 내고 답장 초안을 씁니다. 가상 마켓
              &ldquo;응원장터&rdquo;의 지어낸 상품으로 돕니다.
            </p>
            <ol className={styles.about}>
              <li><strong>AI가 하는 일은 둘</strong>입니다: 문의 글에서 조건 읽기, 답장 글 쓰기. 미리 받아 둔 답이 있으면 그것을 쓰고, 없으면 하루 상한 안에서 실제로 부릅니다.</li>
              <li><strong>돈과 날짜는 코드가 셉니다.</strong> 상품에 적힌 기간·수량 옵션의 값을 그대로 읽습니다. 옵션에 없는 기간을 날 수로 나눠 지어내지 않습니다. 부가세는 더하지도 빼지도 않고 &ldquo;부가세 별도/포함&rdquo;이라고만 적습니다.</li>
              <li>답장의 숫자와 날짜는 AI가 쓰지 않습니다. AI는 자리표시만 쓰고 코드가 값을 넣습니다.</li>
              <li><strong>보내기는 흉내만 냅니다.</strong> 메신저 연결이 없습니다. &ldquo;확정&rdquo;은 사람이 본 글을 표에 적는 것까지입니다.</li>
            </ol>
          </>
        }
      />

      <Steps label="견적 단계" items={steps} />

      <section id="quote-step-1" className={`panel ${styles.stepPanel}`} data-now={stage === 1 ? 'true' : undefined} aria-label="문의 글">
        <h2>1. 문의 글</h2>
        <form onSubmit={submit}>
          <Toolbar label="문의 글 넣기">
            <label>
              보기 문의 고르기{' '}
              <select
                value=""
                onChange={(e) => {
                  const sample = SAMPLES.find((s) => s.id === e.target.value);
                  if (sample) setText(sample.text);
                }}
              >
                <option value="">고르면 아래 칸에 들어갑니다</option>
                {SAMPLES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {QUOTE_LANG_LABELS[s.lang]} · {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              살필 상품{' '}
              <select value={catalog} disabled={toolSpace === null} onChange={(e) => setCatalogPick(e.target.value === 'public' ? 'public' : 'own')}>
                <option value="own" disabled={mounted && !workspace}>
                  내 작업 공간
                </option>
                <option value="public">본보기 공간</option>
              </select>
            </label>
          </Toolbar>
          <textarea
            ref={inquiryRef}
            className={styles.inquiry}
            aria-label="문의 글"
            rows={4}
            value={text}
            maxLength={QUOTE_LIMITS.textMaxChars}
            placeholder="예: 5월 첫 주에 생일 광고를 하고 싶어요. 예산은 300만 원이고 홍대 근처면 좋겠습니다."
            onChange={(e) => setText(e.target.value)}
          />
          <div className="actions">
            <button type="submit" className="btn primary" disabled={busy || toolSpace === null || text.trim() === ''}>
              조건 뽑고 견적 만들기
            </button>
            <button type="button" className="btn" disabled={busy || toolSpace === null} onClick={() => { setSkipped({ message: '' }); setSaved(null); setView(null); setFormTurn((n) => n + 1); }}>
              AI 없이 조건을 직접 고르기
            </button>
            {busyAt === 'create' ? <Loading label={BUSY_LABELS.create} lines={0} /> : null}
          </div>
          {/* 날짜를 고정해 보는 손잡이. 보통은 비워 둔다(오늘로 센다). 늘 쓰는 입력이 아니라서 접어 둔다. */}
          <details className="help" open={todayInput !== '' ? true : undefined}>
            <summary>다른 날짜로 계산해 보기</summary>
            <label className={`stack ${styles.today}`}>
              계산에 쓸 오늘
              <input type="date" value={todayInput} onChange={(e) => setTodayInput(e.target.value)} />
            </label>
            <p className="hint">비우면 오늘(한국 날짜)입니다. 마감이 지나는 경우를 보려면 날짜를 바꿔 보세요.</p>
          </details>
          <p className="muted small">
            {QUOTE_LIMITS.textMaxChars.toLocaleString('ko-KR')}자까지. 보기 문의 {SAMPLES.length}건은 직접 지은 글이고, 조건 뽑기 답을 미리 받아 두었습니다. 본보기 공간의 상품으로 살필 때는 답장도 미리 받아 둔 답입니다.
          </p>
        </form>
        {mounted && !workspace ? (
          <p className="muted small">
            아직 내 작업 공간이 없어 본보기 공간의 상품을 살핍니다(본보기 상품은 보기 글 일곱 건을 미리 승인해 둔 것입니다). 견적은 이때 생기는 내 작업
            공간에 저장됩니다. 본보기 공간에는 아무것도 쓰지 않습니다.
          </p>
        ) : null}
        {errorAt('create')}
      </section>

      {skipped ? (
        <section id="quote-step-2" className={`panel ${styles.stepPanel}`} data-now={stage === 2 ? 'true' : undefined} aria-label="조건 직접 고르기">
          <h2>2. 조건 직접 고르기</h2>
          {skipped.message ? (
            <Notice kind="warn">
              {skipped.message}
            </Notice>
          ) : (
            <p className="muted small">문의 글을 읽고 조건을 직접 골라 넣습니다. AI를 부르지 않습니다.</p>
          )}
          <ConditionsForm
            key={`manual-${formTurn}`}
            value={view?.conditions ?? EMPTY_CONDITIONS}
            busy={busy}
            working={busyAt === 'calc'}
            primary={!view}
            onApply={(next) => void computeLocal(next, catalog === 'own' && workspace ? 'mine' : 'public')}
          />
          {errorAt('calc')}
          <p className="muted small">
            이렇게 계산한 견적은 서버에 저장되지 않아 확정할 수 없습니다(확정은 조건 뽑기까지 된 견적에만 됩니다). 답장은 코드가 만든 틀 문장이고, 복사해서 쓸 수
            있습니다.
          </p>
        </section>
      ) : null}

      {view && c ? (
        <>
          {!skipped ? (
            <section id="quote-step-2" className={`panel ${styles.stepPanel}`} data-now={stage === 2 ? 'true' : undefined} aria-label="뽑힌 조건">
              <h2>2. 뽑힌 조건</h2>
              {saved ? <div className={`${routeClass(saved.llm.extract)} small`}>조건 뽑기: {callText(saved.llm.extract)}</div> : null}
              {saved && saved.conditions.budgetBy === 'model' && !view.local ? (
                <Notice kind="warn">예산 표현(&ldquo;{saved.extraction.budget_raw}&rdquo;)을 코드가 단위까지 읽지 못해 AI가 읽은 값을 썼습니다. 맞는지 확인해 주세요.</Notice>
              ) : null}
              {saved && saved.extraction.budget_raw && saved.conditions.budgetKrw === null && !view.local ? (
                <Notice kind="info">예산이 &ldquo;{saved.extraction.budget_raw}&rdquo;로 적혀 있습니다. 원이 아닌 돈은 환율로 바꿔 읽지 않고, 빼기 부호가 붙었거나 읽지 못한 표현도 쓰지 않습니다. 예산 조건 없이 계산했습니다.</Notice>
              ) : null}
              {c.dateProblem ? (
                <Notice kind="warn">날짜 표현{saved?.extraction.date_raw ? `("${saved.extraction.date_raw}")` : ''}을 날짜로 바꾸지 못했습니다. 날짜 조건 없이 계산했습니다. 아래에서 직접 넣어 주세요.</Notice>
              ) : null}
              {c.dateFrom && c.dateTo ? (
                <p className="muted small">
                  희망 날짜: {formatDate(c.dateFrom, 'ko')}
                  {c.dateTo !== c.dateFrom ? ` ~ ${formatDate(c.dateTo, 'ko')} (${rangeDays(c.dateFrom, c.dateTo)}일 사이)` : ''}. 마감은 이 범위의 첫날을 기준으로 셉니다. 연도가 안
                  적힌 날짜는 오늘({formatDate(view.today, 'ko')}) 뒤로 처음 오는 날로 봅니다.
                </p>
              ) : null}
              <ConditionsForm key={`edit-${formTurn}`} value={c} busy={busy} working={busyAt === 'calc'} onApply={(next) => void computeLocal(next, view.source)} />
              {errorAt('calc')}
              {view.local && saved ? (
                <p className="muted small">조건이나 고른 상품을 바꿔 브라우저에서 다시 계산한 결과입니다. 바꾼 조건은 서버에 저장되지 않습니다. 확정하면 답장 글만 저장됩니다.</p>
              ) : null}
            </section>
          ) : null}

          <section ref={resultRef} tabIndex={-1} id="quote-step-3" className={`panel ${styles.stepPanel}`} data-now={stage === 3 ? 'true' : undefined} aria-label="맞는 상품">
            <h2>
              3. 맞는 상품 <span className="count">{view.candidateCount}개 / 살핀 상품 {view.productCount}개 · {view.source === 'public' ? '본보기 공간' : '내 작업 공간'}</span>
            </h2>
            {view.productCount === 0 ? (
              <Notice kind="info">
                {view.source === 'public' ? '본보기 공간에 등록된 상품이 없습니다.' : '내 작업 공간에 등록된 상품이 없습니다.'} 견적은 승인되어 등록된 상품만 살핍니다.{' '}
                <Link href="/">작업 화면</Link>에서 글을 넣고 승인하면 상품이 생깁니다.{' '}
                {view.source === 'mine' ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => {
                      setCatalogPick('public');
                      // 서버에 저장된 견적이면 본보기 상품으로 새로 만든다(답장까지). 조건을 직접 고른 경우는 브라우저에서 다시 계산한다.
                      if (saved && !view.local) void create(undefined, 'public', 'catalog');
                      else void computeLocal(c, 'public', 'catalog');
                    }}
                  >
                    본보기 공간의 상품으로 계산해 보기
                  </button>
                ) : null}
              </Notice>
            ) : view.candidateCount === 0 ? (
              <Notice kind="info">조건에 모두 맞는 상품이 없습니다. 아래 &ldquo;빠진 상품&rdquo;에서 까닭을 보고 조건을 고쳐 보세요.</Notice>
            ) : null}
            {busyAt === 'catalog' || busyAt === 'pick' ? (
              <p className={styles.working}>
                <Loading label={BUSY_LABELS[busyAt]} lines={0} />
              </p>
            ) : null}
            {errorAt('catalog', 'pick')}
            {view.candidates.length > 0 ? (
              <div className="table-wrap flush" tabIndex={0} role="region" aria-label="맞는 상품과 총액·마감">
                <table>
                  <thead>
                    <tr>
                      <th scope="col" className="tight">고르기</th>
                      <th scope="col">상품</th>
                      <th scope="col" className="num">총액</th>
                      <th scope="col">맞은 까닭</th>
                      <th scope="col">마감(오늘 {view.today} 기준)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.candidates.map((cand) => (
                      <tr key={cand.productId} className={cand.productId === view.selectedId ? 'is-picked' : undefined}>
                        <td className={`tight ${styles.pickCell}`}>
                          {/* 칸 전체가 누르는 자리다(동그라미만 누르지 않아도 된다). */}
                          <label>
                            <input
                              type="radio"
                              name="picked"
                              aria-label={`${cand.name} 고르기`}
                              checked={cand.productId === view.selectedId}
                              disabled={busy || confirmed}
                              onChange={() => void pick(cand.productId)}
                            />
                          </label>
                        </td>
                        <th scope="row">
                          <Link href={productHref(cand.productId, view.source === 'public')}>{cand.name}</Link>
                          <span className="muted small"> {TYPE_LABELS[cand.type]} · {cand.subtype}{cand.region ? ` · ${cand.region}` : ''}</span>
                        </th>
                        <td className="num">
                          <strong className={styles.amount}>{won(cand.pricing.totalKrw)}</strong>
                          <span className={styles.vat}>{vatNote(cand.pricing.vatIncluded, 'ko') || ' (부가세 포함 여부 모름)'}</span>
                          <span className={styles.cellNote}>{pricingNote(cand, c)}</span>
                        </td>
                        <td className="small">
                          {cand.matched.length > 0 ? (
                            <span className={styles.matched}>
                              {cand.matched.map((m) => (
                                <Badge key={m}>
                                  {QUOTE_MATCH_LABELS[m]}
                                  {/* 총액이 부가세 별도면 예산과 견준 값도 부가세를 더하지 않은 값이다. 그 단서를 표에 붙인다. */}
                                  {m === 'budget' && cand.pricing.vatIncluded === false ? ' (부가세 별도 값으로 견줌)' : ''}
                                </Badge>
                              ))}
                            </span>
                          ) : cand.type === 'goods' && view.conditions.region !== null ? (
                            '이 상품에 걸 조건이 없었음(굿즈는 지역을 보지 않음)'
                          ) : (
                            '이 상품에 걸 조건이 없었음'
                          )}
                        </td>
                        <td className="small">
                          {cand.schedule.startDate === null ? (
                            <span className="muted">날짜 조건이 없어 세지 않음</span>
                          ) : cand.schedule.deadlines.length === 0 ? (
                            <span className="muted">상품에 마감 일수가 적혀 있지 않아 세지 못함</span>
                          ) : (
                            <ul className={styles.deadlines}>
                              {cand.schedule.deadlines.map((d) => (
                                <li key={d.kind}>
                                  <span>{DEADLINE_KIND_LABELS[d.kind]}</span>
                                  <span className={styles.date}>{d.date}</span>
                                  <span className={styles.left}>{d.daysLeft}일 남음</span>
                                  <Badge tone={DEADLINE_TONES[d.status]}>{DEADLINE_STATUS_LABELS[d.status]}</Badge>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {view.candidateCount > view.candidates.length ? (
              <p className="muted small">앞에서부터(총액이 작은 순서. 지역 조건이 있으면 지역이 맞은 것 먼저) {view.candidates.length}개만 보여 줍니다(맞는 상품은 모두 {view.candidateCount}개).</p>
            ) : null}
            {view.excluded.length > 0 ? (
              <details className="help">
                <summary>빠진 상품 {view.excluded.length}개와 까닭</summary>
                <ul className={`small ${styles.excluded}`}>
                  {view.excluded.map((e) => (
                    <li key={e.productId}>
                      {e.name} — {e.reasons.map((r) => QUOTE_EXCLUDE_LABELS[r]).join(', ')}
                    </li>
                  ))}
                </ul>
                <p className="muted small">
                  지역은 글자가 겹치는지만 봅니다. 지도를 모릅니다. &ldquo;서울&rdquo;이라는 조건은 &ldquo;합정역&rdquo;이라고만 적힌 지면과 맞지 않습니다. 마감은 당일까지
                  되고 하루라도 지나면 빠집니다.
                </p>
              </details>
            ) : null}
          </section>

          <section id="quote-step-4" className={`panel ${styles.stepPanel}`} aria-label="답장 초안">
            <h2>4. 답장 초안 <span className="count">{QUOTE_LANG_LABELS[c.lang]}</span></h2>
            {view.replySource === 'llm' ? (
              <div className="route route-recorded small">AI가 쓴 글에 코드가 숫자와 날짜를 넣었습니다{saved?.llm.reply ? ` · ${callText(saved.llm.reply)}` : ''}</div>
            ) : (
              <div className="route route-rules small">
                코드가 만든 틀 문장입니다
                {!view.local && saved?.llm.replySkipCause ? ` · AI를 부르지 못함: ${LLM_SKIP_LABELS[saved.llm.replySkipCause]}` : ''}
                {!view.local && saved && !saved.llm.replySkipCause && saved.llm.reply ? ' · AI가 쓴 글이 두 번 다 글 검사에 걸려 쓰지 않았습니다' : ''}
                {view.local ? ' · 브라우저에서 다시 계산해 AI를 부르지 않았습니다' : ''}
              </div>
            )}
            {!selected && !hasSearchCondition(c) ? (
              <Notice kind="info">
                문의에 종류·갈래·지역이 하나도 없어 상품을 대신 고르지 않았습니다. 아래는 무엇을 찾는지 되묻는 글입니다.{view.candidateCount > 0 ? ' 위 표에서 상품을 고르면 그 상품으로 답장을 다시 씁니다.' : ''}
              </Notice>
            ) : null}
            {view.failCodes.length === 0 ? (
              <p className="ok-line small">글 검사 통과(자리표시, 자리표시 밖 숫자, 한글 섞임, 혼잣말, 용어 표기). 검사는 숫자를 넣기 전의 글에 돌립니다.</p>
            ) : (
              <Notice kind="warn">
                글 검사에 걸린 것이 있습니다. 보내기 전에 꼭 읽어 주세요.
                <ul>
                  {view.failCodes.map((code) => (
                    <li key={code}>
                      <strong>{CONTENT_FAILS[code].label}</strong> — {CONTENT_FAILS[code].description}
                    </li>
                  ))}
                </ul>
              </Notice>
            )}
            <textarea
              className={styles.reply}
              aria-label="답장 글"
              lang={c.lang}
              value={confirmed ? (saved?.confirmedReply ?? reply) : reply}
              readOnly={confirmed}
              maxLength={QUOTE_LIMITS.replyMaxChars}
              onChange={(e) => setReply(e.target.value)}
            />
            {selected && view.local && saved && !confirmed ? (
              <div className="actions">
                <button type="button" className="btn" disabled={busy || text.trim() === ''} onClick={() => void create(selected.productId, catalog, 'reply')}>
                  이 상품으로 AI 답장 받기
                </button>
                {busyAt === 'reply' ? <Loading label={BUSY_LABELS.reply} lines={0} /> : null}
                <span className="muted small">문의 글의 조건(고치기 전)으로 새 견적을 만듭니다. 고친 조건에서만 맞는 상품이면 받지 못합니다.</span>
              </div>
            ) : null}
            {errorAt('reply')}
            {c.lang === 'zh-Hans' ? <p className="muted small">중국어 글이 자연스러운지는 이 도구가 판단하지 않습니다. 읽을 수 있는 사람이 확인해야 합니다.</p> : null}
          </section>

          <section id="quote-step-5" className={`panel ${styles.stepPanel}`} data-now={stage === 5 ? 'true' : undefined} aria-label="확인">
            <h2>5. 확인</h2>
            {confirmed && saved ? (
              <>
                <Notice kind="ok">
                  확정했습니다({saved.confirmedAt ? formatTime(saved.confirmedAt) : ''}). 견적 {saved.id}번에 사람이 본 글이 적혔습니다. <strong>어디로도 보내지 않았습니다.</strong>{' '}
                  메신저 연결이 없어 보내기는 흉내만 냅니다.
                </Notice>
                {/* 확정한 다음에 복사해 메신저에 붙인다. 그리고 다음 문의로 넘어간다. */}
                <div className="actions">
                  <CopyButton text={saved.confirmedReply ?? reply} label="답장 복사" />
                  <button type="button" className="btn primary" onClick={newInquiry}>
                    새 문의 받기
                  </button>
                </div>
              </>
            ) : (
              <>
                {leftover ? <Notice kind="warn">답장에 자리표시나 중괄호({'{ }'})가 남아 있습니다. 값으로 바꾸거나 지워야 확정할 수 있습니다.</Notice> : null}
                <div className="actions">
                  <button type="button" className="btn primary" disabled={busy || !saved || leftover || reply.trim() === ''} onClick={() => void confirm()}>
                    읽고 확정하기(보내기는 흉내만)
                  </button>
                  <CopyButton text={reply} label="답장 복사" />
                  {busyAt === 'confirm' ? <Loading label={BUSY_LABELS.confirm} lines={0} /> : null}
                  <span className="muted small">
                    {saved ? `견적 ${saved.id}번으로 저장되어 있습니다. 확정하면 이 글이 표에 적히고 다시 고칠 수 없습니다.` : '저장된 견적이 없어 확정할 수 없습니다. 글은 복사해서 쓸 수 있습니다.'}
                  </span>
                </div>
              </>
            )}
            {errorAt('confirm')}
          </section>
        </>
      ) : null}
    </main>
  );
}
