// 칸별 꼴 분포표(글). 원문을 쓰기 전에 표기가 고르게 퍼졌는지 사람이 본다. 건수만 적고 원문이나 정답 값은 적지 않는다.
import { fieldDef, type FieldKey } from '@/contract/fields';
import { FORM_SHARE_CAP, definedFormCount, formTable, shareCap, type FormRow } from './assign';
import { GROUPS, MONEY_FIELDS, MONEY_MIN } from './forms';
import type { GoldSpec } from './spec';

export interface FieldSummary {
  field: FieldKey;
  dev: number;
  test: number;
  /** 마련해 둔 꼴의 수 */
  defined: number;
  /** 적어도 있어야 하는 꼴의 수 */
  required: number;
  /** 실제로 쓴 꼴의 수 */
  used: number;
  /** 가장 많이 쓴 꼴의 건수 */
  top: number;
  /** 전체에서 한 꼴이 넘으면 안 되는 건수 */
  cap: number;
  /** 안 여는 세트에만 나온 꼴의 수 */
  testOnly: number;
  rows: FormRow[];
}

export function summarizeForms(specs: readonly GoldSpec[]): FieldSummary[] {
  const rows = formTable(specs);
  const fields = [...new Set(rows.map((r) => r.field))];
  return fields.map((field) => {
    const mine = rows.filter((r) => r.field === field);
    const dev = mine.reduce((a, r) => a + r.dev, 0);
    const test = mine.reduce((a, r) => a + r.test, 0);
    return {
      field,
      dev,
      test,
      defined: definedFormCount(field),
      required: MONEY_FIELDS.includes(field) ? MONEY_MIN : (GROUPS[field]?.min ?? 1),
      used: mine.length,
      top: Math.max(...mine.map((r) => r.dev + r.test)),
      cap: shareCap(dev + test),
      testOnly: mine.filter((r) => r.dev === 0).length,
      rows: mine,
    };
  });
}

const pct = (n: number, d: number) => `${n}/${d}`;
const cell = (s: string) => s.replace(/\|/g, '\\|');

/** 보조 갈래(값표 안의 금액 꼴, 기간·수량 낱말 꼴)의 건수 */
function partCounts(specs: readonly GoldSpec[], field: FieldKey, part: string): [string, number, number][] {
  const m = new Map<string, [number, number]>();
  for (const s of specs) {
    const v = s.surface_hints.find((h) => h.field === field)?.parts?.[part];
    if (!v) continue;
    const row = m.get(v) ?? [0, 0];
    row[s.split === 'dev' ? 0 : 1] += 1;
    m.set(v, row);
  }
  return [...m.entries()].map(([k, [d, t]]) => [k, d, t] as [string, number, number]).sort((a, b) => b[1] + b[2] - (a[1] + a[2]) || a[0].localeCompare(b[0]));
}

export function formsReport(specs: readonly GoldSpec[], seed: number): string {
  const sums = summarizeForms(specs);
  const out: string[] = [];
  out.push('# 칸별 표기 꼴 분포', '');
  out.push(`- 씨앗 ${seed} · 정답 ${specs.length}건(연습 ${specs.filter((s) => s.split === 'dev').length}, 안 여는 세트 ${specs.filter((s) => s.split === 'test').length})`);
  out.push('- 이 표는 기계가 센 건수다. 원문은 아직 없다. 원문 쓰는 이는 묶음 파일의 표기 지시를 그대로 따른다.');
  out.push(`- 규칙: 한 꼴이 그 칸 문서(100건 가운데 그 칸에 값이 있는 문서)의 ${FORM_SHARE_CAP * 100}% 를 넘지 않는다. 안 여는 세트에만 나오는 꼴은 그 칸에서 쓴 꼴의 절반을 넘지 않는다.`);
  out.push('- 글 칸(상품 이름, 위치, 출장 지역, 재질)은 정답 글자 그대로 적으므로 꼴이 하나다. 이 표에 없다.');
  out.push('- 정가는 그 문서의 판매가와 같은 금액 꼴을 쓴다(한 문서 안에서 금액 꼴은 하나다).');
  out.push('- 꼴 이름의 앞머리가 값의 갈래다. 예: `size_m:mm_x` 는 크기(m) 칸을 mm 로 적는 꼴, `footfall:month.…` 는 월 단위 숫자, `deadline:week.…` 는 주·달 단위, `hours:` 의 `ampm`·`ko_` 는 오전·오후.');
  out.push('  단위를 바꿔 적는 갈래(mm·cm, 오전·오후, 24시 넘김·익일, 월·주·연 유동인구, 주·달 단위 일수, 단위를 줄인 금액)는 "단위" 함정이 붙은 문서에만 쓴다. 함정 표시는 바꾸지 않았다.');
  out.push('', '## 한눈에', '');
  out.push('| 칸 | 문서(연습/안 여는) | 마련한 꼴 | 있어야 하는 꼴 | 쓴 꼴 | 가장 많이 쓴 꼴(건/상한) | 안 여는 세트에만 있는 꼴 |');
  out.push('|---|---|---|---|---|---|---|');
  for (const s of sums) {
    out.push(`| ${fieldDef(s.field).label} \`${s.field}\` | ${s.dev + s.test} (${s.dev}/${s.test}) | ${s.defined} | ${s.required} | ${s.used} | ${pct(s.top, s.cap)} | ${pct(s.testOnly, s.used)} |`);
  }
  const few = sums.filter((s) => s.used < s.required);
  if (few.length > 0) {
    out.push('', `쓴 꼴이 "있어야 하는 꼴"보다 적은 칸: ${few.map((s) => `${fieldDef(s.field).label}(${s.used}가지, 문서 ${s.dev + s.test}건)`).join(', ')}.`);
    out.push('문서 수가 적어서다. 꼴은 넉넉히 마련돼 있지만, 안 여는 세트에만 있는 꼴을 절반 아래로 묶으면 연습 건수의 두 배까지만 쓸 수 있다.');
  }
  for (const s of sums) {
    out.push('', `## ${fieldDef(s.field).label} \`${s.field}\``, '');
    out.push(`문서 ${s.dev + s.test}건(연습 ${s.dev}, 안 여는 세트 ${s.test}) · 쓴 꼴 ${s.used}가지 / 마련한 꼴 ${s.defined}가지`, '');
    out.push('| 꼴 이름 | 본보기 | dev 건수 | test 건수 |', '|---|---|---|---|');
    for (const r of s.rows) out.push(`| \`${r.form}\` | ${cell(r.eg)} | ${r.dev} | ${r.test} |`);
    const usedIds = new Set(s.rows.map((r) => r.form.slice(r.form.indexOf(':') + 1)));
    const unused = (GROUPS[s.field]?.forms ?? []).filter((f) => !usedIds.has(f.id));
    if (unused.length > 0) out.push('', `이번 씨앗에서 안 쓴 꼴: ${unused.map((f) => `\`${f.id}\`(${cell(f.eg)})`).join(', ')}`);
    for (const [part, name] of [['words', '기간·수량을 적는 낱말'], ['money', '값표 안의 금액 꼴']] as const) {
      const counts = partCounts(specs, s.field, part);
      if (counts.length === 0) continue;
      out.push('', `보조 갈래 — ${name}:`, '', '| 갈래 | dev 건수 | test 건수 |', '|---|---|---|');
      for (const [k, d, t] of counts) out.push(`| \`${k}\` | ${d} | ${t} |`);
    }
  }
  out.push('');
  return out.join('\n');
}
