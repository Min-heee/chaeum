// 상품 하나를 살핀다. 새 규칙은 없다. 본체의 구조 규칙(src/core 의 checkRequired·checkRange·checkStructure)과
// 끝 글 검사(src/content 의 checkTranslations — 글 검사 5종)를 그대로 부르고, 걸린 것을 사람이 읽는 줄로 옮길 뿐이다.
import { LANG_LABELS, type GlossaryEntry, type Lang, type TextField } from '@/contract/content';
import { fieldDef, FIELDS_BY_TYPE, TYPE_LABELS, type FieldKey, type FieldValues } from '@/contract/fields';
import { CONTENT_FAIL_CODES, CONTENT_FAILS, type ContentFailCode, type ReasonCode } from '@/contract/reasons';
import {
  AUDIT_CODE_DEFS,
  AUDIT_CODES,
  AUDIT_SEVERITIES,
  AUDIT_STRUCTURE_CODES,
  type AuditCode,
  type AuditFinding,
  type AuditSubject,
} from '@/contract/tools/audit';
import { entriesIn, includesTerm, termsIn, unique } from '@/content/glossary';
import { placeholderValuesOf } from '@/content/placeholder-values';
import { numberChunks } from '@/content/line-check';
import { checkTranslations } from '@/content/translation-check';
import { checkRange, checkRequired, checkStructure } from '@/core';

/** 다른 언어 글의 자리 넷. 양식의 글 자리 이름과 같다. 순서는 언어 × 칸(영어 제목, 영어 요약, 중국어 제목, 중국어 요약). */
export const TEXT_SLOTS = [
  { slot: 'title_en', lang: 'en', field: 'title' },
  { slot: 'summary_en', lang: 'en', field: 'summary' },
  { slot: 'title_zh', lang: 'zh-Hans', field: 'title' },
  { slot: 'summary_zh', lang: 'zh-Hans', field: 'summary' },
] as const satisfies readonly { slot: keyof AuditSubject['texts']; lang: Lang; field: TextField }[];
export type TextSlot = (typeof TEXT_SLOTS)[number]['slot'];

const TEXT_FIELD_LABELS: Record<TextField, string> = { title: '제목', summary: '요약' };

/** 칸 이름 → 화면 이름. 모르는 이름은 그대로 적는다. */
const AUDIT_FIELD_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(FIELDS_BY_TYPE)
    .flat()
    .map((key) => [key, fieldDef(key).label]),
);

export interface AuditOptions {
  /**
   * 살필 수 있는 자리(칸 이름과 글 자리 이름). 파일에 그 열이 아예 없으면 값이 빈 것인지 알 수 없으므로 살피지 않는다.
   * 안 주면 전부 살핀다(공간의 상품은 모든 칸이 있다).
   */
  covered?: ReadonlySet<string>;
}

const finding = (code: AuditCode, field: string | null, message: string): AuditFinding => ({
  code,
  severity: AUDIT_CODE_DEFS[code].severity,
  field,
  message,
});

/** 값을 한 줄로 보여 준다. 길면 자른다. */
function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return [...text].length > 60 ? `${[...text].slice(0, 60).join('')}…` : text;
}

const STRUCTURE_MESSAGES: Record<(typeof AUDIT_STRUCTURE_CODES)[number], (label: string, value: unknown) => string> = {
  REQUIRED_MISSING: (label) => `${label}: 꼭 있어야 하는 칸인데 비었습니다.`,
  EMPTY_REQUIRED_OPTIONS: (label) => `${label}: 고를 것이 0개입니다.`,
  TYPE_SUBTYPE_MISMATCH: () => '',
  PLACEHOLDER_VALUE: (label, value) => `${label}: 자리 채움 글자가 값으로 들어 있습니다("${shown(value)}").`,
  OUT_OF_RANGE: (label, value) => `${label}: 값이 말이 안 됩니다(지금 값 ${shown(value)}).`,
};

const isStructureCode = (code: ReasonCode): code is (typeof AUDIT_STRUCTURE_CODES)[number] =>
  (AUDIT_STRUCTURE_CODES as readonly ReasonCode[]).includes(code);

/** 칸 규칙: 필수 칸, 값 범위, 옵션 0개, 자리 채움 글자, 종류·갈래. 종류를 모르면 종류 문제만 낸다. */
function structureFindings(subject: AuditSubject, covered: ReadonlySet<string> | undefined): AuditFinding[] {
  const { type, subtype } = subject;
  if (type === null) {
    return [finding('TYPE_SUBTYPE_MISMATCH', null, '종류를 알 수 없습니다. 이 줄의 칸 규칙은 돌리지 않았습니다.')];
  }
  const keys = FIELDS_BY_TYPE[type].filter((key) => (covered ? covered.has(key) : true));
  const values: FieldValues = {};
  for (const key of keys) values[key] = (subject.values[key] ?? null) as FieldValues[FieldKey];

  const structure = checkStructure({ sourceText: '', type, subtype, raws: {}, values });
  const byField = [checkRequired(type, values), structure.fieldReasons, checkRange(type, values)];

  const out: AuditFinding[] = [];
  if (structure.draftReasons.includes('TYPE_SUBTYPE_MISMATCH')) {
    const what = subtype === null ? '갈래가 비었습니다' : `${TYPE_LABELS[type]}에 없는 갈래입니다("${shown(subtype)}")`;
    out.push(finding('TYPE_SUBTYPE_MISMATCH', null, `종류·갈래: ${what}.`));
  }
  for (const key of keys) {
    // 읽지 못한 칸은 값이 빈 것이 아니라 모르는 것이다. "읽지 못한 칸" 하나로만 알린다.
    if (subject.unreadable.includes(key)) continue;
    const codes = unique(byField.flatMap((reasons) => reasons[key] ?? []));
    for (const code of codes) {
      if (isStructureCode(code)) out.push(finding(code, key, STRUCTURE_MESSAGES[code](fieldDef(key).label, values[key])));
    }
  }
  return out;
}

/** 값 속의 숫자 덩어리. */
function numbersIn(value: unknown): string[] {
  if (typeof value === 'number') return [String(value)];
  if (typeof value === 'string') return numberChunks(value);
  return [];
}

/**
 * 글에 나와도 되는 상품의 숫자: 본체가 자리표시로 넣는 값(판매가, 가장 짧은 기간, 가장 적은 수량·최소 주문 수량)뿐이다.
 * 고르는 규칙은 글 만들기와 같은 함수(placeholderValuesOf)다. 다른 옵션의 값, 해상도, 크기, 송출 횟수는 글에 나오면 어긋난 숫자다.
 */
function placeholderNumbers(subject: AuditSubject): string[] {
  const { values } = subject;
  if (subject.type === null) return numbersIn(values.price_krw);
  const options = [values.period_options, values.quantity_options].flatMap((o) => (Array.isArray(o) ? o : []));
  const filled = placeholderValuesOf({ type: subject.type, price_krw: values.price_krw as number, spec: values, options });
  return Object.values(filled).flatMap(numbersIn);
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/** 광고 지면은 위치, 케이터링은 출장 지역. 굿즈는 없다(본체의 글 만들기가 보는 것과 같다). */
export function regionOfSubject(subject: Pick<AuditSubject, 'type' | 'values'>): string | null {
  if (subject.type === 'ad') return text(subject.values.region);
  if (subject.type === 'catering') return text(subject.values.service_region);
  return null;
}

const bare = (n: string): string => n.normalize('NFKC').replace(/,/g, '');

const CONTENT_MESSAGES: Record<ContentFailCode, string> = {
  PLACEHOLDER_LOST: '숫자가 들어갈 자리표시({price} 같은 것)나 중괄호가 글에 그대로 남았습니다.',
  STRAY_NUMBER: '글에 적힌 숫자가 이 상품의 어느 값과도 맞지 않습니다',
  HANGUL_IN_TEXT: '다른 언어 글에 한글이 섞였습니다.',
  EMPTY_TEXT: '글이 비었거나 점·줄표뿐입니다.',
  MONOLOGUE: '모델의 혼잣말이나 머리말, 꾸밈 표시가 글에 남았습니다.',
  GLOSSARY_MISS: '용어 사전에 정한 표기가 글에 없습니다',
};

/**
 * 글 규칙: 자리마다 끝 글 검사를 돌린다. 제목에는 이름 속 낱말의 표기가, 요약에는 이름과 지역 속 낱말의 표기가 있어야 한다
 * (본체가 글을 만들 때 보는 것과 같다). 글 줄이 없으면 빈 번역이다.
 * 공간의 상품이면 본체가 저장한 글 상태도 읽는다. "확인 필요"로 저장된 글은 지금 글자가 검사를 통과해도 문제로 낸다.
 */
function contentFindings(subject: AuditSubject, glossary: readonly GlossaryEntry[], covered: ReadonlySet<string> | undefined): AuditFinding[] {
  const name = text(subject.values.name);
  const region = regionOfSubject(subject);
  // 글 만들기가 모델에게 알려 주는 용어집 줄(종류 이름·갈래·이름·지역에 든 낱말). 그 표기에 든 숫자는 글에 나와도 된다.
  const facts = [subject.type ? TYPE_LABELS[subject.type] : null, subject.subtype, name, region];
  const known = unique(facts.flatMap((fact) => entriesIn(fact, glossary)));
  // 이름·지역에 원래 든 숫자("4번 출구")도 글에 나와도 된다.
  const fromValues = [...placeholderNumbers(subject), ...numbersIn(name), ...numbersIn(region)];

  const out: AuditFinding[] = [];
  for (const { slot, lang, field } of TEXT_SLOTS) {
    if (covered && !covered.has(slot)) continue;
    const where = `${LANG_LABELS[lang]} ${TEXT_FIELD_LABELS[field]}`;
    const body = subject.texts[slot];
    if (body === undefined) {
      out.push(finding('EMPTY_TEXT', slot, `${where}: 글이 없습니다.`));
      continue;
    }
    const requiredTerms = unique([...termsIn(name, glossary, lang), ...(field === 'summary' ? termsIn(region, glossary, lang) : [])]);
    const allowedNumbers = unique([...fromValues, ...known.flatMap((entry) => numberChunks(entry[lang]))]);
    const result = checkTranslations({ items: [{ lang, field, text: body, requiredTerms, allowedNumbers }] }, glossary).results[0];
    for (const code of CONTENT_FAIL_CODES.filter((c) => result?.failCodes.includes(c))) {
      let detail = CONTENT_MESSAGES[code];
      if (code === 'GLOSSARY_MISS') {
        detail += `: ${requiredTerms.filter((term) => !includesTerm(body, term)).map((term) => `"${term}"`).join(', ')}.`;
      } else if (code === 'STRAY_NUMBER') {
        const allowed = new Set(allowedNumbers.map(bare));
        detail += `: ${unique(numberChunks(body).filter((n) => !allowed.has(bare(n)))).join(', ')}.`;
      }
      out.push(finding(code, slot, `${where}: ${detail}`));
    }
    // 본체가 저장한 상태. 틀 문장은 지금의 글 검사를 통과하기도 해서 글자만 봐서는 드러나지 않는다.
    const stored = subject.stored?.[slot];
    if (stored?.status === 'needs_review') {
      const why =
        stored.failCodes.length > 0
          ? `모델이 마지막으로 쓴 글이 걸린 검사: ${stored.failCodes.map((code) => CONTENT_FAILS[code].label).join(', ')}`
          : '모델을 부르지 못했습니다';
      const what = stored.source === 'template' ? '모델 글 대신 코드의 틀 문장이 들어가 있습니다' : '확인이 필요한 글로 저장돼 있습니다';
      out.push(finding('TEXT_NEEDS_REVIEW', slot, `${where}: ${what}(${why}). 사람이 읽어 봐야 합니다.`));
    }
  }
  return out;
}

/**
 * 상품 하나의 문제 목록. 값 문제(error)가 먼저, 그 안에서는 코드 목록 순서다.
 * 승인된 용어(glossary)는 부르는 쪽이 넘긴다.
 */
export function auditSubject(subject: AuditSubject, glossary: readonly GlossaryEntry[], options: AuditOptions = {}): AuditFinding[] {
  const unreadable = unique(subject.unreadable).map((key) => {
    const label = AUDIT_FIELD_LABELS[key] ?? key;
    return finding('UNREADABLE_CELL', key, `${label}: 칸을 양식 꼴대로 읽지 못했습니다. 값을 짐작하지 않고 비워 두었습니다.`);
  });
  const all = [...structureFindings(subject, options.covered), ...contentFindings(subject, glossary, options.covered), ...unreadable];
  const rank = (f: AuditFinding) => AUDIT_SEVERITIES.indexOf(f.severity) * AUDIT_CODES.length + AUDIT_CODES.indexOf(f.code);
  // 같은 코드 안에서는 만든 순서(칸 순서)가 남는다. 정렬은 자리를 지킨다.
  return all.sort((a, b) => rank(a) - rank(b));
}
