import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INJECTION_KINDS, type GoldDoc } from '@/contract/eval-types';
import { cleanDocOf, formatInjection, runInjection, seededRandom } from './inject';
import { TEXT_CASES } from './inject-material';

const docs = readFileSync('data/gold/dev.jsonl', 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as GoldDoc);

describe('주입 시험', () => {
  it('같은 씨앗이면 같은 결과가 나온다', () => {
    const a = runInjection(docs, { seed: 7, perKind: 10 });
    const b = runInjection(docs, { seed: 7, perKind: 10 });
    expect(b).toEqual(a);
    expect(seededRandom(1)()).toBe(seededRandom(1)());
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
  });

  it('종류 여덟 모두에 넣은 곳이 있고, 잡은 수는 넣은 수를 넘지 않는다', () => {
    const run = runInjection(docs, { seed: 20261012, perKind: 10 });
    for (const kind of INJECTION_KINDS) {
      expect(run.report[kind].den, kind).toBeGreaterThan(0);
      expect(run.report[kind].num, kind).toBeLessThanOrEqual(run.report[kind].den);
      expect(run.details.filter((d) => d.kind === kind)).toHaveLength(run.report[kind].den);
    }
  });

  it('값 종류는 종류마다 --per-kind 를 넘겨 넣지 않는다', () => {
    const run = runInjection(docs, { seed: 3, perKind: 5 });
    for (const kind of ['zero_added', 'unit_swap', 'fake_evidence', 'cheaper_longer'] as const) expect(run.report[kind].den).toBeLessThanOrEqual(5);
  });

  it('망가뜨리기 전부터 표시가 붙은 칸에는 넣지 않는다', () => {
    const run = runInjection(docs, { seed: 20261012, perKind: 1000 });
    const noisy = new Set(docs.map(cleanDocOf).flatMap((d) => (d ? d.noisy.map((f) => `${d.id}/${f}`) : [])));
    const valueTargets = run.details.filter((d) => d.target.startsWith('dev-')).map((d) => d.target);
    expect(valueTargets.filter((t) => noisy.has(t))).toEqual([]);
    expect(run.untouched.flaggedCells).toBe(noisy.size);
  });

  it('글 재료는 망가뜨리기 전에는 글 검사를 통과한다', () => {
    const run = runInjection(docs, { seed: 1, perKind: 1 });
    expect(run.untouched.texts).toBe(TEXT_CASES.length);
    expect(run.untouched.failingTexts).toEqual([]);
  });

  it('못 잡은 것은 요약에 그대로 나온다', () => {
    const run = runInjection(docs, { seed: 20261012, perKind: 10 });
    const missed = run.details.filter((d) => !d.caught);
    const text = formatInjection(run);
    expect(text).toContain(`못 잡은 것 ${missed.length}곳`);
    for (const d of missed) expect(text).toContain(d.target);
  });

  it('글에 금액 단위가 선언돼 있으면 "틀린 데 없는 답"도 그 단위로 맞춘다', () => {
    const doc = (header: string): GoldDoc => ({
      id: 'dev-999',
      split: 'dev',
      goldVersion: 1,
      content: `[별하늘 커피차 응원 세트]\n${header}\n100잔 550\n200잔 990\n출장 지역: 전국`,
      truth: {
        type: 'catering',
        subtype: '커피차',
        fields: { quantity_options: [{ qty: 100, price_krw: 550_000 }, { qty: 200, price_krw: 990_000 }] },
      },
      author: 'synthetic',
      traps: [],
    } as unknown as GoldDoc);
    const options = (header: string) => cleanDocOf(doc(header))?.extraction.fields.find((f) => f.field === 'quantity_options')?.value;
    expect(options('가격표 (단위: 천원)')).toEqual([{ qty: 100, price_krw: 550_000 }, { qty: 200, price_krw: 990_000 }]);
    // 선언이 없으면 만원으로 짐작한 값이 정답과 달라 재료에서 빠진다.
    expect(options('가격표')).toBeUndefined();
  });

  it('정답이 "등록 대상 아님"인 문서는 값 재료가 되지 않는다', () => {
    const notProduct = docs.find((d) => d.truth.type === 'not_product');
    expect(notProduct && cleanDocOf(notProduct)).toBeNull();
  });
});
