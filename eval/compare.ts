// 두 실행을 같은 문서끼리 견준다(EVAL-SPEC 8절). 합계의 차이가 아니라 건별 나아짐·나빠짐을 낸다.
// 실행: npx tsx --env-file-if-exists=.env.local eval/compare.ts <앞 실행 번호> <뒤 실행 번호>
//       npx tsx eval/compare.ts --files <앞 기록.json> <뒤 기록.json> [--method llm_code]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  ERROR_VERDICTS,
  EVAL_METHODS,
  isDocAllCorrect,
  type CellChange,
  type EvalCell,
  type EvalMethod,
  type GoldSplit,
  type RunComparison,
  type Verdict,
} from '@/contract/eval-types';
import { groupByDoc } from './metrics';

/** 견줄 실행 하나. 판정만 있으면 된다. */
export interface RunCells {
  runId: number;
  split: GoldSplit;
  method: EvalMethod;
  goldVersion: number;
  cells: readonly Pick<EvalCell, 'goldDocId' | 'field' | 'verdict'>[];
}

const isError = (v: Verdict) => ERROR_VERDICTS.includes(v);

/**
 * 두 실행을 견준다. 묶음·정답 버전·방식이 다르면 견주지 않고 오류를 낸다.
 * 양쪽에 다 있는 문서만 센다. 한쪽에만 있는 문서는 따로 적는다.
 */
export function compareRuns(base: RunCells, other: RunCells): RunComparison {
  if (base.split !== other.split) throw new Error(`묶음이 다른 실행은 견주지 않는다: ${base.split} / ${other.split}`);
  if (base.goldVersion !== other.goldVersion) {
    throw new Error(`정답 버전이 다른 실행은 견주지 않는다: v${base.goldVersion} / v${other.goldVersion}`);
  }
  if (base.method !== other.method) throw new Error(`방식이 다른 실행은 견주지 않는다: ${base.method} / ${other.method}`);

  const a = groupByDoc(base.cells);
  const b = groupByDoc(other.cells);
  const improved: string[] = [];
  const regressed: string[] = [];
  const cellChanges: CellChange[] = [];
  let unchanged = 0;

  for (const id of [...a.keys()].sort()) {
    const before = a.get(id)!;
    const after = b.get(id);
    if (!after) continue;
    const was = isDocAllCorrect(before);
    const now = isDocAllCorrect(after);
    if (!was && now) improved.push(id);
    else if (was && !now) regressed.push(id);
    else unchanged += 1;

    const afterByField = new Map(after.map((c) => [c.field, c.verdict]));
    for (const cell of before) {
      const next = afterByField.get(cell.field);
      if (next !== undefined && next !== cell.verdict) {
        cellChanges.push({ goldDocId: id, field: cell.field, base: cell.verdict, other: next });
      }
    }
  }

  return {
    baseRunId: base.runId,
    otherRunId: other.runId,
    improved,
    regressed,
    unchanged,
    onlyInBase: [...a.keys()].filter((id) => !b.has(id)).sort(),
    onlyInOther: [...b.keys()].filter((id) => !a.has(id)).sort(),
    cellChanges,
  };
}

/**
 * 칸 단위의 나아짐·나빠짐.
 * 나아짐: 틀린 칸(wrong/missed/fabricated)이 틀리지 않은 칸이 됨. 나빠짐: 그 반대.
 * 틀린 채로 판정만 바뀐 칸(예: missed → wrong)은 stillWrong 에 따로 센다.
 */
export function summarizeCellChanges(changes: readonly CellChange[]): { improved: number; regressed: number; stillWrong: number } {
  let improved = 0;
  let regressed = 0;
  let stillWrong = 0;
  for (const c of changes) {
    const was = isError(c.base);
    const now = isError(c.other);
    if (was && !now) improved += 1;
    else if (!was && now) regressed += 1;
    else if (was && now) stillWrong += 1;
  }
  return { improved, regressed, stillWrong };
}

/** 사람이 읽는 글. 퍼센트의 차이를 적지 않는다. */
export function formatComparison(cmp: RunComparison, label = ''): string {
  const lines: string[] = [];
  lines.push(`견주기${label ? ` (${label})` : ''}: 실행 ${cmp.baseRunId} → 실행 ${cmp.otherRunId}`);
  lines.push(`  문서: 나아짐 ${cmp.improved.length}건 / 나빠짐 ${cmp.regressed.length}건 / 그대로 ${cmp.unchanged}건`);
  if (cmp.improved.length > 0) lines.push(`    나아짐: ${cmp.improved.join(', ')}`);
  if (cmp.regressed.length > 0) lines.push(`    나빠짐: ${cmp.regressed.join(', ')}`);
  if (cmp.onlyInBase.length > 0) lines.push(`    앞 실행에만 있는 문서 ${cmp.onlyInBase.length}건: ${cmp.onlyInBase.join(', ')}`);
  if (cmp.onlyInOther.length > 0) lines.push(`    뒤 실행에만 있는 문서 ${cmp.onlyInOther.length}건: ${cmp.onlyInOther.join(', ')}`);
  const changes = cmp.cellChanges ?? [];
  const cells = summarizeCellChanges(changes);
  lines.push(`  칸: 나아짐 ${cells.improved}칸 / 나빠짐 ${cells.regressed}칸 / 틀린 채 판정만 바뀜 ${cells.stillWrong}칸`);
  for (const c of changes) lines.push(`    ${c.goldDocId} ${c.field}: ${c.base} → ${c.other}`);
  return lines.join('\n');
}

// ── 명령줄 ─────────────────────────────────────────────────

interface RecordFile {
  split: GoldSplit;
  goldVersion: number;
  runs: Record<EvalMethod, { runId: number }>;
  cells: Record<EvalMethod, RunCells['cells']>;
}

function fromFile(file: string, method: EvalMethod): RunCells {
  const record = JSON.parse(readFileSync(file, 'utf8')) as RecordFile;
  if (!record.cells?.[method]) throw new Error(`${file}: ${method} 방식의 결과 줄이 없다`);
  return { runId: record.runs[method].runId, split: record.split, method, goldVersion: record.goldVersion, cells: record.cells[method] };
}

async function main(argv: string[]): Promise<number> {
  const methodAt = argv.indexOf('--method');
  const method = (methodAt >= 0 ? argv[methodAt + 1] : 'llm_code') as EvalMethod;
  if (!EVAL_METHODS.includes(method)) {
    console.error(`--method 는 ${EVAL_METHODS.join(' | ')} 가운데 하나다`);
    return 1;
  }
  const rest = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--method');

  if (argv.includes('--files')) {
    if (rest.length !== 2) {
      console.error('쓰는 법: eval/compare.ts --files <앞 기록.json> <뒤 기록.json> [--method llm_code]');
      return 1;
    }
    console.log(formatComparison(compareRuns(fromFile(rest[0]!, method), fromFile(rest[1]!, method)), method));
    return 0;
  }

  const ids = rest.map(Number);
  if (ids.length !== 2 || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    console.error('쓰는 법: eval/compare.ts <앞 실행 번호> <뒤 실행 번호>   (또는 --files 로 기록 파일 둘)');
    return 1;
  }
  const { closePool, getPool } = await import('@/server/db');
  const { loadRunCells } = await import('./store');
  try {
    const [base, other] = await Promise.all(ids.map((id) => loadRunCells(getPool(), id)));
    if (!base || !other) {
      console.error('그 번호의 실행이 없다');
      return 1;
    }
    console.log(formatComparison(compareRuns(base, other), base.method));
    return 0;
  } finally {
    await closePool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
