import { describe, expect, it } from 'vitest';
import type { Verdict } from '@/contract/eval-types';
import { compareRuns, formatComparison, summarizeCellChanges, type RunCells } from './compare';

const run = (runId: number, rows: [string, string, Verdict][], over: Partial<RunCells> = {}): RunCells => ({
  runId,
  split: 'dev',
  method: 'llm_code',
  goldVersion: 1,
  cells: rows.map(([goldDocId, field, verdict]) => ({ goldDocId, field: field as RunCells['cells'][number]['field'], verdict })),
  ...over,
});

describe('두 실행 견주기', () => {
  const base = run(1, [
    ['d1', 'type', 'correct'], ['d1', 'price_krw', 'wrong'],
    ['d2', 'type', 'correct'], ['d2', 'price_krw', 'correct'],
    ['d3', 'type', 'correct'], ['d3', 'name', 'missed'], ['d3', 'price_krw', 'correct'],
    ['d4', 'type', 'correct'], ['d4', 'name', 'true_none'],
    ['d5', 'type', 'correct'],
  ]);
  const other = run(2, [
    ['d1', 'type', 'correct'], ['d1', 'price_krw', 'correct'],
    ['d2', 'type', 'correct'], ['d2', 'price_krw', 'missed'],
    ['d3', 'type', 'correct'], ['d3', 'name', 'wrong'], ['d3', 'price_krw', 'correct'],
    ['d4', 'type', 'correct'], ['d4', 'name', 'true_none'],
    ['d6', 'type', 'correct'],
  ]);
  const cmp = compareRuns(base, other);

  it('문서 단위: 나아짐·나빠짐·그대로를 건별로 낸다', () => {
    expect(cmp.improved).toEqual(['d1']);
    expect(cmp.regressed).toEqual(['d2']);
    expect(cmp.unchanged).toBe(2);
  });

  it('한쪽에만 있는 문서는 세지 않고 따로 적는다', () => {
    expect(cmp.onlyInBase).toEqual(['d5']);
    expect(cmp.onlyInOther).toEqual(['d6']);
  });

  it('칸 단위: 판정이 달라진 칸을 모두 적는다', () => {
    expect(cmp.cellChanges).toEqual([
      { goldDocId: 'd1', field: 'price_krw', base: 'wrong', other: 'correct' },
      { goldDocId: 'd2', field: 'price_krw', base: 'correct', other: 'missed' },
      { goldDocId: 'd3', field: 'name', base: 'missed', other: 'wrong' },
    ]);
    expect(summarizeCellChanges(cmp.cellChanges ?? [])).toEqual({ improved: 1, regressed: 1, stillWrong: 1 });
  });

  it('합계가 같아도 나아짐과 나빠짐이 따로 보인다', () => {
    const text = formatComparison(cmp);
    expect(text).toContain('나아짐 1건 / 나빠짐 1건 / 그대로 2건');
    expect(text).toContain('d2 price_krw: correct → missed');
    expect(text).not.toContain('%');
  });

  it('묶음·정답 버전·방식이 다르면 견주지 않는다', () => {
    expect(() => compareRuns(base, run(3, [], { split: 'hand' }))).toThrow(/묶음/);
    expect(() => compareRuns(base, run(3, [], { goldVersion: 2 }))).toThrow(/정답 버전/);
    expect(() => compareRuns(base, run(3, [], { method: 'rules' }))).toThrow(/방식/);
  });
});
