// 정답 만들기, 검산, 묶음 나누기, 조립, 내보내기 계획. DB 없이 돈다.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOLD_STYLES, GoldDocSchema, type GoldDoc } from '@/contract/eval-types';
import { FIELDS_BY_TYPE } from '@/contract/fields';
import { GOLD_VERSION, assemble, writeAssembled, type WrittenDoc } from './assemble';
import { splitBatches, writerGuide } from './batches';
import { alikePairs, checkDoc, cleanIndexes, lengthStats, shapeOf } from './check';
import { canon, docsToJsonl, parseJsonl, sha256 } from './files';
import { PLAN, generateSpecs } from './generate';
import { labelEnabled } from './label';
import { OutsidePathError, realGoldFile, realIntakeFile, sealedTestFile } from './paths';
import { readDays, readFootfall, readHours, readMoney, recalc } from './recalc';
import { makeRng } from './rng';
import { DEFAULT_SEED, type GoldSpec, type SurfaceHint } from './spec';
import { planExport } from './store';

const specs = generateSpecs();
const of = (split: 'dev' | 'test') => specs.filter((s) => s.split === split);
const count = (list: GoldSpec[], pred: (s: GoldSpec) => boolean) => list.filter(pred).length;

/** 표기 조각을 모두 넣은 가짜 원문. 조립 시험에 쓴다. */
function fakeContent(spec: GoldSpec): string {
  const parts = [...spec.surface_hints.flatMap((h) => h.tokens), ...spec.must_include];
  return `${spec.id} 안내 글입니다. ${parts.join(' ')} `.padEnd(120, '가');
}
const written = (list: GoldSpec[]): WrittenDoc[] => list.map((s) => ({ id: s.id, content: fakeContent(s) }));

describe('정답 만들기', () => {
  it('씨앗이 같으면 두 번 만들어도 글자 하나 다르지 않다', () => {
    expect(JSON.stringify(generateSpecs(DEFAULT_SEED))).toBe(JSON.stringify(generateSpecs(DEFAULT_SEED)));
    expect(JSON.stringify(generateSpecs(7))).toBe(JSON.stringify(generateSpecs(7)));
  });

  it('씨앗이 다르면 다른 정답이 나온다', () => {
    expect(JSON.stringify(generateSpecs(7))).not.toBe(JSON.stringify(generateSpecs(8)));
  });

  it('연습 40건, 안 여는 세트 60건이고 번호가 겹치지 않는다', () => {
    expect(of('dev')).toHaveLength(40);
    expect(of('test')).toHaveLength(60);
    expect(new Set(specs.map((s) => s.id)).size).toBe(100);
  });

  it('광고 지면이 절반 이상이고 종류별 건수가 계획과 같다', () => {
    for (const split of ['dev', 'test'] as const) {
      const list = of(split);
      for (const type of ['ad', 'catering', 'goods', 'not_product'] as const) {
        expect(count(list, (s) => s.type === type)).toBe(PLAN[split][type]);
      }
      expect(count(list, (s) => s.type === 'ad') * 2).toBeGreaterThanOrEqual(list.length);
    }
  });

  it('꼴 다섯이 묶음마다 같은 수다', () => {
    for (const style of GOLD_STYLES) {
      expect(count(of('dev'), (s) => s.style === style)).toBe(8);
      expect(count(of('test'), (s) => s.style === style)).toBe(12);
    }
  });

  it('함정 비율이 연습과 안 여는 세트에서 같다(없는 칸 60%, 단위 40%, 값 40%)', () => {
    const rate = (split: 'dev' | 'test', trap: string) => count(of(split), (s) => (s.traps as string[]).includes(trap)) / of(split).length;
    for (const [trap, want] of [['missing_field', 0.6], ['unit', 0.4], ['price', 0.4]] as const) {
      expect(rate('dev', trap)).toBeCloseTo(want, 10);
      expect(rate('test', trap)).toBeCloseTo(want, 10);
    }
    expect(count(specs, (s) => s.traps.includes('not_product'))).toBe(5);
    expect(count(specs, (s) => s.traps.includes('instruction'))).toBe(3);
    expect(count(specs, (s) => s.traps.includes('type_confusion'))).toBe(5);
  });

  it('없는 칸 함정이 붙은 문서에는 정가 말고도 없는 칸이 있고, 안 붙은 문서에는 없다', () => {
    for (const s of specs.filter((x) => x.type !== 'not_product')) {
      const nulls = Object.entries(s.truth).filter(([k, v]) => v === null && k !== 'list_price_krw');
      if (s.traps.includes('missing_field')) expect(nulls.length, s.id).toBeGreaterThan(0);
      else expect(nulls, s.id).toHaveLength(0);
    }
  });

  it('정답은 약속의 스키마를 통과한다', () => {
    for (const s of specs) {
      const doc = { id: s.id, split: s.split, goldVersion: 1, content: '글', truth: { type: s.type, subtype: s.subtype, fields: s.truth }, author: 'ai', traps: s.traps, style: s.style };
      const parsed = GoldDocSchema.safeParse(doc);
      expect(parsed.success, `${s.id}: ${parsed.success ? '' : parsed.error.issues[0]?.message}`).toBe(true);
    }
  });

  it('칸마다 표기가 있거나 "없음"이고, 둘 다인 칸은 없다', () => {
    for (const s of specs) {
      const shown = s.surface_hints.map((h) => h.field);
      const absent = s.absent.map((a) => a.field);
      expect([...shown, ...absent].sort(), s.id).toEqual([...FIELDS_BY_TYPE[s.type]].sort());
      for (const k of shown) expect(s.truth[k], `${s.id} ${k}`).not.toBeNull();
      for (const k of absent) expect(s.truth[k], `${s.id} ${k}`).toBeNull();
    }
  });

  it('값끼리 앞뒤가 맞는다: 판매가는 가장 짧은 기간(적은 수량)의 값, 정가는 판매가보다 크고, 길수록 총액이 커진다', () => {
    for (const s of specs) {
      const t = s.truth as Record<string, unknown>;
      const options = (t.period_options ?? t.quantity_options) as { days?: number; qty?: number; price_krw: number }[] | null | undefined;
      if (options) {
        expect(t.price_krw, s.id).toBe(options[0]?.price_krw);
        for (let i = 1; i < options.length; i += 1) {
          const prev = options[i - 1] as { days?: number; qty?: number; price_krw: number };
          const cur = options[i] as { days?: number; qty?: number; price_krw: number };
          expect((cur.days ?? cur.qty ?? 0) > (prev.days ?? prev.qty ?? 0), s.id).toBe(true);
          expect(cur.price_krw > prev.price_krw, s.id).toBe(true);
        }
      }
      if (typeof t.list_price_krw === 'number') expect(t.list_price_krw > (t.price_krw as number), s.id).toBe(true);
      if (typeof t.price_krw === 'number') expect(t.price_krw, s.id).toBeGreaterThan(0);
    }
  });

  it('상품 이름이 겹치지 않는다', () => {
    const names = specs.map((s) => s.truth.name).filter(Boolean);
    expect(new Set(names).size).toBe(names.length);
  });

  it('지시문 함정에는 넣을 문장이 있고, 등록 대상이 아닌 글에는 칸이 없다', () => {
    for (const s of specs) {
      expect(s.must_include.length > 0, s.id).toBe(s.traps.includes('instruction'));
      if (s.type === 'not_product') {
        expect(s.truth).toEqual({});
        expect(s.subtype).toBeNull();
        expect(s.notes.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('검산: 원문에 적을 표기를 다시 읽으면 정답 값이 나온다', () => {
  it('정답 100건의 모든 표기가 정답 값과 맞는다', () => {
    let checked = 0;
    for (const s of specs) {
      for (const h of s.surface_hints) {
        expect(canon(recalc(h)), `${s.id} ${h.field} "${h.show}"`).toEqual(canon(s.truth[h.field]));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(800);
  });

  it('"05시~25시"는 05:00 에 열어 다음 날 01:00 에 닫는다', () => {
    expect(readHours('05시~25시')).toEqual({ open: '05:00', close: '01:00', nextDay: true });
  });

  it('"06:00~24:00"은 다음 날 00:00 에 닫는다', () => {
    expect(readHours('06:00~24:00')).toEqual({ open: '06:00', close: '00:00', nextDay: true });
  });

  it('"06시~23시"는 같은 날에 닫는다', () => {
    expect(readHours('06시~23시')).toEqual({ open: '06:00', close: '23:00', nextDay: false });
  });

  it('"24시간"은 시작과 끝이 같고 다음 날이다', () => {
    expect(readHours('24시간')).toEqual({ open: '00:00', close: '00:00', nextDay: true });
  });

  it('"오전 10시~오후 2시"는 10:00~14:00, "22:00~02:00"은 다음 날에 닫는다', () => {
    expect(readHours('오전 10시~오후 2시')).toEqual({ open: '10:00', close: '14:00', nextDay: false });
    expect(readHours('22:00~02:00')).toEqual({ open: '22:00', close: '02:00', nextDay: true });
  });

  it('월 300만 명은 하루 10만 명이다(÷30)', () => {
    expect(readFootfall('월 300만 명')).toBe(100_000);
  });

  it('월 250만은 83,333, 주 70만은 100,000, 연 3,000만은 82,192 다(반올림)', () => {
    expect(readFootfall('월 250만 명')).toBe(83_333);
    expect(readFootfall('월 2,500,000명')).toBe(83_333);
    expect(readFootfall('주 70만 명')).toBe(100_000);
    expect(readFootfall('연 3,000만 명')).toBe(82_192);
    expect(readFootfall('하루 12만 명')).toBe(120_000);
    expect(readFootfall('일 125,000명')).toBe(125_000);
  });

  it('만원을 생략한 "150"은 1,500,000원이다', () => {
    expect(readMoney('150', 'money:bare')).toBe(1_500_000);
    expect(readMoney('150만원', 'money:man')).toBe(1_500_000);
    expect(readMoney('1,500,000원', 'money:won')).toBe(1_500_000);
    expect(readMoney('8천원', 'money:cheon')).toBe(8_000);
    expect(readMoney('1.2만원', 'money:man_dec')).toBe(12_000);
  });

  it('1주는 7일, 2주는 14일, 1개월과 한 달은 30일이다', () => {
    expect(readDays('1주 전')).toBe(7);
    expect(readDays('게재 2주 전까지')).toBe(14);
    expect(readDays('1개월 전')).toBe(30);
    expect(readDays('한 달 전')).toBe(30);
    expect(readDays('10일 전')).toBe(10);
  });

  const hint = (field: SurfaceHint['field'], show: string, form: string): SurfaceHint => ({ field, label: '', show, tokens: [], form });

  it('크기: "8000×4500mm"와 "800×450cm"는 8m × 4.5m, "5.5×8.5cm"는 55 × 85mm 다', () => {
    expect(recalc(hint('size_m', '8000×4500mm', 'size:mm'))).toEqual({ width: 8, height: 4.5 });
    expect(recalc(hint('size_m', '800×450cm', 'size:cm'))).toEqual({ width: 8, height: 4.5 });
    expect(recalc(hint('size_m', '가로 8m × 세로 4.5m', 'size:m'))).toEqual({ width: 8, height: 4.5 });
    expect(recalc(hint('size_mm', '5.5×8.5cm', 'size:cm'))).toEqual({ width: 55, height: 85 });
  });

  it('기간 옵션: "1주 150 / 한 달 520"(만원 생략)은 (7일, 150만원), (30일, 520만원)이다', () => {
    expect(recalc(hint('period_options', '1주 150 / 한 달 520', 'money:bare'))).toEqual([
      { days: 7, price_krw: 1_500_000 },
      { days: 30, price_krw: 5_200_000 },
    ]);
  });

  it('수량 옵션과 파일 형식, 부가세', () => {
    expect(recalc(hint('quantity_options', '100잔 45만원 / 200잔 85만원', 'money:man'))).toEqual([
      { qty: 100, price_krw: 450_000 },
      { qty: 200, price_krw: 850_000 },
    ]);
    expect(recalc(hint('file_format', 'MP4, JPG', 'formats'))).toEqual(['jpg', 'mp4']);
    expect(recalc(hint('vat_included', 'VAT 별도', 'bool'))).toBe(false);
    expect(recalc(hint('vat_included', '부가세 포함', 'bool'))).toBe(true);
  });

  it('표기가 정답과 어긋나면 검산이 잡는다', () => {
    const spec = specs.find((s) => typeof s.truth.price_krw === 'number') as GoldSpec;
    const h = spec.surface_hints.find((x) => x.field === 'price_krw') as SurfaceHint;
    expect(recalc({ ...h, show: h.show.replace(/(\d)/, '$10') })).not.toBe(spec.truth.price_krw);
  });
});

describe('묶음 나누기와 안내', () => {
  const batches = splitBatches(specs, '.gold-work');

  it('넷으로 나누면 묶음마다 25건, 연습 10 + 안 여는 세트 15, 꼴마다 5건이다', () => {
    expect(batches).toHaveLength(4);
    for (const b of batches) {
      expect(b.docs).toHaveLength(25);
      expect(b.docs.filter((d) => d.split === 'dev')).toHaveLength(10);
      for (const style of GOLD_STYLES) expect(b.docs.filter((d) => d.style === style)).toHaveLength(5);
    }
    expect(new Set(batches.flatMap((b) => b.docs.map((d) => d.id))).size).toBe(100);
  });

  it('안내 글에 꼭 지킬 것이 들어 있다', () => {
    const guide = writerGuide('.gold-work');
    for (const word of ['tokens', 'absent', '100자에서 900자', '응원장터', 'output_path']) expect(guide).toContain(word);
  });
});

describe('조립', () => {
  it('원문이 다 오면 100건이 되고 고칠 것이 없다', () => {
    const { docs, problems } = assemble(specs, written(specs));
    expect(problems).toEqual([]);
    expect(docs).toHaveLength(100);
  });

  it('표기 조각이 빠진 원문, 없는 원문, 너무 짧은 원문, 모르는 번호를 잡는다', () => {
    const list = written(specs);
    const target = specs.find((s) => s.surface_hints.length > 0) as GoldSpec;
    const token = target.surface_hints[0]?.tokens[0] as string;
    const broken = list
      .filter((w) => w.id !== 'dev-002')
      .map((w) => (w.id === target.id ? { ...w, content: w.content.split(token).join('') } : w.id === 'dev-003' ? { ...w, content: '짧다' } : w));
    broken.push({ id: 'dev-999', content: '없는 번호' });
    const { problems } = assemble(specs, broken);
    expect(problems.some((p) => p.startsWith(`${target.id}:`) && p.includes('원문에 없다'))).toBe(true);
    expect(problems).toContain('dev-002: 원문이 없다');
    expect(problems.some((p) => p.startsWith('dev-003: 길이'))).toBe(true);
    expect(problems).toContain('dev-999: 설계도에 없는 번호');
  });

  it('연습 40건은 저장소 쪽 파일에, 60건은 따로 쓰고 해시를 남긴다', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gold-'));
    try {
      const files = { devFile: path.join(dir, 'repo', 'dev.jsonl'), sealedFile: path.join(dir, 'sealed', 'test.jsonl'), hashFile: path.join(dir, 'repo', 'test.sha256') };
      const result = await writeAssembled(assemble(specs, written(specs)).docs, files);
      expect(result).toMatchObject({ dev: 40, test: 60 });
      const dev = parseJsonl(await readFile(files.devFile, 'utf8'));
      const testText = await readFile(files.sealedFile, 'utf8');
      expect(dev).toHaveLength(40);
      expect(dev.every((d) => d.split === 'dev')).toBe(true);
      expect(parseJsonl(testText)).toHaveLength(60);
      expect(await readFile(files.hashFile, 'utf8')).toBe(`${sha256(testText)}  test.jsonl\n`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('파일과 내보내기', () => {
  const docs = assemble(specs, written(specs)).docs.filter((d) => d.split === 'dev');

  it('jsonl 로 쓰고 다시 읽으면 같은 글자가 나온다', () => {
    const text = docsToJsonl(docs);
    expect(docsToJsonl(parseJsonl(text))).toBe(text);
  });

  it('값 안의 열쇠 순서가 달라도 같은 정답으로 본다', () => {
    expect(canon({ open: '05:00', close: '01:00', nextDay: true })).toEqual(canon({ nextDay: true, close: '01:00', open: '05:00' }));
    expect(JSON.stringify(canon({ b: 1, a: [{ d: 1, c: 2 }] }))).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });

  it('틀린 줄이 있으면 몇 번째 줄인지 알리며 멈춘다', () => {
    expect(() => parseJsonl('{"id":"dev-001"}\n', 'dev.jsonl')).toThrow('dev.jsonl 1번째 줄');
  });

  it('DB 가 파일과 같으면 버전이 그대로다', () => {
    const plan = planExport(docs, docs);
    expect(plan.changed).toEqual([]);
    expect(plan.version).toBe(GOLD_VERSION);
  });

  it('한 건이라도 고쳤으면 그 묶음 전체의 버전이 하나 오르고 꼴은 파일의 것을 잇는다', () => {
    const first = docs[0] as GoldDoc;
    const fixed: GoldDoc = { ...first, style: undefined, truth: { ...first.truth, fields: { ...first.truth.fields, name: '고친 이름' } } };
    const fromDb = [fixed, ...docs.slice(1).map((d) => ({ ...d, style: undefined }))];
    const plan = planExport(docs, fromDb);
    expect(plan.changed).toEqual([first.id]);
    expect(plan.version).toBe(GOLD_VERSION + 1);
    expect(plan.docs.every((d) => d.goldVersion === GOLD_VERSION + 1)).toBe(true);
    expect(plan.docs[0]?.style).toBe(first.style);
    // 한 번 내보낸 뒤 다시 내보내면 더 오르지 않는다.
    expect(planExport(plan.docs, plan.docs).version).toBe(GOLD_VERSION + 1);
  });

  it('파일이 아직 없으면 DB 의 버전을 그대로 쓴다', () => {
    expect(planExport(null, docs).version).toBe(GOLD_VERSION);
  });
});

describe('그 밖', () => {
  it('확인 화면은 LABEL_ENABLED=1 일 때만 열린다', () => {
    expect(labelEnabled({ LABEL_ENABLED: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(labelEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(labelEnabled({ LABEL_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it('안 여는 세트의 자리는 환경 변수로 받는다(폴더면 그 안의 test.jsonl)', () => {
    const env = (v?: string) => ({ ...(v ? { SEALED_GOLD_PATH: v } : {}) }) as unknown as NodeJS.ProcessEnv;
    expect(sealedTestFile(env('/tmp/sealed'))).toBe(path.join('/tmp/sealed', 'test.jsonl'));
    expect(sealedTestFile(env('/tmp/x/other.jsonl'))).toBe('/tmp/x/other.jsonl');
    expect(sealedTestFile(env('~/somewhere'))).toBe(path.join(os.homedir(), 'somewhere', 'test.jsonl'));
    expect(sealedTestFile(env())).toBe(path.join(os.homedir(), 'chaeum-sealed', 'test.jsonl'));
  });

  it('저장소 밖에 둘 파일의 자리가 상대 경로이거나 저장소 안이면 거부한다(안 여는 세트, 실제 자료의 원문과 넣은 기록)', () => {
    const env = (v: string) => ({ SEALED_GOLD_PATH: v }) as unknown as NodeJS.ProcessEnv;
    const root = path.join(path.sep, 'work', 'repo');
    for (const file of [sealedTestFile, realGoldFile, realIntakeFile]) {
      for (const bad of ['sealed', './data/gold', 'data/gold/test.jsonl', '../repo/data', root, path.join(root, 'data', 'gold'), path.join(root, 'data', 'gold', 'test.jsonl'), `${root}${path.sep}x${path.sep}..${path.sep}data`]) {
        expect(() => file(env(bad), root), bad).toThrow(OutsidePathError);
      }
    }
    // 저장소 밖의 절대 경로와 홈 아래는 된다. 이름만 비슷한 옆 폴더도 저장소 밖이다.
    expect(realGoldFile(env(path.join(path.sep, 'work', 'sealed')), root)).toBe(path.join(path.sep, 'work', 'sealed', 'real.jsonl'));
    expect(realIntakeFile(env(path.join(path.sep, 'work', 'repo-sealed', 'test.jsonl')), root)).toBe(path.join(path.sep, 'work', 'repo-sealed', 'real-intake.jsonl'));
    expect(realGoldFile(env('~/somewhere'), root)).toBe(path.join(os.homedir(), 'somewhere', 'real.jsonl'));
    expect(realGoldFile({} as unknown as NodeJS.ProcessEnv, root)).toBe(path.join(os.homedir(), 'chaeum-sealed', 'real.jsonl'));
    // 홈이 저장소 안일 수는 없지만, 기본 자리도 같은 검사를 거친다.
    expect(() => realGoldFile({} as unknown as NodeJS.ProcessEnv, os.homedir())).toThrow(OutsidePathError);
  });

  it('난수는 씨앗이 같으면 같은 차례를 낸다', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    expect([a.next(), a.int(1, 9), a.shuffle([1, 2, 3, 4, 5])]).toEqual([b.next(), b.int(1, 9), b.shuffle([1, 2, 3, 4, 5])]);
  });
});

describe('조립된 문서의 검산(check.ts)', () => {
  const spec = generateSpecs(DEFAULT_SEED).find((s) => s.type === 'ad' && s.absent.some((a) => a.field === 'list_price_krw') && s.surface_hints.some((h) => h.field === 'price_krw')) as GoldSpec;
  // 조각을 한 줄에 하나씩 늘어놓은 글. 조각이 다 있고 다른 값이 없다.
  const body = [...new Set(spec.surface_hints.flatMap((h) => h.tokens))].join('\n');
  const content = `${body}\n${spec.must_include.join('\n')}\n${'문의는 응원장터로 주세요. '.repeat(8)}`;
  const doc = { id: spec.id, split: spec.split, goldVersion: 2, content, truth: { type: spec.type, subtype: spec.subtype, fields: spec.truth }, author: 'ai', traps: spec.traps, style: spec.style } as GoldDoc;
  const hardKinds = (c: string) => checkDoc(spec, { ...doc, content: c }).filter((f) => f.level === 'hard').map((f) => f.kind);

  it('조각만 늘어놓은 글에서는 정답에 없는 값을 찾지 않는다', () => {
    const kinds = hardKinds(content);
    expect(kinds).not.toContain('정답에 없는 금액');
    expect(kinds).not.toContain('표기 없음');
    expect(kinds).not.toContain('검산');
  });

  it('정답에 없는 금액과 빠진 조각을 잡는다', () => {
    expect(hardKinds(`${content}\n설치비 33,000원`)).toContain('정답에 없는 금액');
    const token = spec.surface_hints.find((h) => h.field === 'price_krw')?.tokens[0] as string;
    expect(hardKinds(content.split(token).join(''))).toContain('표기 없음');
  });

  it('없는 칸에 값이 새면 잡는다', () => {
    expect(hardKinds(`${content}\n정가는 9,990,000원`)).toContain('없는 칸에 값');
  });

  it('"7일"이 "17일" 안에 있으면 세지 않는다', () => {
    expect(cleanIndexes('게재 17일 전', '7일')).toEqual([]);
    expect(cleanIndexes('게재 7일 전', '7일')).toEqual([3]);
  });

  it('표기 뼈대는 수를 지운 글자다', () => {
    expect(shapeOf('게재 7일 전까지')).toBe('게재 N일 전까지');
    expect(shapeOf('1,500,000원')).toBe('N원');
    expect(lengthStats([3, 1, 2]).median).toBe(2);
    expect(alikePairs([{ id: 'a', content: '가나다라마바' }, { id: 'b', content: '가나다라마바' }])[0]?.rate).toBe(1);
  });
});
