// 표기 틀. 같은 값을 원문에 적는 여러 꼴이다. 정답 값은 여기서 정하지 않는다(값은 generate.ts 가 먼저 정한다).
// 꼴마다 "원문에 적을 본보기(show)"와 "글자 그대로 들어가야 하는 조각(tokens)"을 만든다.
// 꼴을 더할 때는 recalc.ts(검산)가 그 꼴을 다시 읽을 수 있는지 시험(forms.test.ts)이 본다. 못 읽는 꼴은 쓰지 않는다.
import type { GoldStyle } from '@/contract/eval-types';
import type { DocType, FieldKey, Hours } from '@/contract/fields';
import type { Rng } from './rng';

export interface DocInfo {
  id: string;
  split: 'dev' | 'test';
  style: GoldStyle;
  type: DocType;
  /** 단위 함정이 붙은 문서인가. 이런 문서에서는 다른 칸도 가끔 단위를 바꿔 적는다. */
  unitDoc: boolean;
}

/** 값을 뽑을 때 남겨 둔 것(표기를 만들 때만 쓴다). */
export interface Sem {
  /** 유동인구: 적을 숫자(그 기간의 사람 수) */
  src?: number;
  /** 세는 말(잔, 개, 장 …) */
  unitWord?: string;
  /** 기간 옵션의 옛 낱말 */
  words?: string[];
}

export interface Rendered {
  show: string;
  /** 없으면 show 하나 */
  tokens?: string[];
  note?: string;
  /** 수 옆에 단위를 붙이지 않는 꼴에서 그 수의 단위 */
  unit?: string;
  /** 그 단위를 글 다른 곳에 밝히지 않는 꼴이면 true */
  silent?: boolean;
  /** 보조 갈래(금액 꼴, 기간 낱말 꼴) */
  parts?: Record<string, string>;
}

export interface Ctx {
  doc: DocInfo;
  field: FieldKey;
  /** 정답 값 */
  value: unknown;
  sem: Sem;
  /** 이 문서의 금액 꼴(값표를 적을 때 쓴다) */
  money?: MoneyForm;
  /** 영어·중국어 낱말을 써도 되는 칸인가 */
  langOk: boolean;
  /** 표기 안의 작은 갈림(낱말 고르기)에 쓰는 난수. 정답을 뽑는 난수와 따로다. */
  r: Rng;
}

export interface Form {
  id: string;
  /** 값의 갈래. 같은 갈래의 꼴끼리만 바꿔 쓸 수 있다(예: m 로 적는 꼴과 mm 로 적는 꼴은 갈래가 다르다). */
  cls: string;
  /** 본보기 */
  eg: string;
  /** 영어·중국어 꼴. 섞인 글에서만 쓴다. */
  lang?: 'en' | 'zh';
  /** 표 꼴 글에서만 쓴다. */
  tableOnly?: boolean;
  ok?: (c: Ctx) => boolean;
  make: (c: Ctx) => Rendered;
}

export const comma = (n: number) => {
  const [i, d] = String(n).split('.');
  return `${(i as string).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${d ? `.${d}` : ''}`;
};
const pad = (n: number) => String(n).padStart(2, '0');
const trim2 = (n: number) => String(Math.round(n * 100) / 100);

const VERBATIM = '이 표기 그대로 적는다. 다른 표기로 바꾸거나 한 번 더 적지 않는다.';

// ── 금액 ───────────────────────────────────────────────────
// full: 원이나 만원으로 다 적은 꼴.  short: 단위를 줄이거나 뺀 꼴(단위 함정).

export interface MoneyForm {
  id: string;
  cls: 'full' | 'short';
  eg: string;
  lang?: 'en' | 'zh';
  /** 수 옆에 단위가 없는 꼴의 단위 */
  unit?: '만원' | '천원';
  /** 그 단위를 글에 밝히지 않는 꼴 */
  silent?: boolean;
  ok?: (vals: readonly number[], type: DocType) => boolean;
  fmt: (won: number) => string;
  note?: string;
}

const every = (vals: readonly number[], mod: number) => vals.every((v) => v % mod === 0);
const notGoods = (type: DocType) => type !== 'goods';
const SHORT_NOTE = '적힌 단위 그대로 적는다. 원 단위로 풀어 적지 않는다.';

export const MONEY_FORMS: readonly MoneyForm[] = [
  { id: 'won_comma', cls: 'full', eg: '1,500,000원', fmt: (w) => `${comma(w)}원` },
  { id: 'won_plain', cls: 'full', eg: '1500000원', fmt: (w) => `${w}원` },
  { id: 'won_space', cls: 'full', eg: '1,500,000 원', fmt: (w) => `${comma(w)} 원` },
  { id: 'man', cls: 'full', eg: '150만원', ok: (v) => every(v, 10_000), fmt: (w) => `${w / 10_000}만원` },
  { id: 'man_space', cls: 'full', eg: '1,500만 원', ok: (v) => every(v, 10_000), fmt: (w) => `${comma(w / 10_000)}만 원` },
  { id: 'sign', cls: 'full', eg: '₩1,500,000', fmt: (w) => `₩${comma(w)}` },
  { id: 'sign_wide', cls: 'full', eg: '￦1,500,000', fmt: (w) => `￦${comma(w)}` },
  { id: 'krw_pre', cls: 'full', eg: 'KRW 1,500,000', fmt: (w) => `KRW ${comma(w)}` },
  { id: 'krw_post', cls: 'full', eg: '1,500,000 KRW', fmt: (w) => `${comma(w)} KRW` },
  { id: 'zh_man', cls: 'full', lang: 'zh', eg: '150万韩元', ok: (v) => every(v, 10_000), fmt: (w) => `${w / 10_000}万韩元` },
  { id: 'zh_full', cls: 'full', lang: 'zh', eg: '1,500,000韩元', fmt: (w) => `${comma(w)}韩元` },
  { id: 'en_won', cls: 'full', lang: 'en', eg: '1,500,000 won', fmt: (w) => `${comma(w)} won` },

  {
    id: 'bare_man', cls: 'short', eg: '150 (단위: 만원)', unit: '만원', ok: (v, t) => notGoods(t) && every(v, 10_000), fmt: (w) => comma(w / 10_000),
    note: '금액은 만원 단위 숫자만 적는다("만원"을 붙이지 않는다). 글 어딘가에 "단위: 만원"이라고 한 번 밝힌다.',
  },
  {
    id: 'bare_man_silent', cls: 'short', eg: '150 (단위를 밝히지 않음)', unit: '만원', silent: true, ok: (v, t) => notGoods(t) && every(v, 10_000), fmt: (w) => `${w / 10_000}`,
    note: '금액은 만원 단위 숫자만 적는다("만원"을 붙이지 않는다). 단위를 따로 밝히지 않는다.',
  },
  {
    id: 'bare_cheon', cls: 'short', eg: '1,500 (단위: 천원)', unit: '천원', ok: (v) => every(v, 1_000), fmt: (w) => comma(w / 1_000),
    note: '금액은 천원 단위 숫자만 적는다("천원"을 붙이지 않는다). 글 어딘가에 "단위: 천원"이라고 한 번 밝힌다.',
  },
  { id: 'cheon', cls: 'short', eg: '1,500천원 · 8천원', ok: (v) => every(v, 1_000), fmt: (w) => `${comma(w / 1_000)}천원`, note: SHORT_NOTE },
  { id: 'man_nowon', cls: 'short', eg: '150만 · 1.2만', ok: (v) => every(v, 1_000) && v.every((x) => x >= 10_000), fmt: (w) => `${w / 10_000}만`, note: '"원"을 붙이지 않고 "만"까지만 적는다.' },
  { id: 'baekman', cls: 'short', eg: '1.5백만원', ok: (v, t) => notGoods(t) && every(v, 10_000) && v.every((x) => x >= 1_000_000), fmt: (w) => `${w / 1_000_000}백만원`, note: SHORT_NOTE },
  { id: 'man_dec', cls: 'short', eg: '1.2만원', ok: (v, t) => t === 'goods' && every(v, 1_000) && v.every((x) => x >= 10_000), fmt: (w) => `${w / 10_000}만원`, note: SHORT_NOTE },
  {
    id: 'cheon_man', cls: 'short', eg: '8천원 · 1.2만원', ok: (v, t) => t === 'goods' && every(v, 1_000) && v.some((x) => x < 10_000),
    fmt: (w) => (w < 10_000 ? `${w / 1_000}천원` : `${w / 10_000}만원`), note: SHORT_NOTE,
  },
  {
    id: 'man_cheon', cls: 'short', eg: '1만 2천원', ok: (v, t) => t === 'goods' && every(v, 1_000) && v.every((x) => x >= 10_000) && v.some((x) => x % 10_000 !== 0),
    fmt: (w) => (w % 10_000 === 0 ? `${w / 10_000}만원` : `${Math.floor(w / 10_000)}만 ${(w % 10_000) / 1_000}천원`), note: SHORT_NOTE,
  },
  { id: 'en_million', cls: 'short', lang: 'en', eg: 'KRW 1.5 million', ok: (v) => every(v, 10_000) && v.every((x) => x >= 1_000_000), fmt: (w) => `KRW ${w / 1_000_000} million`, note: SHORT_NOTE },
];

export const moneyForm = (id: string): MoneyForm => {
  const f = MONEY_FORMS.find((x) => x.id === id);
  if (!f) throw new Error(`모르는 금액 꼴: ${id}`);
  return f;
};

// ── 꼴을 짧게 적는 도우미 ───────────────────────────────────

type Make = (c: Ctx) => Rendered | string;
const form = (cls: string, id: string, eg: string, make: Make, more: Partial<Form> = {}): Form => ({
  id,
  cls,
  eg,
  ...more,
  make: (c) => {
    const out = make(c);
    return typeof out === 'string' ? { show: out } : out;
  },
});
const en = { lang: 'en' } as const;
const zh = { lang: 'zh' } as const;

type Pair = { width: number; height: number };
const wh = (c: Ctx): [number, number] => [(c.value as Pair).width, (c.value as Pair).height];

// ── 크기(m) ────────────────────────────────────────────────

const BARE_UNIT = (u: string) => `수 옆에 단위를 붙이지 않는다. 대신 칸 이름이나 표 머리에 단위(${u})를 밝힌다. 예: "규격(${u})", "사이즈 [단위 ${u}]".`;
const KEEP_UNIT = (u: string, other: string) => `단위를 ${u} 로 적는다. ${other} 로 바꿔 적지 않는다.`;
const SPLIT_NOTE = '가로와 세로를 따로(두 줄이나 두 칸으로) 적어도 된다. 조각은 글자 그대로.';
const mmOf = (c: Ctx): [number, number] => wh(c).map((x) => Math.round(x * 1000)) as [number, number];
const cmOf = (c: Ctx): [number, number] => wh(c).map((x) => Math.round(x * 100)) as [number, number];

export const SIZE_M_FORMS: readonly Form[] = [
  form('m', 'garo_sero_x', '가로 8m × 세로 4.5m', (c) => `가로 ${wh(c)[0]}m × 세로 ${wh(c)[1]}m`),
  form('m', 'each_x', '8m × 4.5m', (c) => `${wh(c)[0]}m × ${wh(c)[1]}m`),
  form('m', 'once_x', '8×4.5m', (c) => `${wh(c)[0]}×${wh(c)[1]}m`),
  form('m', 'bare_X', '8X4.5 (단위는 표 머리에)', (c) => ({ show: `${wh(c)[0]}X${wh(c)[1]}`, unit: 'm', note: BARE_UNIT('m') })),
  form('m', 'star', '8m*4.5m', (c) => `${wh(c)[0]}m*${wh(c)[1]}m`),
  form('m', 'x_sp', '8 x 4.5 m', (c) => `${wh(c)[0]} x ${wh(c)[1]} m`),
  form('m', 'WH', 'W 8m / H 4.5m', (c) => `W ${wh(c)[0]}m / H ${wh(c)[1]}m`),
  form('m', 'split', '가로 8m, 세로 4.5m (두 칸)', (c) => ({ show: `가로 ${wh(c)[0]}m, 세로 ${wh(c)[1]}m`, tokens: [`가로 ${wh(c)[0]}m`, `세로 ${wh(c)[1]}m`], note: SPLIT_NOTE })),
  form('m', 'meter', '8미터 × 4.5미터', (c) => `${wh(c)[0]}미터 × ${wh(c)[1]}미터`),
  form('m', 'paren', '8m(W) × 4.5m(H)', (c) => `${wh(c)[0]}m(W) × ${wh(c)[1]}m(H)`),
  form('m', 'pok', '폭 8m, 높이 4.5m', (c) => `폭 ${wh(c)[0]}m, 높이 ${wh(c)[1]}m`),
  form('m', 'sero_first', '세로 4.5m × 가로 8m', (c) => ({ show: `세로 ${wh(c)[1]}m × 가로 ${wh(c)[0]}m`, note: '세로를 먼저 적는다. "세로", "가로"라는 말을 빼지 않는다.' })),
  form('m', 'en_wide', '8 m wide by 4.5 m high', (c) => `${wh(c)[0]} m wide by ${wh(c)[1]} m high`, en),
  form('m', 'zh_kuan', '宽8米、高4.5米', (c) => `宽${wh(c)[0]}米、高${wh(c)[1]}米`, zh),

  form('alt', 'mm_x', '8000×4500mm', (c) => ({ show: `${mmOf(c)[0]}×${mmOf(c)[1]}mm`, note: KEEP_UNIT('mm', 'm') })),
  form('alt', 'mm_star', '8000mm*4500mm', (c) => ({ show: `${mmOf(c)[0]}mm*${mmOf(c)[1]}mm`, note: KEEP_UNIT('mm', 'm') })),
  form('alt', 'mm_comma', '8,000 x 4,500 mm', (c) => ({ show: `${comma(mmOf(c)[0])} x ${comma(mmOf(c)[1])} mm`, note: KEEP_UNIT('mm', 'm') })),
  form('alt', 'mm_garo', '가로 8000mm, 세로 4500mm', (c) => ({ show: `가로 ${mmOf(c)[0]}mm, 세로 ${mmOf(c)[1]}mm`, tokens: [`가로 ${mmOf(c)[0]}mm`, `세로 ${mmOf(c)[1]}mm`], note: `${KEEP_UNIT('mm', 'm')} ${SPLIT_NOTE}` })),
  form('alt', 'mm_WH', 'W8000 × H4500 (mm)', (c) => ({ show: `W${mmOf(c)[0]} × H${mmOf(c)[1]} (mm)`, note: KEEP_UNIT('mm', 'm') })),
  form('alt', 'mm_bare', '8000*4500 (단위는 표 머리에)', (c) => ({ show: `${mmOf(c)[0]}*${mmOf(c)[1]}`, unit: 'mm', note: BARE_UNIT('mm') })),
  form('alt', 'cm_x', '800×450cm', (c) => ({ show: `${cmOf(c)[0]}×${cmOf(c)[1]}cm`, note: KEEP_UNIT('cm', 'm') })),
  form('alt', 'cm_bare', '800x450 (단위는 표 머리에)', (c) => ({ show: `${cmOf(c)[0]}x${cmOf(c)[1]}`, unit: 'cm', note: BARE_UNIT('cm') })),
  form('alt', 'cm_garo', '가로 800cm × 세로 450cm', (c) => ({ show: `가로 ${cmOf(c)[0]}cm × 세로 ${cmOf(c)[1]}cm`, note: KEEP_UNIT('cm', 'm') })),
];

// ── 크기(mm) ───────────────────────────────────────────────

const cmDec = (c: Ctx): [string, string] => wh(c).map((x) => trim2(x / 10)) as [string, string];
const bigEnough = (c: Ctx) => wh(c).every((x) => x >= 300 && x % 10 === 0);

export const SIZE_MM_FORMS: readonly Form[] = [
  form('mm', 'x_mm', '55×85mm', (c) => `${wh(c)[0]}×${wh(c)[1]}mm`),
  form('mm', 'star', '55*85mm', (c) => `${wh(c)[0]}*${wh(c)[1]}mm`),
  form('mm', 'each', '55mm x 85mm', (c) => `${wh(c)[0]}mm x ${wh(c)[1]}mm`),
  form('mm', 'bare_X', '55X85 (단위는 표 머리에)', (c) => ({ show: `${wh(c)[0]}X${wh(c)[1]}`, unit: 'mm', note: BARE_UNIT('mm') })),
  form('mm', 'garo', '가로 55mm × 세로 85mm', (c) => `가로 ${wh(c)[0]}mm × 세로 ${wh(c)[1]}mm`),
  form('mm', 'x_sp', '55 x 85 mm', (c) => `${wh(c)[0]} x ${wh(c)[1]} mm`),
  form('mm', 'WH', 'W55 × H85mm', (c) => `W${wh(c)[0]} × H${wh(c)[1]}mm`),
  form('mm', 'split', '가로 55mm, 세로 85mm (두 칸)', (c) => ({ show: `가로 ${wh(c)[0]}mm, 세로 ${wh(c)[1]}mm`, tokens: [`가로 ${wh(c)[0]}mm`, `세로 ${wh(c)[1]}mm`], note: SPLIT_NOTE })),
  form('mm', 'paren_unit', '55 × 85 (mm)', (c) => `${wh(c)[0]} × ${wh(c)[1]} (mm)`),
  form('mm', 'milli', '55밀리 × 85밀리', (c) => `${wh(c)[0]}밀리 × ${wh(c)[1]}밀리`),
  form('mm', 'en_by', '55mm (W) by 85mm (H)', (c) => `${wh(c)[0]}mm (W) by ${wh(c)[1]}mm (H)`, en),
  form('mm', 'zh_kuan', '宽55毫米×高85毫米', (c) => `宽${wh(c)[0]}毫米×高${wh(c)[1]}毫米`, zh),

  form('alt', 'cm_x', '5.5×8.5cm', (c) => ({ show: `${cmDec(c)[0]}×${cmDec(c)[1]}cm`, note: KEEP_UNIT('cm', 'mm') })),
  form('alt', 'cm_each', '5.5cm x 8.5cm', (c) => ({ show: `${cmDec(c)[0]}cm x ${cmDec(c)[1]}cm`, note: KEEP_UNIT('cm', 'mm') })),
  form('alt', 'cm_garo', '가로 5.5cm 세로 8.5cm', (c) => ({ show: `가로 ${cmDec(c)[0]}cm 세로 ${cmDec(c)[1]}cm`, note: KEEP_UNIT('cm', 'mm') })),
  form('alt', 'cm_bare', '5.5*8.5 (단위는 표 머리에)', (c) => ({ show: `${cmDec(c)[0]}*${cmDec(c)[1]}`, unit: 'cm', note: BARE_UNIT('cm') })),
  form('alt', 'm_x', '0.6m × 0.2m', (c) => ({ show: `${wh(c)[0] / 1000}m × ${wh(c)[1] / 1000}m`, note: KEEP_UNIT('m', 'mm') }), { ok: bigEnough }),
];

// ── 해상도 ─────────────────────────────────────────────────

export const RESOLUTION_FORMS: readonly Form[] = [
  form('px', 'times', '1920×1080', (c) => `${wh(c)[0]}×${wh(c)[1]}`),
  form('px', 'x_lower', '1920x1080', (c) => `${wh(c)[0]}x${wh(c)[1]}`),
  form('px', 'star', '1920*1080', (c) => `${wh(c)[0]}*${wh(c)[1]}`),
  form('px', 'X_sp', '1920 X 1080', (c) => `${wh(c)[0]} X ${wh(c)[1]}`),
  form('px', 'px', '1920×1080px', (c) => `${wh(c)[0]}×${wh(c)[1]}px`),
  form('px', 'pixel', '1920 x 1080 pixel', (c) => `${wh(c)[0]} x ${wh(c)[1]} pixel`),
  form('px', 'garo', '가로 1920px, 세로 1080px', (c) => ({ show: `가로 ${wh(c)[0]}px, 세로 ${wh(c)[1]}px`, tokens: [`가로 ${wh(c)[0]}px`, `세로 ${wh(c)[1]}px`], note: SPLIT_NOTE })),
  form('px', 'comma', '1,920 × 1,080', (c) => `${comma(wh(c)[0])} × ${comma(wh(c)[1])}`),
  form('px', 'WH', 'W1920 × H1080', (c) => `W${wh(c)[0]} × H${wh(c)[1]}`),
  form('px', 'px_each', '1920px*1080px', (c) => `${wh(c)[0]}px*${wh(c)[1]}px`),
  form('px', 'en_by', '1920 by 1080 px', (c) => `${wh(c)[0]} by ${wh(c)[1]} px`, en),
  form('px', 'zh_px', '1920×1080像素', (c) => `${wh(c)[0]}×${wh(c)[1]}像素`, zh),
];

// ── 운영 시간 ──────────────────────────────────────────────
// plain: 같은 날, 24시간제 숫자.  ampm: 같은 날, 오전·오후.  over: 다음 날로 넘어감.  allday: 24시간.

const oc = (c: Ctx): [number, number] => {
  const h = c.value as Hours;
  return [Number(h.open.slice(0, 2)), Number(h.close.slice(0, 2))];
};
const koHour = (h: number) => (h < 12 ? `오전 ${h}시` : h === 12 ? '낮 12시' : h < 18 ? `오후 ${h - 12}시` : h < 21 ? `저녁 ${h - 12}시` : `밤 ${h - 12}시`);
const zhHour = (h: number) => (h < 12 ? `上午${h}点` : h === 12 ? '中午12点' : h < 18 ? `下午${h - 12}点` : `晚上${h - 12}点`);
const h12 = (h: number) => (h % 12 === 0 ? 12 : h % 12);
const ap = (h: number, upper = false) => (h < 12 ? (upper ? 'AM' : 'am') : upper ? 'PM' : 'pm');
const OVER_NOTE = '끝 시각을 24시 넘는 수 그대로 적는다(다음 날 새벽이라고 풀어 쓰지 않는다).';
const AMPM_NOTE = '오전·오후로 적는다. 24시간제 숫자로 바꿔 적지 않는다.';
const NEXT_NOTE = '끝 시각이 다음 날이라는 표시를 빼지 않는다. 24시 넘는 수로 바꿔 적지 않는다.';

export const HOURS_FORMS: readonly Form[] = [
  form('plain', 'colon_tilde', '06:00~22:00', (c) => `${pad(oc(c)[0])}:00~${pad(oc(c)[1])}:00`),
  form('plain', 'si_tilde', '06시~22시', (c) => `${pad(oc(c)[0])}시~${oc(c)[1]}시`),
  form('plain', 'colon_hyphen', '06:00-22:00', (c) => `${pad(oc(c)[0])}:00-${pad(oc(c)[1])}:00`),
  form('plain', 'colon_sp', '06:00 ~ 22:00', (c) => `${pad(oc(c)[0])}:00 ~ ${pad(oc(c)[1])}:00`),
  form('plain', 'buteo', '6시부터 22시까지', (c) => `${oc(c)[0]}시부터 ${oc(c)[1]}시까지`),
  form('plain', 'si_min', '06시 00분~22시 00분', (c) => `${pad(oc(c)[0])}시 00분~${oc(c)[1]}시 00분`),
  form('plain', 'bare_si', '06~22시', (c) => `${pad(oc(c)[0])}~${oc(c)[1]}시`),
  form('plain', 'endash', '06:00–22:00', (c) => `${pad(oc(c)[0])}:00–${pad(oc(c)[1])}:00`),
  form('plain', 'nopad', '6:00~22:00', (c) => `${oc(c)[0]}:00~${oc(c)[1]}:00`),
  form('plain', 'en_to', '6:00 to 22:00', (c) => `${oc(c)[0]}:00 to ${oc(c)[1]}:00`, en),
  form('plain', 'zh_zhi', '6点至22点', (c) => `${oc(c)[0]}点至${oc(c)[1]}点`, zh),

  form('ampm', 'ko_tilde', '오전 10시~오후 2시', (c) => ({ show: `${koHour(oc(c)[0])}~${koHour(oc(c)[1])}`, note: AMPM_NOTE })),
  form('ampm', 'ko_buteo', '오전 10시부터 오후 2시까지', (c) => ({ show: `${koHour(oc(c)[0])}부터 ${koHour(oc(c)[1])}까지`, note: AMPM_NOTE })),
  form('ampm', 'AMPM_pre', 'AM 10:00 ~ PM 2:00', (c) => ({ show: `${ap(oc(c)[0], true)} ${h12(oc(c)[0])}:00 ~ ${ap(oc(c)[1], true)} ${h12(oc(c)[1])}:00`, note: AMPM_NOTE })),
  form('ampm', 'ampm_post', '10am-2pm', (c) => ({ show: `${h12(oc(c)[0])}${ap(oc(c)[0])}-${h12(oc(c)[1])}${ap(oc(c)[1])}`, note: AMPM_NOTE })),
  form('ampm', 'AMPM_post', '10:00 AM - 2:00 PM', (c) => ({ show: `${h12(oc(c)[0])}:00 ${ap(oc(c)[0], true)} - ${h12(oc(c)[1])}:00 ${ap(oc(c)[1], true)}`, note: AMPM_NOTE })),
  form('ampm', 'en_from', 'from 10 AM to 2 PM', (c) => ({ show: `from ${h12(oc(c)[0])} AM to ${h12(oc(c)[1])} ${ap(oc(c)[1], true)}`, note: AMPM_NOTE }), { ...en, ok: (c) => oc(c)[0] < 12 }),
  form('ampm', 'zh_dao', '上午10点到下午2点', (c) => ({ show: `${zhHour(oc(c)[0])}到${zhHour(oc(c)[1])}`, note: AMPM_NOTE }), zh),

  form('over', 'si_over', '05시~25시', (c) => ({ show: `${pad(oc(c)[0])}시~${oc(c)[1] + 24}시`, note: OVER_NOTE })),
  form('over', 'colon_over', '05:00~25:00', (c) => ({ show: `${pad(oc(c)[0])}:00~${oc(c)[1] + 24}:00`, note: OVER_NOTE })),
  form('over', 'ikil_paren', '05:00-01:00(익일)', (c) => ({ show: `${pad(oc(c)[0])}:00-${pad(oc(c)[1])}:00(익일)`, note: NEXT_NOTE })),
  form('over', 'ikil_pre', '05:00 ~ 익일 01:00', (c) => ({ show: `${pad(oc(c)[0])}:00 ~ 익일 ${pad(oc(c)[1])}:00`, note: NEXT_NOTE })),
  form('over', 'si_ikil', '05시~익일 01시', (c) => ({ show: `${pad(oc(c)[0])}시~익일 ${pad(oc(c)[1])}시`, note: NEXT_NOTE })),
  form('over', 'wrap', '05:00~01:00', (c) => ({ show: `${pad(oc(c)[0])}:00~${pad(oc(c)[1])}:00`, note: '끝 시각을 다음 날 시각 그대로 적는다. "익일" 같은 말은 붙이지 않는다.' })),
  form('over', 'ko_daeum', '오전 5시부터 다음날 새벽 1시까지', (c) => ({ show: `${koHour(oc(c)[0])}부터 다음날 새벽 ${oc(c)[1]}시까지`, note: NEXT_NOTE }), { ok: (c) => oc(c)[1] >= 1 }),
  form('over', 'jajeong', '06시~자정', (c) => ({ show: `${pad(oc(c)[0])}시~자정`, note: '끝 시각을 "자정"이라고 적는다. 숫자로 바꿔 적지 않는다.' }), { ok: (c) => oc(c)[1] === 0 }),
  form('over', 'en_next', '5:00 to 1:00 (next day)', (c) => ({ show: oc(c)[1] === 0 ? `${oc(c)[0]}:00 to midnight` : `${oc(c)[0]}:00 to ${oc(c)[1]}:00 (next day)`, note: NEXT_NOTE }), en),
  form('over', 'zh_ciri', '5点至次日1点', (c) => ({ show: `${oc(c)[0]}点至次日${oc(c)[1]}点`, note: NEXT_NOTE }), zh),

  form('allday', 'h24', '24시간', () => ({ show: '24시간', note: '시작·끝 시각은 쓰지 않고 24시간 운영이라고만 쓴다.' })),
  form('allday', 'h24_H', '24H', () => ({ show: '24H', note: '시작·끝 시각은 쓰지 않는다.' })),
  form('allday', 'h24_range', '00:00~24:00', () => '00:00~24:00'),
  form('allday', 'h24_haru', '하루 24시간', () => ({ show: '하루 24시간', note: '시작·끝 시각은 쓰지 않는다.' })),
  form('allday', 'h24_hrs', '24hrs', () => ({ show: '24hrs', note: '시작·끝 시각은 쓰지 않는다.' })),
  form('allday', 'zh_24', '全天24小时', () => '全天24小时', zh),
];

// ── 횟수·개수 ──────────────────────────────────────────────

const num = (c: Ctx) => c.value as number;

export const SPOT_FORMS: readonly Form[] = [
  form('n', 'cho', '15초', (c) => `${num(c)}초`),
  form('n', 'cho_sp', '15 초', (c) => `${num(c)} 초`),
  form('n', 'sojae', '15초 소재', (c) => `${num(c)}초 소재`),
  form('n', 'sec', '15sec', (c) => `${num(c)}sec`),
  form('n', 'SEC', '15 SEC', (c) => `${num(c)} SEC`),
  form('n', 'quote', '15"', (c) => ({ show: `${num(c)}"`, note: '초를 큰따옴표(")로 적는다.' })),
  form('n', 's', '15s', (c) => `${num(c)}s`),
  form('n', 'bunryang', '15초 분량', (c) => `${num(c)}초 분량`),
  form('n', 'hoedang', '회당 15초', (c) => `회당 ${num(c)}초`),
  form('n', 'en_seconds', '15 seconds', (c) => `${num(c)} seconds`, en),
  form('n', 'zh_miao', '15秒', (c) => `${num(c)}秒`, zh),
];

export const PLAYS_FORMS: readonly Form[] = [
  form('n', 'haru', '하루 100회', (c) => `하루 ${num(c)}회`),
  form('n', 'il', '일 100회', (c) => `일 ${num(c)}회`),
  form('n', 'il1', '1일 100회', (c) => `1일 ${num(c)}회`),
  form('n', 'per', '100회/일', (c) => `${num(c)}회/일`),
  form('n', 'ilil', '일일 100회', (c) => `일일 ${num(c)}회`),
  form('n', 'beon', '하루에 100번', (c) => `하루에 ${num(c)}번`),
  form('n', 'maeil', '매일 100회', (c) => `매일 ${num(c)}회`),
  form('n', 'gijun', '100회(1일 기준)', (c) => `${num(c)}회(1일 기준)`),
  form('n', 'en_times', '100 times per day', (c) => `${num(c)} times per day`, en),
  form('n', 'en_plays', '100 plays/day', (c) => `${num(c)} plays/day`, en),
  form('n', 'zh_ci', '每天100次', (c) => `每天${num(c)}次`, zh),
];

const u = (c: Ctx) => c.sem.unitWord ?? '개';

export const MIN_QTY_FORMS: readonly Form[] = [
  form('n', 'choeso', '최소 50개', (c) => `최소 ${num(c)}${u(c)}`),
  form('n', 'buteo', '50개부터', (c) => `${num(c)}${u(c)}부터`),
  form('n', 'moq', 'MOQ 50개', (c) => `MOQ ${num(c)}${u(c)}`),
  form('n', 'jumun', '최소 주문 50개', (c) => `최소 주문 ${num(c)}${u(c)}`),
  form('n', 'isang', '50개 이상', (c) => `${num(c)}${u(c)} 이상`),
  form('n', 'suryang', '최소수량 50개', (c) => `최소수량 ${num(c)}${u(c)}`),
  form('n', 'tilde', '50개~', (c) => `${num(c)}${u(c)}~`),
  form('n', 'colon', '최소 주문 수량: 50', (c) => `최소 주문 수량: ${num(c)}`),
  form('n', 'en_min', 'minimum 50 pcs', (c) => `minimum ${num(c)} pcs`, en),
  form('n', 'en_moq', 'MOQ: 50', (c) => `MOQ: ${num(c)}`, en),
  form('n', 'zh_qiding', '起订量50个', (c) => `起订量${num(c)}个`, zh),
];

// ── 하루 유동인구 ──────────────────────────────────────────
// day: 하루 숫자.  month·week·year: 그 기간의 숫자를 적는다(하루 값으로 바꾸는 것은 읽는 쪽 몫).

const src = (c: Ctx) => c.sem.src as number;
const manOk = (c: Ctx) => src(c) % 1000 === 0;
const man = (c: Ctx) => comma(src(c) / 10_000);
const PERIOD_NOTE: Record<string, string> = {
  day: '하루 기준이라는 것을 밝힌다.',
  month: '월 단위 숫자라는 것을 밝힌다. 하루 값으로 바꿔 적지 않는다.',
  week: '주 단위 숫자라는 것을 밝힌다. 하루 값으로 바꿔 적지 않는다.',
  year: '연 단위 숫자라는 것을 밝힌다. 하루 값으로 바꿔 적지 않는다.',
};
const foot = (cls: string, id: string, eg: string, make: (c: Ctx) => string, more: Partial<Form> = {}) =>
  form(cls, `${cls}.${id}`, eg, (c) => ({ show: make(c), note: PERIOD_NOTE[cls] }), more);
const needMan = { ok: manOk };

export const FOOTFALL_FORMS: readonly Form[] = [
  foot('day', 'haru_man', '하루 12만 명', (c) => `하루 ${man(c)}만 명`, needMan),
  foot('day', 'il_full', '일 120,000명', (c) => `일 ${comma(src(c))}명`),
  foot('day', 'ilpyeonggyun', '일평균 12만명', (c) => `일평균 ${man(c)}만명`, needMan),
  foot('day', 'per_il', '12만 명/일', (c) => `${man(c)}만 명/일`, needMan),
  foot('day', 'il1_full', '1일 120,000명', (c) => `1일 ${comma(src(c))}명`),
  foot('day', 'haru_avg_full', '하루 평균 120,000명', (c) => `하루 평균 ${comma(src(c))}명`),
  foot('day', 'ilil', '일일 12만 명', (c) => `일일 ${man(c)}만 명`, needMan),
  foot('day', 'en_per_day', '120,000 people per day', (c) => `${comma(src(c))} people per day`, en),
  foot('day', 'zh_rijun', '日均12万人次', (c) => `日均${man(c)}万人次`, { ...zh, ...needMan }),

  foot('month', 'wol_man', '월 250만 명', (c) => `월 ${man(c)}만 명`, needMan),
  foot('month', 'wol_full', '월 2,500,000명', (c) => `월 ${comma(src(c))}명`),
  foot('month', 'wolpyeonggyun', '월평균 250만명', (c) => `월평균 ${man(c)}만명`, needMan),
  foot('month', 'wolgan', '월간 250만 명', (c) => `월간 ${man(c)}만 명`, needMan),
  foot('month', 'handal', '한 달 250만 명', (c) => `한 달 ${man(c)}만 명`, needMan),
  foot('month', 'per_wol', '250만 명/월', (c) => `${man(c)}만 명/월`, needMan),
  foot('month', 'en_per_month', '2,500,000 people per month', (c) => `${comma(src(c))} people per month`, en),
  foot('month', 'en_million', '2.5 million per month', (c) => `${src(c) / 1_000_000} million per month`, { ...en, ok: (c) => src(c) % 10_000 === 0 && src(c) >= 1_000_000 }),
  foot('month', 'zh_yuejun', '月均250万人次', (c) => `月均${man(c)}万人次`, { ...zh, ...needMan }),

  foot('week', 'ju_man', '주 70만 명', (c) => `주 ${man(c)}만 명`, needMan),
  foot('week', 'jugan', '주간 70만명', (c) => `주간 ${man(c)}만명`, needMan),
  foot('week', 'judang_full', '주당 700,000명', (c) => `주당 ${comma(src(c))}명`),
  foot('week', 'per_ju', '70만 명/주', (c) => `${man(c)}만 명/주`, needMan),
  foot('week', 'ju_avg', '주 평균 70만 명', (c) => `주 평균 ${man(c)}만 명`, needMan),
  foot('week', 'en_per_week', '700,000 people per week', (c) => `${comma(src(c))} people per week`, en),
  foot('week', 'zh_meizhou', '每周70万人次', (c) => `每周${man(c)}万人次`, { ...zh, ...needMan }),

  foot('year', 'yeon_man', '연 3,000만 명', (c) => `연 ${man(c)}만 명`, needMan),
  foot('year', 'yeongan', '연간 3,000만명', (c) => `연간 ${man(c)}만명`, needMan),
  foot('year', 'yeon_full', '연 30,000,000명', (c) => `연 ${comma(src(c))}명`),
  foot('year', 'per_nyeon', '3,000만 명/년', (c) => `${man(c)}만 명/년`, needMan),
  foot('year', 'yeongan_full', '연간 30,000,000명', (c) => `연간 ${comma(src(c))}명`),
  foot('year', 'en_per_year', '30,000,000 people per year', (c) => `${comma(src(c))} people per year`, en),
  foot('year', 'zh_nian', '年3,000万人次', (c) => `年${man(c)}万人次`, { ...zh, ...needMan }),
];

// ── 일수: 마감(소재·환불·예약·시안) ────────────────────────
// day: 일수 그대로.  week: 주·달 단위.  hour: 시간 단위(24로 나누어떨어질 때만).

const WEEK_WORDS: Record<number, readonly string[]> = { 7: ['1주', '1주일'], 14: ['2주', '2주일'], 21: ['3주', '3주일'], 30: ['1개월', '한 달'] };
const EN_SPAN: Record<number, string> = { 7: '1 week', 14: '2 weeks', 21: '3 weeks', 30: '1 month' };
const ZH_SPAN: Record<number, string> = { 7: '1周', 14: '2周', 21: '3周', 30: '1个月' };
export const isWeekable = (days: number) => days in WEEK_WORDS;

const WEEK_NOTE = '주·달 단위로 적는다. 일수로 바꿔 적지 않는다.';
/** 그 갈래의 낱말로 적은 기간. "7일" 또는 "1주" */
const span = (c: Ctx, cls: string) => (cls === 'week' ? c.r.pick(WEEK_WORDS[num(c)] as readonly string[]) : `${num(c)}일`);
const spanEn = (c: Ctx, cls: string) => (cls === 'week' ? (EN_SPAN[num(c)] as string) : `${num(c)} days`);
const spanZh = (c: Ctx, cls: string) => (cls === 'week' ? (ZH_SPAN[num(c)] as string) : `${num(c)}天`);

type DeadlineField = 'material_deadline_days' | 'refund_full_days' | 'booking_deadline_days' | 'design_deadline_days';
const DL: Record<DeadlineField, { subj: string; topic: string; anchor: string; submit: string }> = {
  material_deadline_days: { subj: '소재', topic: '소재는', anchor: '게재', submit: '소재 제출은' },
  refund_full_days: { subj: '전액 환불', topic: '전액 환불은', anchor: '게재', submit: '' },
  booking_deadline_days: { subj: '예약', topic: '예약은', anchor: '게재', submit: '' },
  design_deadline_days: { subj: '시안', topic: '시안은', anchor: '행사', submit: '시안 제출은' },
};
const dl = (c: Ctx) => DL[c.field as DeadlineField];
const isRefund = (c: Ctx) => c.field === 'refund_full_days';
const isBooking = (c: Ctx) => c.field === 'booking_deadline_days';

/** 조각(tok)을 그 칸의 말에 끼운 본보기 */
function around(c: Ctx, tok: string): string {
  const { topic, anchor } = dl(c);
  if (isRefund(c)) return `${anchor} ${tok} 전액 환불`;
  if (isBooking(c)) return `${anchor} ${tok} 예약`;
  return `${topic} ${anchor} ${tok}`;
}

function deadlineForms(): Form[] {
  const out: Form[] = [];
  const add = (classes: string[], id: string, eg: string, make: (c: Ctx, cls: string) => { tok: string; show: string }, more: Partial<Form> = {}) => {
    for (const cls of classes) {
      out.push(
        form(cls, `${cls}.${id}`, eg, (c) => {
          const { tok, show } = make(c, cls);
          return { show, tokens: [tok], note: [cls === 'week' ? WEEK_NOTE : cls === 'hour' ? '시간 단위로 적는다. 일수로 바꿔 적지 않는다.' : '', `조각("${tok}")은 글자 그대로. 앞뒤 말은 바꿔도 되지만 어느 칸의 날짜인지 읽으면 알 수 있어야 한다.`].filter(Boolean).join(' ') };
        }, more),
      );
    }
  };
  const both = ['day', 'week'];
  add(both, 'jeonkkaji', '게재 7일 전까지', (c, cls) => {
    const tok = `${span(c, cls)} 전까지`;
    return { tok, show: around(c, tok) };
  });
  add(both, 'jeon_magam', '게재 7일 전 마감', (c, cls) => {
    const tok = `${span(c, cls)} 전 마감`;
    return { tok, show: `${dl(c).subj}: ${dl(c).anchor} ${tok}` };
  });
  add(['day'], 'dminus', 'D-7', (c) => ({ tok: `D-${num(c)}`, show: `${dl(c).subj} 기한 D-${num(c)}` }));
  add(both, 'yeoyu', '최소 7일 여유', (c, cls) => {
    const tok = `최소 ${span(c, cls)} 여유`;
    return { tok, show: `${dl(c).topic} ${dl(c).anchor}까지 ${tok}` };
  }, { ok: (c) => !isRefund(c) });
  add(both, 'ijeon', '게재 7일 이전', (c, cls) => {
    const tok = `${span(c, cls)} 이전`;
    const { anchor, submit } = dl(c);
    return { tok, show: isRefund(c) ? `${anchor} ${tok} 취소 시 전액 환불` : isBooking(c) ? `${anchor} ${tok} 예약` : `${submit} ${anchor} ${tok}` };
  });
  add(['day'], 'bizday', '영업일 기준 7일 전', (c) => {
    const tok = `영업일 기준 ${num(c)}일 전`;
    return { tok, show: `${dl(c).topic} ${dl(c).anchor}일로부터 ${tok}` };
  });
  add(both, 'anchor_il', '게재일 7일 전', (c, cls) => {
    const tok = `${dl(c).anchor}일 ${span(c, cls)} 전`;
    return { tok, show: `${dl(c).subj} 마감: ${tok}` };
  });
  add(both, 'cancel', '7일 전 취소', (c, cls) => {
    const tok = `${span(c, cls)} 전 취소`;
    return { tok, show: `${dl(c).anchor} ${tok} 시 전액 환불` };
  }, { ok: isRefund });
  add(['hour'], 'hours', '72시간 전까지', (c) => {
    const tok = `${num(c) * 24}시간 전까지`;
    return { tok, show: around(c, tok) };
  });
  add(both, 'en_before', '7 days before', (c, cls) => {
    const tok = `${spanEn(c, cls)} before`;
    const lead = isRefund(c) ? 'full refund until' : isBooking(c) ? 'booking closes' : c.field === 'design_deadline_days' ? 'artwork due' : 'materials due';
    return { tok, show: `${lead} ${tok}` };
  }, en);
  add(both, 'zh_tiqian', '提前7天', (c, cls) => {
    const tok = `提前${spanZh(c, cls)}`;
    return { tok, show: isRefund(c) ? `${tok}取消可全额退款` : isBooking(c) ? `需${tok}预订` : c.field === 'design_deadline_days' ? `设计稿需${tok}提交` : `素材需${tok}提交` };
  }, zh);
  return out;
}

export const DEADLINE_FORMS: readonly Form[] = deadlineForms();

// ── 일수: 제작 기간 ────────────────────────────────────────

function leadForms(): Form[] {
  const out: Form[] = [];
  const add = (classes: string[], id: string, eg: string, make: (c: Ctx, cls: string) => string, more: Partial<Form> = {}) => {
    for (const cls of classes) out.push(form(cls, `${cls}.${id}`, eg, (c) => ({ show: make(c, cls), ...(cls === 'week' ? { note: WEEK_NOTE } : {}) }), more));
  };
  const both = ['day', 'week'];
  add(both, 'gigan', '제작 기간 7일', (c, cls) => `제작 기간 ${span(c, cls)}`);
  add(both, 'soyo', '7일 소요', (c, cls) => `${span(c, cls)} 소요`);
  add(both, 'after', '주문 후 7일', (c, cls) => `주문 후 ${span(c, cls)}`);
  add(both, 'napgi', '납기 7일', (c, cls) => `납기 ${span(c, cls)}`);
  add(both, 'inae', '7일 이내 제작', (c, cls) => `${span(c, cls)} 이내 제작`);
  add(both, 'jejage', '제작에 7일', (c, cls) => `제작에 ${span(c, cls)}`);
  add(['day'], 'bizday', '영업일 기준 7일', (c) => `영업일 기준 ${num(c)}일`);
  add(['day'], 'jakeop', '작업일 7일', (c) => `작업일 ${num(c)}일`);
  add(both, 'en_lead', 'lead time: 7 days', (c, cls) => `lead time: ${spanEn(c, cls)}`, en);
  add(both, 'zh_zhouqi', '制作周期7天', (c, cls) => `制作周期${spanZh(c, cls)}`, zh);
  return out;
}

export const LEAD_FORMS: readonly Form[] = leadForms();

// ── 부가세 ─────────────────────────────────────────────────

const inc = (c: Ctx) => c.value === true;
const pw = (c: Ctx) => (inc(c) ? '포함' : '별도');

export const VAT_FORMS: readonly Form[] = [
  form('b', 'bugase', '부가세 포함 · 부가세 별도', (c) => `부가세 ${pw(c)}`),
  form('b', 'vat', 'VAT 포함 · VAT 별도', (c) => `VAT ${pw(c)}`),
  form('b', 'bugagachi', '부가가치세 별도', (c) => `부가가치세 ${pw(c)}`),
  form('b', 'vat_tight', 'VAT별도', (c) => `VAT${pw(c)}`),
  form('b', 'ten', '부가세 10% 별도', (c) => `부가세 10% ${pw(c)}`),
  form('b', 'dotted', 'V.A.T 별도', (c) => `V.A.T ${pw(c)}`),
  form('b', 'mipoham', '부가세 미포함', () => '부가세 미포함', { ok: (c) => !inc(c) }),
  form('b', 'ga', '부가세 포함가', (c) => `부가세 ${pw(c)}가`),
  form('b', 'en_vat', 'VAT excluded', (c) => `VAT ${inc(c) ? 'included' : 'excluded'}`, en),
  form('b', 'en_abbr', 'excl. VAT', (c) => `${inc(c) ? 'incl.' : 'excl.'} VAT`, en),
  form('b', 'zh_shui', '含税 · 不含税', (c) => (inc(c) ? '含税' : '不含税'), zh),
];

// ── 파일 형식 ──────────────────────────────────────────────

const fs = (c: Ctx) => c.value as string[];
const up = (c: Ctx) => fs(c).map((x) => x.toUpperCase());
const many = { ok: (c: Ctx) => fs(c).length >= 2 };
const lastJoin = (items: string[], word: string) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`);

export const FORMAT_FORMS: readonly Form[] = [
  form('f', 'upper_comma', 'JPG, MP4', (c) => up(c).join(', ')),
  form('f', 'lower_comma', 'jpg, mp4', (c) => fs(c).join(', ')),
  form('f', 'slash', 'jpg/mp4', (c) => fs(c).join('/'), many),
  form('f', 'middot', 'JPG·MP4', (c) => up(c).join('·'), many),
  form('f', 'dot_ext', '.jpg, .mp4', (c) => fs(c).map((x) => `.${x}`).join(', ')),
  form('f', 'star_ext', '*.jpg, *.mp4', (c) => fs(c).map((x) => `*.${x}`).join(', ')),
  form('f', 'ttoneun', 'JPG 또는 MP4', (c) => lastJoin(up(c), '또는'), many),
  form('f', 'mit', 'jpg 및 mp4', (c) => lastJoin(fs(c), '및'), many),
  form('f', 'jpeg', 'JPEG, MP4', (c) => ({ show: up(c).map((x) => (x === 'JPG' ? 'JPEG' : x)).join(', '), note: 'JPG 를 "JPEG"라고 적는다(같은 형식이다).' }), { ok: (c) => fs(c).includes('jpg') }),
  form('f', 'reversed', 'MP4 / JPG', (c) => [...up(c)].reverse().join(' / '), many),
  form('f', 'file_word', 'JPG, MP4 파일', (c) => `${up(c).join(', ')} 파일`),
  form('f', 'hyeongsik', 'mp4 형식', (c) => `${fs(c).join(', ')} 형식`),
  form('f', 'en_or', 'JPG or MP4', (c) => lastJoin(up(c), 'or'), { ...en, ...many }),
  form('f', 'zh_dun', 'JPG、MP4', (c) => up(c).join('、'), { ...zh, ...many }),
];

// ── 값표: 기간별·수량별 ────────────────────────────────────
// 꼴은 "짝을 어떻게 늘어놓는가"다. 기간(수량)을 적는 낱말과 금액 꼴은 보조 갈래로 따로 고른다.

interface Layout {
  id: string;
  eg: string;
  tableOnly?: boolean;
  /** 영어·중국어 낱말과 함께 써도 어색하지 않은가 */
  neutral: boolean;
  /** 수 옆에 단위가 없는 금액 꼴과 함께 쓸 수 있는가 */
  bareOk: boolean;
  pair?: (w: string, m: string) => string;
  join?: string;
  note?: string;
}

const LAYOUTS: readonly Layout[] = [
  { id: 'slash', eg: '1주 150만원 / 2주 280만원', neutral: true, bareOk: true, pair: (w, m) => `${w} ${m}`, join: ' / ' },
  { id: 'colon', eg: '1주: 150만원, 2주: 280만원', neutral: true, bareOk: true, pair: (w, m) => `${w}: ${m}`, join: ', ' },
  { id: 'arrow', eg: '1주 → 150만원, 2주 → 280만원', neutral: true, bareOk: true, pair: (w, m) => `${w} → ${m}`, join: ', ' },
  { id: 'paren', eg: '1주(150만원), 2주(280만원)', neutral: true, bareOk: true, pair: (w, m) => `${w}(${m})`, join: ', ' },
  { id: 'price_first', eg: '150만원(1주) / 280만원(2주)', neutral: true, bareOk: false, pair: (w, m) => `${m}(${w})`, join: ' / ', note: '금액을 먼저 적고 기간(수량)을 괄호에 넣는다.' },
  { id: 'e', eg: '1주에 150만원, 2주에 280만원', neutral: false, bareOk: false, pair: (w, m) => `${w}에 ${m}`, join: ', ' },
  { id: 'dash', eg: '1주 - 150만원 · 2주 - 280만원', neutral: true, bareOk: true, pair: (w, m) => `${w} - ${m}`, join: ' · ' },
  { id: 'equals', eg: '1주=150만원, 2주=280만원', neutral: true, bareOk: true, pair: (w, m) => `${w}=${m}`, join: ', ' },
  { id: 'gijun', eg: '1주 기준 150만원, 2주 기준 280만원', neutral: false, bareOk: false, pair: (w, m) => `${w} 기준 ${m}`, join: ', ' },
  { id: 'bracket', eg: '[1주] 150만원 [2주] 280만원', neutral: true, bareOk: true, pair: (w, m) => `[${w}] ${m}`, join: ' ' },
  { id: 'per_slash', eg: '150만원/1주, 280만원/2주', neutral: true, bareOk: false, pair: (w, m) => `${m}/${w}`, join: ', ', note: '금액을 먼저 적고 빗금 뒤에 기간(수량)을 적는다.' },
  { id: 'lines', eg: '- 1주 150만원 (줄마다 하나)', neutral: true, bareOk: true, pair: (w, m) => `- ${w} ${m}`, join: '\n', note: '짝마다 줄을 바꿔 적는다.' },
  { id: 'pipe', eg: '1주 | 150만원 (줄마다 하나)', tableOnly: true, neutral: true, bareOk: true, pair: (w, m) => `${w} | ${m}`, join: '\n', note: '표의 한 줄에 짝 하나씩 적는다.' },
  { id: 'tab', eg: '1주⇥150만원 (탭으로 나눈 줄)', tableOnly: true, neutral: true, bareOk: true, pair: (w, m) => `${w}\t${m}`, join: '\n', note: '기간(수량)과 금액 사이는 탭 문자 하나다. 표의 한 줄에 짝 하나씩 적는다.' },
  {
    id: 'rows', eg: '기간 | 1주 | 2주 ⏎ 금액 | 150만원 | 280만원', tableOnly: true, neutral: true, bareOk: true,
    note: '기간(수량)을 한 줄에, 금액을 그 아랫줄에 같은 순서로 적는다(가로로 긴 표). 줄 머리의 말은 바꿔도 된다.',
  },
];

const PERIOD_STYLES: Record<string, { lang?: 'en' | 'zh'; words: Record<number, string> }> = {
  ko_week: { words: { 1: '1일', 7: '1주', 14: '2주', 21: '3주', 28: '4주', 30: '1개월', 90: '3개월' } },
  ko_days: { words: { 1: '1일', 7: '7일', 14: '14일', 21: '21일', 28: '28일', 30: '30일', 90: '90일' } },
  ko_juil: { words: { 1: '1일', 7: '1주일', 14: '2주일', 21: '3주일', 28: '4주일', 30: '한 달', 90: '3개월' } },
  en: { lang: 'en', words: { 1: '1 day', 7: '1 week', 14: '2 weeks', 21: '3 weeks', 28: '4 weeks', 30: '1 month', 90: '3 months' } },
  zh: { lang: 'zh', words: { 1: '1天', 7: '1周', 14: '2周', 21: '3周', 28: '4周', 30: '1个月', 90: '3个月' } },
};

const QTY_WORDS: Record<string, { en: string; zh: string }> = { 잔: { en: 'cups', zh: '杯' }, 개: { en: 'boxes', zh: '份' }, 인분: { en: 'servings', zh: '份' } };

type PeriodOption = { days: number; price_krw: number };
type QuantityOption = { qty: number; price_krw: number };

function optionForms(kind: 'period' | 'qty'): Form[] {
  return LAYOUTS.map((lay) =>
    form('t', lay.id, lay.eg, (c) => {
      const money = c.money as MoneyForm;
      const foreign = lay.neutral && c.langOk;
      let style: string;
      let words: string[];
      if (kind === 'period') {
        const options = c.value as PeriodOption[];
        const pool = ['ko_week', 'ko_days', 'ko_juil', ...(c.sem.words ? ['ko_mix'] : []), ...(foreign ? ['en', 'zh'] : [])];
        style = c.r.pick(pool);
        words = style === 'ko_mix' ? (c.sem.words as string[]) : options.map((o) => (PERIOD_STYLES[style] as { words: Record<number, string> }).words[o.days] as string);
      } else {
        const options = c.value as QuantityOption[];
        const unit = u(c);
        style = c.r.pick(['ko', 'ko', 'ko_sp', ...(foreign ? ['en', 'zh'] : [])]);
        words = options.map((o) => (style === 'ko' ? `${o.qty}${unit}` : style === 'ko_sp' ? `${o.qty} ${unit}` : style === 'en' ? `${o.qty} ${(QTY_WORDS[unit] as { en: string }).en}` : `${o.qty}${(QTY_WORDS[unit] as { zh: string }).zh}`));
      }
      const prices = (c.value as { price_krw: number }[]).map((o) => money.fmt(o.price_krw));
      const base = kind === 'period' ? '기간마다 값을 짝지어 쓴다.' : '수량마다 값을 짝지어 쓴다.';
      const notes = [money.note, base, lay.note, '짝의 조각은 글자 그대로(사이의 기호와 띄어쓰기까지).'].filter(Boolean).join(' ');
      const parts = { money: money.id, words: style };
      const unitDecl = money.unit ? { unit: money.unit, ...(money.silent ? { silent: true } : {}) } : {};
      if (!lay.pair) {
        const head = kind === 'period' ? '기간' : '수량';
        return { show: `${head} | ${words.join(' | ')}\n금액 | ${prices.join(' | ')}`, tokens: [...words, ...prices], note: notes, parts, ...unitDecl };
      }
      const pairs = words.map((w, i) => (lay.pair as (w: string, m: string) => string)(w, prices[i] as string));
      return { show: pairs.join(lay.join), tokens: pairs, note: notes, parts, ...unitDecl };
    }, { ...(lay.tableOnly ? { tableOnly: true } : {}), ok: (c) => lay.bareOk || !(c.money as MoneyForm).unit }),
  );
}

export const PERIOD_FORMS: readonly Form[] = optionForms('period');
export const QUANTITY_FORMS: readonly Form[] = optionForms('qty');

// ── 칸 → 꼴 묶음 ───────────────────────────────────────────

export interface Group {
  name: string;
  forms: readonly Form[];
  /** 꼴이 적어도 몇 가지여야 하는가 */
  min: number;
}

const DEADLINE: Group = { name: 'deadline', forms: DEADLINE_FORMS, min: 8 };
const HOURS: Group = { name: 'hours', forms: HOURS_FORMS, min: 12 };

/** 금액 칸(price_krw, list_price_krw)은 MONEY_FORMS 를 쓴다. 글 칸(name, region, service_region, material)은 꼴이 하나다(글자 그대로). */
export const GROUPS: Partial<Record<FieldKey, Group>> = {
  vat_included: { name: 'vat', forms: VAT_FORMS, min: 8 },
  size_m: { name: 'size_m', forms: SIZE_M_FORMS, min: 12 },
  resolution_px: { name: 'res', forms: RESOLUTION_FORMS, min: 8 },
  hours: HOURS,
  spot_seconds: { name: 'spot', forms: SPOT_FORMS, min: 8 },
  plays_per_day: { name: 'plays', forms: PLAYS_FORMS, min: 8 },
  footfall_per_day: { name: 'footfall', forms: FOOTFALL_FORMS, min: 12 },
  period_options: { name: 'period', forms: PERIOD_FORMS, min: 12 },
  material_deadline_days: DEADLINE,
  file_format: { name: 'formats', forms: FORMAT_FORMS, min: 8 },
  refund_full_days: DEADLINE,
  booking_deadline_days: DEADLINE,
  quantity_options: { name: 'qty', forms: QUANTITY_FORMS, min: 12 },
  service_hours: HOURS,
  design_deadline_days: DEADLINE,
  size_mm: { name: 'size_mm', forms: SIZE_MM_FORMS, min: 12 },
  lead_time_days: { name: 'lead', forms: LEAD_FORMS, min: 8 },
  min_order_qty: { name: 'minqty', forms: MIN_QTY_FORMS, min: 8 },
};

export const MONEY_MIN = 12;
export const MONEY_FIELDS: readonly FieldKey[] = ['price_krw', 'list_price_krw'];
export const TEXT_FIELDS: readonly FieldKey[] = ['name', 'region', 'service_region', 'material'];
export const MONEY_NOTE = VERBATIM;
