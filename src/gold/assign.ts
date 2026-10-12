// 표기 고르기. 값이 다 정해진 설계도를 받아, 칸마다 원문에 적을 꼴을 고른다.
// - 정답 값은 건드리지 않는다. 난수도 값 쪽과 따로 쓴다(씨앗에 다른 소금을 친다).
// - 한 칸에서 한 꼴이 몰리지 않게 가장 덜 쓴 꼴부터 고른다(연습과 안 여는 세트를 따로 센다).
// - 안 여는 세트에만 나오는 꼴은 있어도 되지만, 그 칸에서 쓴 꼴의 절반을 넘지 않게 한다.
import { FIELD_KEYS, type FieldKey } from '@/contract/fields';
import {
  GROUPS,
  MONEY_FIELDS,
  MONEY_FORMS,
  MONEY_NOTE,
  isWeekable,
  moneyForm,
  type Ctx,
  type DocInfo,
  type Form,
  type MoneyForm,
  type Sem,
} from './forms';
import { hashSeed, makeRng, type Rng } from './rng';
import type { GoldSpec, SurfaceHint } from './spec';

export interface RawHint extends SurfaceHint {
  sem?: Sem;
}
export type RawSpec = Omit<GoldSpec, 'surface_hints'> & { surface_hints: RawHint[] };

/** 한 꼴이 그 칸 문서에서 차지해도 되는 몫 */
export const FORM_SHARE_CAP = 0.3;
/** 단위 함정이 붙은 문서에서, 함정이 아닌 칸도 단위를 바꿔 적을 확률 */
const EXTRA_UNIT_RATE = 0.35;
/** 섞인 글에서 칸 하나를 영어·중국어 꼴로 적을 수 있게 여는 확률 */
const FOREIGN_RATE = 0.5;

export const shareCap = (n: number) => Math.max(1, Math.floor(n * FORM_SHARE_CAP));

const REGION_NOTE =
  '위치는 이 글자 그대로 한 번은 나오게 쓴다. 출구·층·건물처럼 더 자세한 설명을 붙일 때는 이 글자와 떨어뜨려 다른 문장이나 다른 칸에 쓴다(예: "위치: 강남역" + 다른 줄에 "11번 출구에서 걸어서 1분").';

// ── 가장 덜 쓴 꼴부터 ───────────────────────────────────────

interface Slot<T> {
  doc: DocInfo;
  cands: T[];
  /** 먼저 고르는 문서(이 안에서도 꼴이 퍼지게) */
  early?: boolean;
}

export function balance<T extends { id: string }>(slots: readonly Slot<T>[], r: Rng): Map<string, T> {
  const picked = new Map<string, T>();
  const count = { dev: new Map<string, number>(), test: new Map<string, number>() };
  const cnt = (split: 'dev' | 'test', id: string) => count[split].get(id) ?? 0;
  const total = (id: string) => cnt('dev', id) + cnt('test', id);
  const size = { dev: slots.filter((s) => s.doc.split === 'dev').length, test: slots.filter((s) => s.doc.split === 'test').length };
  const capAll = shareCap(slots.length);

  for (const split of ['dev', 'test'] as const) {
    const cap = shareCap(size[split]);
    // 안 여는 세트에서는 연습에서 쓴 꼴을 하나도 못 쓰는 문서(새 꼴을 열 수밖에 없는 문서)부터 고른다.
    // 그래야 "새 꼴을 여는 몫"을 골라서 여는 문서가 먼저 써 버리지 않는다.
    const forced = (s: Slot<T>) => split === 'test' && s.cands.every((c) => cnt('dev', c.id) === 0);
    // 그다음은 고를 수 있는 꼴이 적은 문서부터. 같은 것끼리는 섞은 차례대로.
    const order = r
      .shuffle(slots.filter((s) => s.doc.split === split))
      .map((s, i) => ({ s, i }))
      .sort(
        (a, b) =>
          Number(b.s.early ?? false) - Number(a.s.early ?? false) ||
          Number(forced(b.s)) - Number(forced(a.s)) ||
          a.s.cands.length - b.s.cands.length ||
          a.i - b.i,
      )
      .map((x) => x.s);
    for (const slot of order) {
      if (slot.cands.length === 0) throw new Error(`${slot.doc.id}: 고를 꼴이 없다`);
      // 전체에서 30% 를 넘지 않는 것이 먼저다. 묶음 안에서의 30% 는 되는 데까지 지킨다.
      let pool = slot.cands.filter((c) => total(c.id) < capAll);
      if (pool.length === 0) pool = slot.cands;
      // 연습에 없던 꼴을 새로 여는 것은, 안 여는 세트에만 있는 꼴이 절반을 넘지 않을 때까지만.
      const testOnly = [...count.test.keys()].filter((id) => cnt('dev', id) === 0).length;
      const seen = pool.filter((c) => total(c.id) > 0);
      if (split === 'test' && testOnly + 1 > count.dev.size && seen.length > 0) {
        pool = seen;
      } else {
        const roomy = pool.filter((c) => cnt(split, c.id) < cap);
        if (roomy.length > 0) pool = roomy;
      }
      const key = (c: T) => cnt(split, c.id) * 1000 + total(c.id);
      const best = Math.min(...pool.map(key));
      const choice = r.pick(pool.filter((c) => key(c) === best));
      picked.set(slot.doc.id, choice);
      count[split].set(choice.id, cnt(split, choice.id) + 1);
    }
  }
  return picked;
}

// ── 값의 갈래 ──────────────────────────────────────────────

const OLD_MONEY_CLASS: Record<string, 'full' | 'short'> = { won: 'full', plain: 'full', man: 'full', bare: 'short', cheon: 'short', man_dec: 'short' };

/** 옛 표기가 전하는 갈래. 함정이 정한 것이라 바꾸지 않는다. */
function baseClass(field: FieldKey, hint: RawHint): string {
  const old = hint.form;
  switch (field) {
    case 'size_m':
      return old === 'size:m' ? 'm' : 'alt';
    case 'size_mm':
      return old === 'size:mm' ? 'mm' : 'alt';
    case 'hours':
    case 'service_hours':
      return old === 'hours:plain' ? 'plain' : old === 'hours:ampm' ? 'ampm' : old === 'hours:allday' ? 'allday' : 'over';
    case 'footfall_per_day':
      return old.slice('footfall:'.length);
    case 'material_deadline_days':
    case 'refund_full_days':
    case 'booking_deadline_days':
    case 'design_deadline_days':
    case 'lead_time_days':
      return old === 'days:week' ? 'week' : 'day';
    default:
      return (GROUPS[field]?.forms[0] as Form).cls;
  }
}

/** 단위 함정 문서에서 함정이 아닌 칸을 단위를 바꿔 적는 갈래로 옮긴다. 값은 그대로다(정확히 되돌아오는 것만). */
function extraUnitClass(field: FieldKey, base: string, value: unknown, r: Rng): { cls: string; src?: number } | null {
  switch (field) {
    case 'size_m':
      return base === 'm' ? { cls: 'alt' } : null;
    case 'size_mm':
      return base === 'mm' ? { cls: 'alt' } : null;
    case 'hours':
    case 'service_hours':
      return base === 'plain' ? { cls: 'ampm' } : null;
    case 'footfall_per_day': {
      if (base !== 'day') return null;
      const n = value as number;
      // 하루 값에 30(7, 365)을 곱한 수를 적으면 다시 나눴을 때 정확히 같은 값이 나온다.
      const period = r.pick(['month', 'month', 'month', 'week', ...(n % 2000 === 0 ? ['year'] : [])]);
      return { cls: period, src: n * (period === 'month' ? 30 : period === 'week' ? 7 : 365) };
    }
    case 'material_deadline_days':
    case 'refund_full_days':
    case 'booking_deadline_days':
    case 'design_deadline_days':
    case 'lead_time_days': {
      if (base !== 'day') return null;
      const n = value as number;
      if (isWeekable(n)) return { cls: 'week' };
      return n <= 3 && field !== 'lead_time_days' ? { cls: 'hour' } : null;
    }
    default:
      return null;
  }
}

// ── 고르기 ─────────────────────────────────────────────────

interface Plan {
  spec: RawSpec;
  doc: DocInfo;
  hint: RawHint;
  ctx: Ctx;
  cands: Form[];
}

const moneyValues = (spec: RawSpec): number[] => {
  const t = spec.truth as Record<string, unknown>;
  const options = ((t.period_options ?? t.quantity_options) as { price_krw: number }[] | null | undefined) ?? [];
  return [t.price_krw, t.list_price_krw, ...options.map((o) => o.price_krw)].filter((x): x is number => typeof x === 'number');
};

export function applyForms(seed: number, raws: readonly RawSpec[]): GoldSpec[] {
  const roll = (what: string, id: string, field: string) => makeRng(hashSeed(seed, `${what}:${id}:${field}`));
  const docs = new Map<string, DocInfo>(
    raws.map((s) => [s.id, { id: s.id, split: s.split, style: s.style, type: s.type, unitDoc: s.traps.includes('unit') }]),
  );
  const hintOf = (s: RawSpec, field: FieldKey) => s.surface_hints.find((h) => h.field === field);
  const foreignOk = (doc: DocInfo, field: string) => doc.style === 'mixed_lang' && roll('lang', doc.id, field).chance(FOREIGN_RATE);
  const extraOk = (doc: DocInfo, field: string) => doc.unitDoc && roll('unit', doc.id, field).chance(EXTRA_UNIT_RATE);

  // 1) 금액 꼴은 문서마다 하나다(판매가·정가·값표가 같은 꼴을 쓴다). 정가가 있는 문서부터 고른다.
  const moneySlots: Slot<MoneyForm>[] = [];
  for (const s of raws) {
    const price = hintOf(s, 'price_krw');
    if (!price) continue;
    const doc = docs.get(s.id) as DocInfo;
    const vals = moneyValues(s);
    const lang = foreignOk(doc, 'price_krw');
    const of = (cls: string) => MONEY_FORMS.filter((f) => f.cls === cls && (!f.lang || lang) && (!f.ok || f.ok(vals, s.type)));
    const base = OLD_MONEY_CLASS[price.form.slice('money:'.length)] as 'full' | 'short';
    let cands = base === 'full' && extraOk(doc, 'price_krw') ? of('short') : [];
    if (cands.length === 0) cands = of(base);
    moneySlots.push({ doc, cands, early: Boolean(hintOf(s, 'list_price_krw')) });
  }
  const moneyPick = balance(moneySlots, makeRng(hashSeed(seed, 'balance:money')));

  // 2) 나머지 칸은 칸마다 따로 고른다.
  const formPick = new Map<string, { form: Form; ctx: Ctx }>();
  for (const field of FIELD_KEYS) {
    const group = GROUPS[field];
    if (!group) continue;
    const plans: Plan[] = [];
    for (const spec of raws) {
      const hint = hintOf(spec, field);
      if (!hint) continue;
      const doc = docs.get(spec.id) as DocInfo;
      const value = spec.truth[field];
      const base = baseClass(field, hint);
      const baseSrc = field === 'footfall_per_day' ? (base === 'day' ? (value as number) : (hint.sem?.src as number)) : undefined;
      const ctxFor = (src: number | undefined): Ctx => ({
        doc,
        field,
        value,
        sem: { ...hint.sem, ...(src === undefined ? {} : { src }) },
        ...(moneyPick.has(spec.id) ? { money: moneyPick.get(spec.id) as MoneyForm } : {}),
        langOk: foreignOk(doc, field),
        r: roll('form', spec.id, field),
      });
      const candsOf = (cls: string, ctx: Ctx) =>
        group.forms.filter((f) => f.cls === cls && (!f.lang || ctx.langOk) && (!f.tableOnly || doc.style === 'table') && (!f.ok || f.ok(ctx)));

      let ctx = ctxFor(baseSrc);
      let cands: Form[] = [];
      const extra = extraOk(doc, field) ? extraUnitClass(field, base, value, roll('unit-class', spec.id, field)) : null;
      if (extra) {
        const extraCtx = ctxFor(extra.src ?? baseSrc);
        cands = candsOf(extra.cls, extraCtx);
        if (cands.length > 0) ctx = extraCtx;
      }
      if (cands.length === 0) cands = candsOf(base, ctx);
      plans.push({ spec, doc, hint, ctx, cands });
    }
    const chosen = balance(plans.map((p) => ({ doc: p.doc, cands: p.cands })), makeRng(hashSeed(seed, `balance:${field}`)));
    for (const p of plans) formPick.set(`${p.spec.id}:${field}`, { form: chosen.get(p.spec.id) as Form, ctx: p.ctx });
  }

  // 3) 고른 꼴로 표기를 다시 적는다.
  return raws.map((spec) => {
    const money = moneyPick.get(spec.id);
    // 표기를 새로 적는다. 값을 뽑을 때 남긴 재료(sem)는 여기서 떨어진다.
    const surface_hints = spec.surface_hints.map((raw): SurfaceHint => {
      const old = raw;
      const head = { field: old.field, label: old.label };
      if (MONEY_FIELDS.includes(old.field) && money) {
        const show = money.fmt(spec.truth[old.field] as number);
        // 옛 설명 가운데 금액의 자리(가장 짧은 기간의 값, 정가라는 것)를 말하는 것은 남긴다.
        const role = old.note && !old.note.startsWith('"천원"') ? old.note : old.field === 'price_krw' ? '한 개 값이다.' : '';
        return { ...head, show, tokens: [show], form: `money:${money.id}`, ...(money.unit ? { unit: money.unit, declare_unit: !money.silent } : {}), note: [role, money.note ?? MONEY_NOTE].filter(Boolean).join(' ') };
      }
      const group = GROUPS[old.field];
      const pick = formPick.get(`${spec.id}:${old.field}`);
      if (!group || !pick) {
        // 글 칸: 글자 그대로.
        const note = old.field === 'region' ? REGION_NOTE : old.note;
        return { ...head, show: old.show, tokens: old.tokens, form: 'text', ...(note ? { note } : {}) };
      }
      const out = pick.form.make(pick.ctx);
      return {
        ...head,
        show: out.show,
        tokens: out.tokens ?? [out.show],
        form: `${group.name}:${pick.form.id}`,
        ...(out.unit ? { unit: out.unit, declare_unit: !out.silent } : {}),
        ...(out.parts ? { parts: out.parts } : {}),
        note: out.note ?? MONEY_NOTE,
      };
    });
    return { ...spec, surface_hints };
  });
}

// ── 분포표 ─────────────────────────────────────────────────

export interface FormRow {
  field: FieldKey;
  form: string;
  eg: string;
  dev: number;
  test: number;
}

/** 꼴 이름 → 본보기 */
export function formExample(field: FieldKey, formName: string): string {
  const id = formName.slice(formName.indexOf(':') + 1);
  if (formName.startsWith('money:')) return moneyForm(id).eg;
  return GROUPS[field]?.forms.find((f) => f.id === id)?.eg ?? '';
}

/** 칸별로 어떤 꼴을 몇 건에 썼는가. 글 칸(꼴이 하나)은 뺀다. */
export function formTable(specs: readonly GoldSpec[]): FormRow[] {
  const rows = new Map<string, FormRow>();
  for (const s of specs) {
    for (const h of s.surface_hints) {
      if (h.form === 'text') continue;
      const key = `${h.field}|${h.form}`;
      const row = rows.get(key) ?? { field: h.field, form: h.form, eg: formExample(h.field, h.form), dev: 0, test: 0 };
      row[s.split] += 1;
      rows.set(key, row);
    }
  }
  const order = new Map(FIELD_KEYS.map((k, i) => [k, i]));
  return [...rows.values()].sort((a, b) => (order.get(a.field) ?? 0) - (order.get(b.field) ?? 0) || b.dev + b.test - (a.dev + a.test) || a.form.localeCompare(b.form));
}

/** 칸마다 마련해 둔 꼴의 수(쓴 수가 아니라 고를 수 있는 수). */
export function definedFormCount(field: FieldKey): number {
  if (MONEY_FIELDS.includes(field)) return MONEY_FORMS.length;
  return GROUPS[field]?.forms.length ?? 1;
}
