// 결과 내보내기: 실행 기록(JSON)과 사람이 읽는 요약(글). 틀린 건 목록을 함께 싣는다.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  EVAL_METHODS,
  METHOD_LABELS,
  SPLIT_LABELS,
  type EvalCell,
  type EvalMethod,
  type EvalMetrics,
  type EvalRunRecord,
  type Ratio,
} from '@/contract/eval-types';
import { FIELD_KEYS, fieldDef } from '@/contract/fields';
import { RESULTS_DIR, stampOf, usd } from './io';
import { formatRatio, wrongDocs } from './metrics';
import type { CallDetail, CallFailure } from './runner';
import type { RunInfo } from './store';

/** 기록 파일의 꼴. 약속(EvalRunRecord)에 건별 결과와 실행 메모를 더했다. */
export interface EvalRunFile extends EvalRunRecord {
  info: RunInfo;
  docIds: string[];
  /** 상한에 걸려 돌리지 못한 문서 */
  notRun: string[];
  failures: CallFailure[];
  calls: CallDetail[];
  /** 방식별 결과 줄. 실제 자료 묶음은 값(expected·actual)을 비운다. */
  cells: Record<EvalMethod, EvalCell[]>;
}

/** 실제 자료 묶음의 기록에는 원문에서 온 값을 싣지 않는다. */
export function stripValues(cells: readonly EvalCell[]): EvalCell[] {
  return cells.map((c) => ({ ...c, expected: null, actual: null }));
}

const short = (value: unknown): string => {
  const text = JSON.stringify(value ?? null);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

function ratioRow(label: string, r: Ratio | undefined): string {
  return `| ${label} | ${r ? formatRatio(r) : '내지 않음'} |`;
}

function metricsBlock(method: EvalMethod, m: EvalMetrics): string[] {
  const lines: string[] = [];
  lines.push(`### ${METHOD_LABELS[method]} (\`${method}\`)`, '');
  lines.push('| 지표 | 값 (분자/분모) |', '|---|---|');
  lines.push(ratioRow('1. 칸 정확도(전체)', m.fieldAccuracy.overall));
  lines.push(ratioRow('2. 지어낸 값', m.fabricated.overall));
  lines.push(ratioRow('3. 전부 맞은 문서', m.docsAllCorrect));
  lines.push(ratioRow('4. 바로 승인 줄', m.autoApprove?.ready));
  lines.push(ratioRow('4. 그 안의 틀린 것', m.autoApprove?.readyWithError));
  lines.push(ratioRow('5. 검사기 포착', m.checker?.caught));
  lines.push(ratioRow('5. 검사기 헛경보', m.checker?.falseAlarm));
  lines.push(ratioRow('(참고) 표시가 붙은 "없음" 칸', m.checker?.flaggedTrueNone));
  if (m.costTime) {
    const from = m.costTime.fromRecording ? ' — 녹화 때 잰 값이 섞여 있다' : '';
    lines.push(`| 6. 건당 비용 | ${usd(m.costTime.costUsdPerDoc)} (합 ${usd(m.costTime.costUsdTotal)} / ${m.docs}건)${from} |`);
    lines.push(`| 6. 시간 | 가운데값 ${m.costTime.latencyMsP50}ms, 95번째 ${m.costTime.latencyMsP95}ms${from} |`);
  } else {
    lines.push('| 6. 건당 비용과 시간 | 내지 않음(호출 없음) |');
  }
  lines.push(ratioRow('종류 정확도', m.typeAccuracy));
  lines.push(ratioRow('갈래 정확도', m.subtypeAccuracy));
  lines.push(ratioRow('놓친 값', m.missed));
  lines.push('');
  return lines;
}

function byFieldTable(metrics: Record<EvalMethod, EvalMetrics>): string[] {
  const lines = ['### 칸별 정확도 (맞은 칸 / 정답에 값이 있는 칸)', '', `| 칸 | ${EVAL_METHODS.join(' | ')} |`, `|---|${EVAL_METHODS.map(() => '---').join('|')}|`];
  for (const key of FIELD_KEYS) {
    const row = EVAL_METHODS.map((m) => metrics[m].fieldAccuracy.byField[key]);
    if (row.every((r) => r === undefined)) continue;
    lines.push(`| ${fieldDef(key).label} \`${key}\` | ${row.map((r) => (r ? formatRatio(r) : '-')).join(' | ')} |`);
  }
  lines.push('', '### 칸별 지어낸 값 (지어낸 칸 / 정답이 "없음"인 칸)', '', `| 칸 | ${EVAL_METHODS.join(' | ')} |`, `|---|${EVAL_METHODS.map(() => '---').join('|')}|`);
  for (const key of FIELD_KEYS) {
    const row = EVAL_METHODS.map((m) => metrics[m].fabricated.byField[key]);
    if (row.every((r) => r === undefined || r.den === 0)) continue;
    lines.push(`| ${fieldDef(key).label} \`${key}\` | ${row.map((r) => (r ? formatRatio(r) : '-')).join(' | ')} |`);
  }
  lines.push('');
  return lines;
}

/** 사람이 읽는 요약. 묶음 하나, 실행 한 번의 것이다(묶음끼리 합치지 않는다). */
export function summaryText(file: EvalRunFile): string {
  const lines: string[] = [];
  const { info } = file;
  lines.push(`# 평가 실행 — ${SPLIT_LABELS[file.split]}(\`${file.split}\`) ${file.startedAt}`, '');
  if (file.split === 'dev') lines.push('> 연습 세트의 점수다. 고칠 때 보는 숫자이고 바깥에 내세우지 않는다.', '');
  if (info.includeUnreviewed) lines.push('> **확인 전 포함**: 사람이 확인하지 않은 문서가 채점에 들어 있다. 정답이 틀렸을 수 있다.', '');
  if (file.stoppedByBudget) lines.push(`> **상한에 걸려 멈춤**: ${file.notRun.length}건을 돌리지 못했다. 아래 숫자는 끝난 데까지의 것이다.`, '');

  lines.push('| 항목 | 값 |', '|---|---|');
  lines.push(`| 모델 | ${file.model ?? '-'} |`);
  lines.push(`| 프롬프트 버전 | ${file.promptVersion ?? '-'} |`);
  lines.push(`| 정답 버전 | v${file.goldVersion} |`);
  lines.push(`| 코드 커밋 | ${file.gitCommit} |`);
  lines.push(`| 실행 번호 | ${EVAL_METHODS.map((m) => `${m} ${file.runs[m].runId}`).join(', ')} |`);
  lines.push(`| 채점한 문서 | ${file.docIds.length}건${info.limit !== null ? ` (--limit ${info.limit})` : ''} |`);
  lines.push(`| 뺀 문서 | 확인 기록 없음 ${info.excludedUnreviewed}건, 버림 ${info.excludedDropped}건 |`);
  lines.push(`| 녹화본만으로 돌림 | ${file.replayOnly ? '예' : '아니오'} |`);
  lines.push(`| 실제로 쓴 돈 | ${usd(file.costUsd)} (실제 호출 ${file.calls.filter((c) => !c.recorded).length}건, 장부에서 읽음 ${file.calls.filter((c) => c.recorded).length}건) |`);
  lines.push(`| 답을 못 받은 문서 | ${file.failures.length}건${file.failures.length > 0 ? `: ${file.failures.map((f) => `${f.goldDocId}(${f.code})`).join(', ')}` : ''} |`);
  lines.push('');
  if (file.failures.length > 0) {
    lines.push('답을 못 받은 문서는 LLM 두 방식에서 빈 답으로 채점했다(종류 틀림, 칸은 모두 "없음"). 빼지 않았다.', '');
  }

  const metrics = Object.fromEntries(EVAL_METHODS.map((m) => [m, file.runs[m].metrics])) as Record<EvalMethod, EvalMetrics>;
  lines.push('## 지표', '');
  lines.push(...byFieldTable(metrics));
  for (const method of EVAL_METHODS) lines.push(...metricsBlock(method, metrics[method]));

  lines.push('## 틀린 건', '');
  for (const method of EVAL_METHODS) {
    const wrong = wrongDocs(file.cells[method]);
    lines.push(`### ${METHOD_LABELS[method]} — 전부 맞지 않은 문서 ${wrong.length}건`, '');
    for (const doc of wrong) {
      lines.push(`- ${doc.goldDocId}`);
      for (const c of doc.errors) {
        const values = file.split === 'real' ? '' : ` — 정답 ${short(c.expected)} / 낸 값 ${short(c.actual)}`;
        lines.push(`  - \`${c.field}\` ${c.verdict}${c.flagged ? ' (표시 붙음)' : ''}${values}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** 기록 파일과 요약을 쓴다. 쓴 자리를 돌려준다. */
export function writeRunFiles(file: EvalRunFile, dir: string = RESULTS_DIR): { json: string; summary: string } {
  mkdirSync(dir, { recursive: true });
  const name = `${stampOf(new Date(file.startedAt))}-${file.split}-${file.promptVersion ?? 'no-prompt'}`;
  const json = path.join(dir, `${name}.json`);
  const summary = path.join(dir, `${name}.md`);
  writeFileSync(json, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  writeFileSync(summary, `${summaryText(file)}\n`, 'utf8');
  return { json, summary };
}
