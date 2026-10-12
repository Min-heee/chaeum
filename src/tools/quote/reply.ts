// 답장의 숫자와 날짜. 모델은 {total} 같은 자리표시만 쓰고, 값은 여기서 들어간다. 순수 함수다.
// 모델을 못 불렀을 때의 틀 문장과, 답장에 대고 도는 글 검사도 여기 있다(검사 자체는 본체의 글 검사다).
import { PLACEHOLDER_PATTERN, type GlossaryEntry, type Lang } from '@/contract/content';
import { CONTENT_FAIL_CODES, type ContentFailCode } from '@/contract/reasons';
import { DEADLINE_KINDS, type DeadlineKind } from '@/contract/tools/dates';
import {
  QUOTE_PLACEHOLDERS,
  type QuoteCandidate,
  type QuoteLang,
  type QuotePlaceholder,
  type QuoteReplyInput,
  type QuoteReplyValues,
} from '@/contract/tools/quote';
import { entriesIn, termsIn, unique } from '@/content/glossary';
import { groupDigits } from '@/content/format';
import { checkContent } from '@/core/content-check';
import { hasNumberWords, numberUsedAsValue } from './number-words';

// ── 값 ─────────────────────────────────────────────────────

const DEADLINE_PLACEHOLDER: Record<DeadlineKind, QuotePlaceholder> = {
  booking: 'booking_deadline',
  material: 'material_deadline',
  design: 'design_deadline',
  order: 'order_deadline',
};

/** 답장의 자리표시에 넣을 값. 고른 상품이 없으면 빈 것. 센 것만 들어간다(세지 않은 마감은 자리표시도 없다). */
export function replyValues(candidate: QuoteCandidate | null): QuoteReplyValues {
  if (!candidate) return {};
  const values: QuoteReplyValues = { total: candidate.pricing.totalKrw };
  if (candidate.pricing.days !== null) values.days = candidate.pricing.days;
  if (candidate.pricing.qty !== null) values.qty = candidate.pricing.qty;
  if (candidate.schedule.startDate !== null) values.start_date = candidate.schedule.startDate;
  for (const kind of DEADLINE_KINDS) {
    const deadline = candidate.schedule.deadlines.find((d) => d.kind === kind);
    if (deadline) values[DEADLINE_PLACEHOLDER[kind]] = deadline.date;
  }
  return values;
}

/** 값이 있는 자리표시의 이름(약속한 순서). 모델에게 "이것만 써도 된다"고 알려 주는 목록이다. */
export function placeholdersOf(values: QuoteReplyValues): QuotePlaceholder[] {
  return QUOTE_PLACEHOLDERS.filter((p) => values[p] !== undefined);
}

// ── 서식 ───────────────────────────────────────────────────

const MONEY: Record<QuoteLang, (digits: string) => string> = {
  ko: (digits) => `${digits}원`,
  en: (digits) => `KRW ${digits}`,
  'zh-Hans': (digits) => `${digits}韩元`,
};

/**
 * 부가세 표시. 금액에 세금을 더하지 않는다. 들었는지 아닌지만 총액 옆에 적는다. 모르면(null) 아무것도 붙이지 않는다.
 * 중국어 표기는 흔히 쓰는 낱말을 골랐을 뿐이고 자연스러운지는 판단하지 않았다.
 */
const VAT_NOTE: Record<QuoteLang, { included: string; excluded: string }> = {
  ko: { included: ' (부가세 포함)', excluded: ' (부가세 별도)' },
  en: { included: ' (VAT included)', excluded: ' (VAT not included)' },
  'zh-Hans': { included: '（含增值税）', excluded: '（不含增值税）' },
};

export function vatNote(vatIncluded: boolean | null | undefined, lang: QuoteLang): string {
  if (vatIncluded === true) return VAT_NOTE[lang].included;
  if (vatIncluded === false) return VAT_NOTE[lang].excluded;
  return '';
}

/** 3000000 → "3,000,000원" / "KRW 3,000,000" / "3,000,000韩元" */
export function formatTotal(krw: number, lang: QuoteLang): string {
  return MONEY[lang](groupDigits(krw));
}

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** '2027-05-01' → "2027년 5월 1일" / "May 1, 2027" / "2027年5月1日". 꼴이 다르면 받은 그대로. */
export function formatDate(date: string, lang: QuoteLang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (lang === 'ko') return `${year}년 ${month}월 ${day}일`;
  if (lang === 'en') return `${EN_MONTHS[month - 1] ?? month} ${day}, ${year}`;
  return `${year}年${month}月${day}日`;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isQuotePlaceholder = (name: string): name is QuotePlaceholder => (QUOTE_PLACEHOLDERS as readonly string[]).includes(name);

// 통화 표시는 코드가 넣는다. 모델이 {total} 바로 앞뒤에 또 적었으면("₩{total}", "{total}원", "{total} KRW won") 겹치지 않게 뺀다.
// "원"은 낱말의 앞머리일 수 있다("{total} 원래 가격"). 뒤에 한글이 이어지면 조사 꼴("원입니다", "원에")일 때만 뗀다.
const CURRENCY_BEFORE_TOTAL = /(?:(?:KRW|₩|￦|[韩韓]元|[韩韓]币)[ \t]*)+(?=\{total\})/gi;
const WON_AFTER = '원(?:(?![가-힣])|(?=입니다|이며|이고|이에요|이라|이니|인데|이지만|으로|에서)|(?=[은을의에이도](?![가-힣])))';
const CURRENCY_AFTER_TOTAL = new RegExp(`(\\{total\\})(?:[ \\t]*(?:(?:KRW|won)(?![A-Za-z'’])|₩|￦|${WON_AFTER}|[韩韓]元|[韩韓]币|元))+`, 'gi');

/**
 * 자리표시에 값을 넣는다. 금액과 날짜는 언어별 서식으로.
 * 값이 없거나 넣을 수 없는 값이면 그 자리표시는 그대로 둔다(숫자를 지어내지 않는다). 남은 중괄호는 글 검사와 확정 단계가 잡는다.
 * vatIncluded 를 주면 총액 바로 뒤에 "부가세 별도/포함"을 붙인다. 세금을 계산해 더하지는 않는다.
 */
export function fillReply(template: string, values: QuoteReplyValues, lang: QuoteLang, options: { vatIncluded?: boolean | null } = {}): string {
  let out = template;
  if (isCount(values.total)) out = out.replace(CURRENCY_BEFORE_TOTAL, '').replace(CURRENCY_AFTER_TOTAL, '$1');
  let vatWritten = false;
  return out.replace(PLACEHOLDER_PATTERN, (whole: string, name: string) => {
    if (!isQuotePlaceholder(name)) return whole;
    const value = values[name];
    if (name === 'total') {
      if (!isCount(value)) return whole;
      // 총액이 글에 여러 번 나와도 부가세 표시는 처음 한 번만 붙인다.
      const note = vatWritten ? '' : vatNote(options.vatIncluded, lang);
      vatWritten = true;
      return `${formatTotal(value, lang)}${note}`;
    }
    if (name === 'days' || name === 'qty') return isCount(value) ? groupDigits(value) : whole;
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(value, lang) : whole;
  });
}

/** 글에 자리표시나 중괄호가 남았는가(전각 중괄호도 본다). 확정할 답장에는 남아 있으면 안 된다. */
export function hasLeftoverPlaceholder(text: string): boolean {
  return /[{}｛｝]/.test(text);
}

// ── 틀 문장 ────────────────────────────────────────────────

/** 이름·지역 속의 용어집 낱말을 그 언어의 표기로 바꾼다. 용어집에 없는 한글은 그대로 남는다(글 검사가 "한글 섞임"으로 알린다). */
export function localText(text: string, glossary: readonly GlossaryEntry[], lang: QuoteLang): string {
  if (lang === 'ko') return text;
  let out = text;
  // 긴 낱말부터 바꾼다("커피차"가 "커피"보다 먼저).
  for (const entry of [...entriesIn(text, glossary)].sort((a, b) => b.ko.length - a.ko.length)) {
    out = out.split(entry.ko).join(lang === 'en' ? ` ${entry.en} ` : entry['zh-Hans']);
  }
  out = out.replace(/\s+/g, ' ').trim();
  // 중국어는 낱말 사이를 띄우지 않는다. 한자 사이에 남은 빈칸을 뗀다.
  return lang === 'zh-Hans' ? out.replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, '') : out;
}

type Lines = {
  found: string;
  product: (name: string, region: string | null) => string;
  total: (has: { days: boolean; qty: boolean }) => string;
  start: string;
  deadline: Record<DeadlineKind, string>;
  alternatives: string;
  closing: string;
  none: string;
};

const TEMPLATE: Record<QuoteLang, Lines> = {
  ko: {
    found: '문의 주셔서 감사합니다. 말씀하신 조건에 맞는 상품을 안내드립니다.',
    product: (name, region) => `상품: ${name}${region ? ` (${region})` : ''}`,
    total: (has) => `총액: {total}${has.days ? ', 기간 {days}일' : ''}${has.qty ? ', 수량 {qty}' : ''}`,
    start: '희망 시작일: {start_date}',
    deadline: {
      booking: '예약 마감: {booking_deadline}',
      material: '소재 마감: {material_deadline}',
      design: '시안 마감: {design_deadline}',
      order: '주문 마감: {order_deadline}',
    },
    alternatives: '조건에 맞는 다른 상품도 있습니다.',
    closing: '확인하신 뒤 회신 주시면 다음 절차를 안내드리겠습니다.',
    none: '문의 주셔서 감사합니다. 지금 등록된 상품 가운데 말씀하신 조건에 모두 맞는 것을 찾지 못했습니다. 예산이나 날짜, 지역을 조금 바꿔 알려 주시면 다시 찾아보겠습니다.',
  },
  en: {
    found: 'Thank you for your inquiry. This option fits your request.',
    product: (name, region) => `Product: ${name}${region ? ` (${region})` : ''}`,
    total: (has) => `Total: {total}${has.days ? ', for {days} days' : ''}${has.qty ? ', quantity {qty}' : ''}`,
    start: 'Requested start date: {start_date}',
    deadline: {
      booking: 'Booking deadline: {booking_deadline}',
      material: 'Material deadline: {material_deadline}',
      design: 'Design deadline: {design_deadline}',
      order: 'Order deadline: {order_deadline}',
    },
    alternatives: 'Other options also fit your request.',
    closing: 'Please reply to confirm and we will guide you through the next steps.',
    none: 'Thank you for your inquiry. We could not find a registered product that fits all of your conditions. If you can adjust the budget, date, or area, we will look again.',
  },
  'zh-Hans': {
    found: '感谢您的咨询。为您推荐符合条件的方案。',
    product: (name, region) => `产品：${name}${region ? `（${region}）` : ''}`,
    total: (has) => `总价：{total}${has.days ? '，{days}天' : ''}${has.qty ? '，数量{qty}' : ''}`,
    start: '期望开始日期：{start_date}',
    deadline: {
      booking: '预约截止：{booking_deadline}',
      material: '素材截止：{material_deadline}',
      design: '设计稿截止：{design_deadline}',
      order: '下单截止：{order_deadline}',
    },
    alternatives: '另有其他符合条件的方案。',
    closing: '确认后请回复，我们将为您说明后续流程。',
    none: '感谢您的咨询。目前已登记的产品中没有找到完全符合您条件的方案。如果可以调整预算、日期或地区，我们会再次为您查找。',
  },
};

/** 무엇을 찾는지 알 수 없는 문의(종류·갈래·지역이 하나도 없음)에 되묻는 글. 상품을 대신 골라 주지 않는다. 중국어는 뜻이 통하게만 썼다. */
const ASK: Record<QuoteLang, string> = {
  ko: '문의 주셔서 감사합니다. 어떤 상품을 찾으시는지 조금 더 알려 주시면 맞는 상품과 총액을 안내드리겠습니다. 광고·케이터링·굿즈 가운데 무엇인지, 원하시는 지역과 날짜, 예산을 적어 주세요.',
  en: 'Thank you for your inquiry. Please tell us a little more about what you are looking for, and we will suggest a matching product with its total. It helps to know whether you want an ad, catering, or goods, and your preferred area, date, and budget.',
  'zh-Hans': '感谢您的咨询。请再告诉我们您想找的是哪一类（广告、餐车或周边商品），以及希望的地区、日期和预算，我们会为您推荐合适的方案和总价。',
};

/** 되묻는 답장. 자리표시가 없는 글이다. */
export function askReply(lang: QuoteLang): string {
  return ASK[lang];
}

/**
 * 모델 없이 코드가 만드는 답장(자리표시인 채). 늘 같은 글이 나온다.
 * 고른 상품이 없으면 "맞는 상품을 찾지 못했다"는 글이다. 써도 되는 자리표시(input.placeholders)만 쓴다.
 * 영어·중국어 글에서 이름과 지역은 용어집 표기로만 바꾼다. 새로 옮겨 짓지 않는다.
 */
export function templateReply(input: QuoteReplyInput): string {
  const t = TEMPLATE[input.lang];
  if (!input.product) return t.none;
  const has = (p: QuotePlaceholder) => input.placeholders.includes(p);
  const name = localText(input.product.name, input.glossary, input.lang);
  const region = input.product.region === null ? null : localText(input.product.region, input.glossary, input.lang);
  const lines = [t.found, t.product(name, region)];
  if (has('total')) lines.push(t.total({ days: has('days'), qty: has('qty') }));
  if (has('start_date')) lines.push(t.start);
  for (const kind of DEADLINE_KINDS) if (has(DEADLINE_PLACEHOLDER[kind])) lines.push(t.deadline[kind]);
  if (input.hasAlternatives) lines.push(t.alternatives);
  lines.push(t.closing);
  return lines.join('\n');
}

// ── 글 검사 ────────────────────────────────────────────────

/** 글 속의 숫자 덩어리. 본체의 글 검사가 숫자를 세는 꼴과 같다. */
const numberChunks = (text: string): string[] => text.normalize('NFKC').match(/\d+(?:[.,]\d+)*/g) ?? [];

type CheckFacts = Pick<QuoteReplyInput, 'lang' | 'product' | 'placeholders' | 'glossary'>;

/** 이 답장에 그 언어 표기로 꼭 있어야 하는 용어(상품 이름과 지역 속의 용어집 낱말). 한국어 답장에는 없다. */
export function requiredTermsOf(facts: CheckFacts): string[] {
  if (facts.lang === 'ko' || !facts.product) return [];
  const lang: Lang = facts.lang;
  return unique([...termsIn(facts.product.name, facts.glossary, lang), ...termsIn(facts.product.region, facts.glossary, lang)]);
}

/**
 * 답장(자리표시인 채의 글)을 검사한다. 걸린 코드들(약속한 순서). 빈 배열이면 통과.
 * 본체의 글 검사(checkContent)를 그대로 돌리고, 자리표시만 견적의 이름으로 본다:
 * - 자리표시: 총액을 낼 수 있는데 {total} 이 없거나, 써도 되는 목록에 없는 자리표시·깨진 중괄호가 있으면 PLACEHOLDER_LOST.
 * - 숫자: 자리표시 밖에 숫자가 있으면 STRAY_NUMBER. 상품 이름·지역·용어집 표기에 원래 있는 숫자만 봐준다.
 *   봐주는 숫자도 이름·지역 표기가 글자 그대로 들어간 자리 밖에서 금액·기간·수량·날짜로 쓰였으면 건다("9번 출구"의 9 를 "for 9 days" 로).
 *   말로 쓴 숫자("three million won", "十四天", "삼백만 원", "Ⅻ", "٣")도 건다. 목록에 있는 꼴만 본다(number-words.ts).
 * - 한글 섞임: 영어·중국어 답장에서만 본다.
 * - 혼잣말, 용어 표기: 본체와 같다. 혼잣말 규칙은 제목·요약을 보려고 만든 것이라, 답장에서는
 *   "Let me know", "I will" 같은 평범한 말도 걸린다. 프롬프트가 그 말을 피하게 한다.
 */
export function checkReply(template: string, facts: CheckFacts): ContentFailCode[] {
  const used = [...template.normalize('NFKC').matchAll(PLACEHOLDER_PATTERN)].map((m) => m[1]!);
  const allowed: readonly string[] = facts.placeholders;
  const body = template.replace(PLACEHOLDER_PATTERN, ' ');
  const lang: Lang = facts.lang === 'ko' ? 'en' : facts.lang;
  const numbered = facts.product ? [facts.product.name, facts.product.region ?? '', ...facts.glossary.map((e) => e[lang])] : [];
  const allowedNumbers = unique(
    numbered.flatMap(numberChunks).flatMap((chunk) => {
      const bare = chunk.replace(/,/g, '');
      return /^\d+$/.test(bare) ? [chunk, bare, groupDigits(Number(bare))] : [chunk, bare];
    }),
  );
  const fails = new Set<ContentFailCode>(
    checkContent({ lang, field: 'summary', text: body, requiredPlaceholders: [], requiredTerms: requiredTermsOf(facts), allowedNumbers }),
  );
  if (facts.lang === 'ko') fails.delete('HANGUL_IN_TEXT');
  if (!fails.has('EMPTY_TEXT')) {
    // 이름·지역 표기(원래 글자와 그 언어로 바꾼 글자)가 그대로 들어간 자리를 떼고 본다. 긴 것부터 뗀다.
    const literal = unique(numbered.flatMap((text) => [text, localText(text, facts.glossary, facts.lang)]).filter((text) => text !== ''));
    const rest = literal.sort((a, b) => b.length - a.length).reduce((text, name) => text.split(name).join(' '), body.normalize('NFKC'));
    if (hasNumberWords(body) || numberUsedAsValue(rest, allowedNumbers)) fails.add('STRAY_NUMBER');
  }
  if (!fails.has('EMPTY_TEXT')) {
    const missingTotal = allowed.includes('total') && !used.includes('total');
    if (missingTotal || used.some((p) => !allowed.includes(p))) fails.add('PLACEHOLDER_LOST');
  }
  return CONTENT_FAIL_CODES.filter((code) => fails.has(code));
}

const FIX: Record<ContentFailCode, (facts: CheckFacts) => string> = {
  PLACEHOLDER_LOST: (facts) =>
    facts.placeholders.length > 0
      ? `자리표시는 ${facts.placeholders.map((p) => `{${p}}`).join(', ')} 만 중괄호째 그대로 쓴다.${facts.placeholders.includes('total') ? ' {total} 은 꼭 넣는다.' : ''} 그 밖의 자리표시나 중괄호는 쓰지 않는다.`
      : '자리표시와 중괄호를 쓰지 않는다.',
  // 이 글은 다시 부르는 요청에 그대로 실린다. 고치면 받아 둔 답(녹화)의 요청 키가 달라진다. 말로 쓴 숫자를 막는 문장은 프롬프트의 다음 판에 넣는다.
  STRAY_NUMBER: () => '숫자를 직접 쓰지 않는다. 금액·기간·수량·날짜는 자리표시로만 적는다. 문의 글에 있던 숫자도 옮겨 적지 않는다.',
  HANGUL_IN_TEXT: () => '한글을 쓰지 않는다. 용어집에 없는 고유한 이름은 로마자로 적는다.',
  EMPTY_TEXT: () => '글이 비었다. 글을 쓴다.',
  MONOLOGUE: () => '머리말·설명·따옴표·글머리표·굵게 표시 없이 답장 글만 적는다. "I will", "Let me", "Here is", "希望…" 같은 말은 쓰지 않는다.',
  GLOSSARY_MISS: (facts) => `용어집 표기 ${requiredTermsOf(facts).map((t) => `"${t}"`).join(', ')} 를 글자 그대로 넣는다.`,
};

/** 걸린 검사를 알려 주는 말(프롬프트의 retryHint). 숫자 값은 넣지 않는다. */
export function replyRetryHint(failCodes: readonly ContentFailCode[], facts: CheckFacts): string {
  return ['지난번 답장이 검사에 걸렸다. 아래를 고쳐 답장을 다시 쓴다.', ...failCodes.map((code) => `- ${FIX[code](facts)}`)].join('\n');
}

/** 답장 요청의 입력을 만든다. 숫자는 넣지 않는다(자리표시의 이름만 넣는다). 한국어 답장이면 용어집은 비운다. */
export function replyInputOf(args: {
  lang: QuoteLang;
  inquiry: string;
  candidate: QuoteCandidate | null;
  candidateCount: number;
  /** 이 상품에 해당하는 용어집 줄(부르는 쪽이 본체의 pickGlossary 로 고른다) */
  glossary: readonly GlossaryEntry[];
}): QuoteReplyInput {
  const { candidate } = args;
  return {
    lang: args.lang,
    inquiry: args.inquiry,
    product: candidate ? { name: candidate.name, type: candidate.type, subtype: candidate.subtype, region: candidate.region } : null,
    placeholders: placeholdersOf(replyValues(candidate)),
    hasAlternatives: candidate !== null && args.candidateCount > 1,
    glossary: args.lang === 'ko' ? [] : [...args.glossary],
  };
}
