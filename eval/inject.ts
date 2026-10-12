// 주입 시험(EVAL-SPEC 10절). 맞는 값과 통과하는 글을 일부러 망가뜨린 뒤 검사기가 잡는지 본다.
// 모델을 부르지 않는다(비용 0). 검사기를 재는 것이지 모델을 재는 것이 아니다.
//
//   npm run eval:inject                         씨앗 20261012, 값 종류마다 30곳
//   npm run eval:inject -- --seed 7 --per-kind 50
//
// 값 넷의 재료: 연습 세트의 원문에서 규칙으로 찾은 표현 가운데, 코드가 맞춘 값이 정답과 일치하는 칸.
//   그 칸들로 "틀린 데가 없는 뽑기 답"을 만들고, 한 곳만 망가뜨려 evaluateDraft 에 넣는다.
//   "잡았다" = 망가뜨린 칸에 막는 사유가 하나 이상 붙었다. 원래부터 표시가 붙던 칸은 재료에서 뺀다.
// 글 넷의 재료: 글 검사를 통과하게 직접 지은 제목·요약(eval/inject-material.ts).
//   "잡았다" = 글 검사 실패 코드가 하나 이상 나왔다.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Placeholder } from '@/contract/content';
import { INJECTION_KINDS, type GoldDoc, type InjectionKind, type InjectionReport } from '@/contract/eval-types';
import { fieldDef, type ExtractedField, type Extraction, type FieldKey, type FieldValue, type PeriodOption, type SizeM } from '@/contract/fields';
import { hasBlocking, type ContentFailCode, type ReasonCode } from '@/contract/reasons';
import { checkContent, declaredMoneyUnits, evaluateDraft, normalizeField, rulesExtract } from '@/core';
import { cleanText } from '@/server/limits';
import { HANGUL_WORDS, MONOLOGUES, NUMBER_FOR, TEXT_CASES, type TextCase } from './inject-material';
import { loadSplit, parseArgs, RESULTS_DIR } from './io';
import { formatRatio, isNone, valuesMatch } from './metrics';

/** 잡을 것으로 보는 사유. 예상일 뿐이고, 채점은 "하나라도 붙었는가"로 한다. */
export const EXPECTED: Record<InjectionKind, readonly string[]> = {
  zero_added: ['VALUE_MISMATCH'],
  unit_swap: ['VALUE_MISMATCH', 'OUT_OF_RANGE'],
  fake_evidence: ['NO_EVIDENCE'],
  cheaper_longer: ['OUT_OF_RANGE'],
  monologue: ['MONOLOGUE'],
  glossary_swap: ['GLOSSARY_MISS'],
  placeholder_removed: ['PLACEHOLDER_LOST', 'STRAY_NUMBER'],
  hangul_mixed: ['HANGUL_IN_TEXT'],
};

export const KIND_LABELS: Record<InjectionKind, string> = {
  zero_added: '금액에 0 하나 더',
  unit_swap: 'm ↔ mm 뒤바꿈',
  fake_evidence: '원문에 없는 근거',
  cheaper_longer: '기간이 길수록 싸지는 값',
  monologue: '혼잣말 넣기',
  glossary_swap: '용어 바꾸기',
  placeholder_removed: '자리표시 지우기',
  hangul_mixed: '한글 섞기',
};

// ── 씨앗을 고정한 난수 ─────────────────────────────────────

/** mulberry32. 같은 씨앗이면 같은 수열이 나온다. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length)]!;
}

/** 앞에서 n 개를 고른다(섞은 뒤). */
function sample<T>(items: readonly T[], n: number, rand: () => number): T[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n);
}

// ── 값 재료 ────────────────────────────────────────────────

interface CleanDoc {
  id: string;
  sourceText: string;
  extraction: Extraction;
  /** 망가뜨리기 전에 표시가 붙지 않은 칸(재료로 쓸 수 있는 칸) */
  quiet: FieldKey[];
  /** 망가뜨리기 전부터 표시가 붙은 칸 */
  noisy: FieldKey[];
}

/**
 * 문서 하나에서 "틀린 데가 없는 뽑기 답"을 만든다.
 * 규칙으로 찾은 표현 가운데 코드가 맞춘 값이 정답과 일치하는 칸만 남긴다. 모델 값 자리에는 그 맞춘 값을 넣는다.
 */
export function cleanDocOf(doc: GoldDoc): CleanDoc | null {
  if (doc.truth.type === 'not_product') return null;
  const sourceText = cleanText(doc.content);
  const fields: ExtractedField[] = [];
  for (const f of rulesExtract(sourceText).fields) {
    const truth = doc.truth.fields[f.field];
    if (f.raw === null || isNone(truth)) continue;
    // 초안을 따질 때와 같은 단위로 맞춘다(가까이에 "단위: 천원"이 있으면 그것을 따른다).
    const value = normalizeField(f.field, f.raw, declaredMoneyUnits(sourceText, [f.evidence, f.raw])).value;
    if (value !== null && valuesMatch(f.field, truth, value)) fields.push({ field: f.field, raw: f.raw, value, evidence: f.evidence });
  }
  if (fields.length === 0) return null;
  const extraction: Extraction = { type: doc.truth.type, subtype: doc.truth.subtype, fields };
  const evaluated = evaluateDraft({ sourceText, extraction, extractedBy: 'llm' });
  const has = new Set(fields.map((f) => f.field));
  const mine = evaluated.fields.filter((f) => has.has(f.field));
  return {
    id: doc.id,
    sourceText,
    extraction,
    quiet: mine.filter((f) => !hasBlocking(f.reasons)).map((f) => f.field),
    noisy: mine.filter((f) => hasBlocking(f.reasons)).map((f) => f.field),
  };
}

export interface InjectionDetail {
  kind: InjectionKind;
  /** 'dev-001/price_krw' 또는 글 재료의 번호 */
  target: string;
  /** 무엇을 어떻게 바꿨는지 한 줄 */
  change: string;
  caught: boolean;
  /** 망가뜨린 곳에 붙은 사유(값) 또는 실패 코드(글) */
  codes: string[];
  /** 잡을 것으로 본 사유로 잡혔는가 */
  asExpected: boolean;
}

/** 칸 하나를 바꾼 뽑기 답을 따져, 그 칸에 붙은 사유를 낸다. */
function reasonsAfter(doc: CleanDoc, field: FieldKey, patch: Partial<ExtractedField>, sourceText = doc.sourceText): ReasonCode[] {
  const extraction: Extraction = {
    ...doc.extraction,
    fields: doc.extraction.fields.map((f) => (f.field === field ? { ...f, ...patch } : f)),
  };
  const evaluated = evaluateDraft({ sourceText, extraction, extractedBy: 'llm' });
  return evaluated.fields.find((f) => f.field === field)?.reasons ?? [];
}

function valueDetail(kind: InjectionKind, doc: CleanDoc, field: FieldKey, change: string, reasons: ReasonCode[]): InjectionDetail {
  const blocking = reasons.filter((r) => hasBlocking([r]));
  return {
    kind,
    target: `${doc.id}/${field}`,
    change,
    caught: blocking.length > 0,
    codes: reasons,
    asExpected: blocking.some((r) => EXPECTED[kind].includes(r)),
  };
}

const valueOf = (doc: CleanDoc, field: FieldKey) => doc.extraction.fields.find((f) => f.field === field)!.value;
const won = (n: number) => `${n.toLocaleString('en-US')}원`;

/** 금액 끝에 0 을 하나 더 붙인다. 원문 표현은 그대로다. */
function zeroAdded(doc: CleanDoc, field: FieldKey): InjectionDetail {
  const before = valueOf(doc, field) as number;
  return valueDetail('zero_added', doc, field, `${before} → ${before * 10}`, reasonsAfter(doc, field, { value: before * 10 }));
}

/** 크기 값을 1000배 또는 1/1000 로 바꾼다. mm 칸은 정수여야 하므로 1000배만 한다. */
function unitSwap(doc: CleanDoc, field: FieldKey, rand: () => number): InjectionDetail {
  const before = valueOf(doc, field) as SizeM;
  const factor = field === 'size_m' && rand() < 0.5 ? 0.001 : 1000;
  const round = (n: number) => Math.round(n * factor * 1e6) / 1e6;
  const after = { width: round(before.width), height: round(before.height) };
  return valueDetail('unit_swap', doc, field, `${before.width}×${before.height} → ${after.width}×${after.height}`, reasonsAfter(doc, field, { value: after as FieldValue }));
}

/** 근거 구절을 원문에 없는 문장으로 바꾼다. */
function fakeEvidence(doc: CleanDoc, field: FieldKey): InjectionDetail {
  const evidence = '이 구절은 원문 어디에도 없는 문장입니다';
  return valueDetail('fake_evidence', doc, field, '근거 구절을 원문에 없는 문장으로', reasonsAfter(doc, field, { evidence }));
}

/**
 * 가장 긴 기간의 총액을 가장 짧은 기간보다 작게 바꾼다.
 * 범위 검사를 보려는 것이므로 원문도 그렇게 적혀 있는 것으로 한다(바꾼 표현을 원문 끝에 한 줄 덧붙인다).
 * 모델 값만 바꾸면 값 불일치로 잡혀 버려서 범위 검사를 잴 수 없다.
 */
function cheaperLonger(doc: CleanDoc): InjectionDetail {
  const options = [...(valueOf(doc, 'period_options') as PeriodOption[])].sort((a, b) => a.days - b.days);
  const first = options[0]!;
  const last = options[options.length - 1]!;
  const cheaper = Math.max(1000, Math.floor((first.price_krw * 0.9) / 1000) * 1000);
  const after = options.map((o) => (o === last ? { ...o, price_krw: cheaper } : o));
  const raw = after.map((o) => `${o.days}일 ${won(o.price_krw)}`).join(' / ');
  const reasons = reasonsAfter(doc, 'period_options', { raw, value: after, evidence: raw }, `${doc.sourceText}\n${raw}`);
  return valueDetail('cheaper_longer', doc, 'period_options', `${last.days}일 ${won(last.price_krw)} → ${won(cheaper)} (${first.days}일은 ${won(first.price_krw)})`, reasons);
}

// ── 글 재료 ────────────────────────────────────────────────

const checkCase = (c: TextCase, text: string): ContentFailCode[] =>
  checkContent({
    lang: c.lang,
    field: c.field,
    text,
    requiredPlaceholders: c.requiredPlaceholders,
    requiredTerms: [c.term],
    allowedNumbers: c.allowedNumbers,
  });

function textDetail(kind: InjectionKind, c: TextCase, change: string, text: string): InjectionDetail {
  const codes = checkCase(c, text);
  return { kind, target: c.id, change, caught: codes.length > 0, codes, asExpected: codes.some((code) => EXPECTED[kind].includes(code)) };
}

function monologue(c: TextCase, rand: () => number): InjectionDetail {
  const set = MONOLOGUES[c.lang];
  if (rand() < 0.5) {
    const phrase = pick(set.before, rand);
    return textDetail('monologue', c, `앞에 "${phrase.trim()}"`, `${phrase}${c.text}`);
  }
  const phrase = pick(set.after, rand);
  return textDetail('monologue', c, `뒤에 "${phrase.trim()}"`, `${c.text}${phrase}`);
}

function glossarySwap(c: TextCase): InjectionDetail {
  const at = c.text.toLowerCase().indexOf(c.term.toLowerCase());
  const text = `${c.text.slice(0, at)}${c.swapTo}${c.text.slice(at + c.term.length)}`;
  return textDetail('glossary_swap', c, `"${c.term}" → "${c.swapTo}"`, text);
}

function placeholderRemoved(c: TextCase, rand: () => number): InjectionDetail {
  const name: Placeholder = pick(c.requiredPlaceholders, rand);
  const asNumber = rand() < 0.5;
  const text = c.text.replace(`{${name}}`, asNumber ? NUMBER_FOR[name] : '');
  return textDetail('placeholder_removed', c, asNumber ? `{${name}} 를 숫자 ${NUMBER_FOR[name]} 로` : `{${name}} 를 지움`, text);
}

function hangulMixed(c: TextCase, rand: () => number): InjectionDetail {
  const word = pick(HANGUL_WORDS, rand);
  // 글 가운데쯤에 넣는다. 자리표시 안에는 넣지 않는다.
  let at = Math.floor(c.text.length / 2);
  const open = c.text.lastIndexOf('{', at);
  const close = c.text.indexOf('}', at);
  if (open >= 0 && close >= 0 && c.text.indexOf('}', open) === close) at = close + 1;
  if (c.lang === 'en') {
    const space = c.text.indexOf(' ', at);
    at = space >= 0 ? space : c.text.length;
  }
  const text = c.lang === 'en' ? `${c.text.slice(0, at)} ${word}${c.text.slice(at)}` : `${c.text.slice(0, at)}${word}${c.text.slice(at)}`;
  return textDetail('hangul_mixed', c, `가운데에 "${word}"`, text);
}

// ── 한 번 돌리기 ───────────────────────────────────────────

export interface InjectionRun {
  seed: number;
  perKind: number;
  /** 종류별: 검사기가 잡은 수 / 넣은 수 */
  report: InjectionReport;
  /** 종류별: 잡기는 했는데 예상과 다른 사유로 잡힌 수 */
  caughtByOther: Record<InjectionKind, number>;
  /** 망가뜨리기 전의 헛경보 */
  untouched: {
    /** 재료가 된 문서 수 / 값이 정답과 일치한 칸 수 / 그 가운데 원래부터 표시가 붙은 칸 수 */
    docs: number;
    cells: number;
    flaggedCells: number;
    /** 글 재료 수 / 그 가운데 망가뜨리기 전부터 검사에 걸린 글 */
    texts: number;
    failingTexts: string[];
  };
  details: InjectionDetail[];
}

export function runInjection(docs: readonly GoldDoc[], options: { seed: number; perKind: number }): InjectionRun {
  const rand = seededRandom(options.seed);
  const clean = docs.map(cleanDocOf).filter((d): d is CleanDoc => d !== null);
  const details: InjectionDetail[] = [];

  const targets = (want: (doc: CleanDoc, field: FieldKey) => boolean) =>
    clean.flatMap((doc) => doc.quiet.filter((field) => want(doc, field)).map((field) => ({ doc, field })));

  for (const t of sample(targets((_, f) => fieldDef(f).kind === 'money'), options.perKind, rand)) details.push(zeroAdded(t.doc, t.field));
  for (const t of sample(targets((_, f) => f === 'size_m' || f === 'size_mm'), options.perKind, rand)) details.push(unitSwap(t.doc, t.field, rand));
  for (const t of sample(targets(() => true), options.perKind, rand)) details.push(fakeEvidence(t.doc, t.field));
  const withOptions = targets((doc, f) => f === 'period_options' && (valueOf(doc, f) as PeriodOption[]).length >= 2);
  for (const t of sample(withOptions, options.perKind, rand)) details.push(cheaperLonger(t.doc));

  // 글: 망가뜨리기 전부터 걸리는 글은 재료에서 빼고 따로 적는다.
  const failingTexts = TEXT_CASES.filter((c) => checkCase(c, c.text).length > 0).map((c) => c.id);
  const texts = TEXT_CASES.filter((c) => !failingTexts.includes(c.id));
  for (const c of texts) details.push(monologue(c, rand));
  for (const c of texts) details.push(glossarySwap(c));
  for (const c of texts.filter((x) => x.requiredPlaceholders.length > 0)) details.push(placeholderRemoved(c, rand));
  for (const c of texts) details.push(hangulMixed(c, rand));

  const report = {} as InjectionReport;
  const caughtByOther = {} as Record<InjectionKind, number>;
  for (const kind of INJECTION_KINDS) {
    const mine = details.filter((d) => d.kind === kind);
    report[kind] = { num: mine.filter((d) => d.caught).length, den: mine.length };
    caughtByOther[kind] = mine.filter((d) => d.caught && !d.asExpected).length;
  }
  return {
    seed: options.seed,
    perKind: options.perKind,
    report,
    caughtByOther,
    untouched: {
      docs: clean.length,
      cells: clean.reduce((n, d) => n + d.quiet.length + d.noisy.length, 0),
      flaggedCells: clean.reduce((n, d) => n + d.noisy.length, 0),
      texts: TEXT_CASES.length,
      failingTexts,
    },
    details,
  };
}

/** 사람이 읽는 글. 못 잡은 것을 숨기지 않는다. */
export function formatInjection(run: InjectionRun): string {
  const lines: string[] = [];
  lines.push(`주입 시험 — 씨앗 ${run.seed}, 값 종류마다 최대 ${run.perKind}곳. 모델 호출 0번.`);
  lines.push('');
  lines.push('| 종류 | 잡은 수 / 넣은 수 | 예상과 다른 사유로 잡힘 | 잡을 것으로 본 사유 |');
  lines.push('|---|---|---|---|');
  for (const kind of INJECTION_KINDS) {
    lines.push(`| ${KIND_LABELS[kind]} \`${kind}\` | ${formatRatio(run.report[kind])} | ${run.caughtByOther[kind]} | ${EXPECTED[kind].join(', ')} |`);
  }
  lines.push('');
  const u = run.untouched;
  lines.push(`망가뜨리기 전(헛경보): 값 재료 ${u.cells}칸(문서 ${u.docs}건) 가운데 원래부터 표시가 붙은 칸 ${u.flaggedCells}칸 — 이 칸들은 망가뜨릴 곳에서 뺐다.`);
  lines.push(`망가뜨리기 전(헛경보): 글 재료 ${u.texts}줄 가운데 원래부터 검사에 걸린 글 ${u.failingTexts.length}줄${u.failingTexts.length > 0 ? `: ${u.failingTexts.join(', ')}` : ''}`);
  const missed = run.details.filter((d) => !d.caught);
  lines.push('');
  lines.push(`못 잡은 것 ${missed.length}곳${missed.length === 0 ? '' : ':'}`);
  for (const d of missed) lines.push(`  - ${d.kind} ${d.target}: ${d.change}${d.codes.length > 0 ? ` (붙은 것: ${d.codes.join(', ')})` : ''}`);
  const empty = INJECTION_KINDS.filter((k) => run.report[k].den === 0);
  if (empty.length > 0) lines.push('', `넣을 곳이 없어 재지 못한 종류: ${empty.join(', ')}`);
  return lines.join('\n');
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, ['--seed', '--per-kind', '--out'], []);
  const seed = Number(args.values.get('--seed') ?? 20261012);
  const perKind = Number(args.values.get('--per-kind') ?? 30);
  if (!Number.isInteger(seed) || !Number.isInteger(perKind) || perKind < 1) throw new Error('--seed 와 --per-kind 는 정수다');

  const docs = await loadSplit('dev', { sealedPath: null, sealedFlag: false });
  const run = runInjection(docs, { seed, perKind });
  console.log(formatInjection(run));

  const out = args.values.get('--out') ?? path.join(RESULTS_DIR, 'inject.json');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  console.log(`\n기록: ${out}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`[eval:inject] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
