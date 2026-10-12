// 크기 맞추기. "7*12(m)", "7m x 12m", "700×1200mm" → 바라는 단위의 가로·세로.
import type { NormalizeResult } from '@/contract/core-api';
import type { SizeM, SizeMm } from '@/contract/fields';
import { plain, read, unread } from '../text';

type Unit = 'mm' | 'cm' | 'm';
const TO_MM: Record<Unit, number> = { mm: 1, cm: 10, m: 1000 };
const UNIT_WORD = '밀리미터|센티미터|밀리|센티|미터|毫米|厘米|mm|cm|m|米';
const UNIT_OF: Record<string, Unit> = {
  mm: 'mm', 밀리미터: 'mm', 밀리: 'mm', 毫米: 'mm',
  cm: 'cm', 센티미터: 'cm', 센티: 'cm', 厘米: 'cm',
  m: 'm', 미터: 'm', 米: 'm',
};

const NUMBER_WITH_UNIT = new RegExp(String.raw`(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:(${UNIT_WORD})(?![a-wyz]))?`, 'g');
/** 수에 붙지 않고 따로 적힌 단위. "(m)", "단위: mm" */
const LOOSE_UNIT = new RegExp(String.raw`(?:^|[^a-z가-힣])(${UNIT_WORD})(?![a-z])`);
const WIDTH = /가로|폭|너비|width|(?<![a-z])w(?![a-z])|宽/;
const HEIGHT = /세로|높이|height|(?<![a-z])h(?![a-z])|高/;
/** 종이 규격. 수가 없고 이름만 적혔을 때만 쓴다(mm). */
const PAPER: Record<string, [number, number]> = { a3: [297, 420], a4: [210, 297], a5: [148, 210], a6: [105, 148] };

function side(text: string): 'w' | 'h' | null {
  const w = WIDTH.test(text);
  const h = HEIGHT.test(text);
  if (w === h) return null;
  return w ? 'w' : 'h';
}

/** "(세로*가로)" 처럼 두 말이 함께 적혔으면 세로가 먼저인지 본다. 둘 다 없으면 null. */
function heightFirst(text: string): boolean | null {
  const w = text.search(WIDTH);
  const h = text.search(HEIGHT);
  return w < 0 || h < 0 ? null : h < w;
}

/**
 * 가로·세로를 읽어 mm 로 낸다.
 * 못 읽는 것: 단위가 어디에도 없음, 수가 둘이 아님(두께까지 셋, 지름 하나), 픽셀·인치.
 */
function readMm(raw: string): { w: number; h: number; units: [Unit, Unit]; fromName?: boolean } | null {
  const full = plain(raw);
  if (/px|픽셀|pixel|인치|inch|"/.test(full)) return null;

  // 종이 이름은 수로 세지 않는다. "A4(210x297mm)" 는 괄호 안의 수를 읽는다.
  const paper = /(?:^|[^a-z0-9])(a[3-6])(?![a-z0-9])/.exec(raw.normalize('NFKC').toLowerCase());
  const t = paper ? full.replace(paper[1]!, ' ') : full;
  const nums = [...t.matchAll(NUMBER_WITH_UNIT)];
  if (nums.length === 0 && paper) {
    const [short, long] = PAPER[paper[1]!]!;
    // "A4 가로"는 눕힌 종이다.
    const flat = /가로|landscape|横/.test(t) && !/세로|portrait|竖/.test(t);
    return { w: flat ? long : short, h: flat ? short : long, units: ['mm', 'mm'], fromName: true };
  }
  if (nums.length !== 2) return null;
  const [a, b] = nums as [RegExpExecArray, RegExpExecArray];
  const before = t.slice(0, a.index);
  const between = t.slice(a.index + a[0].length, b.index);
  const after = t.slice(b.index + b[0].length);

  // 두 수 사이에 곱하기 표시나 가로·세로 말이 있어야 크기다.
  if (!/[x×*]|by/.test(between) && !WIDTH.test(t) && !HEIGHT.test(t)) return null;

  let ua = a[2] ? UNIT_OF[a[2]] : undefined;
  let ub = b[2] ? UNIT_OF[b[2]] : undefined;
  if (!ua && !ub) {
    const rest = before + ' ' + between + ' ' + after;
    const loose = LOOSE_UNIT.exec(rest);
    if (!loose) return null;
    ua = ub = UNIT_OF[loose[1]!];
  }
  ua ??= ub;
  ub ??= ua;
  if (!ua || !ub) return null;

  let w = Number(a[1]!.replace(/,/g, '')) * TO_MM[ua];
  let h = Number(b[1]!.replace(/,/g, '')) * TO_MM[ub];
  let units: [Unit, Unit] = [ua, ub];

  // 가로·세로 말이 수 앞에 붙었는지 뒤에 붙었는지 보고 자리를 정한다.
  // 수 뒤에 붙는 꼴("7m 가로, 12m 세로")은 맨 뒤에 말이 있을 때뿐이다. 그 밖에 사이의 말은 뒤의 수에 딸린다("12m x 가로 7m").
  const trailing = side(before) === null && side(after) !== null;
  let first = trailing ? side(between) : side(before);
  const second = trailing ? side(after) : side(between);
  if (first !== null && first === second) return null;
  // 순서를 따로 적은 꼴: "7 * 12 m (세로*가로)", "크기(세로x가로) 7x12m"
  if (first === null && second === null) {
    const flipped = heightFirst(after) ?? heightFirst(before) ?? heightFirst(between);
    if (flipped) first = 'h';
  }
  if (first === 'h' || (first === null && second === 'w')) {
    [w, h] = [h, w];
    units = [ub, ua];
  }
  return { w, h, units };
}

export function normalizeSize(raw: string, unit: 'm'): NormalizeResult<SizeM>;
export function normalizeSize(raw: string, unit: 'mm'): NormalizeResult<SizeMm>;
export function normalizeSize(raw: string, unit: 'm' | 'mm'): NormalizeResult<SizeM | SizeMm> {
  const got = readMm(raw);
  if (!got) return unread();
  const fit = (mm: number) => (unit === 'm' ? Math.round(mm / 10) / 100 : Math.round(mm));
  // 단위를 바꿨거나 종이 이름("A4")에서 치수를 찾아 넣었으면 사람이 본다.
  const converted = got.fromName === true || got.units.some((u) => u !== unit);
  return read({ width: fit(got.w), height: fit(got.h) }, converted ? ['UNIT_CONVERTED'] : []);
}

/** "1920x1080", "1920 × 1080px" → 가로·세로 픽셀. 쌍이 하나일 때만 읽는다. */
export function normalizeResolution(raw: string): NormalizeResult<{ width: number; height: number }> {
  const pairs = [...plain(raw).matchAll(/(?<![\d.])(\d{3,5})\s*[x×*]\s*(\d{3,5})(?![\d.])/g)];
  if (pairs.length !== 1) return unread();
  return read({ width: Number(pairs[0]![1]), height: Number(pairs[0]![2]) });
}
