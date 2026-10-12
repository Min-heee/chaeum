// 여러 건 넣기의 CSV 글을 글 목록으로 바꾼다. 첫 열이 글이다.
// 첫 줄의 첫 칸이 "text" 면 머리줄로 보고 건너뛴다. 큰따옴표 안의 줄바꿈과 쉼표는 글의 일부다.
import { LIMITS } from '@/contract/api';
import { AppError } from './errors';

/** CSV 글을 줄(칸 목록)로 나눈다. 따옴표 안의 "" 는 따옴표 하나다. */
export function parseCsvRows(csv: string): string[][] {
  const text = csv.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** 첫 열의 글들. 빈 줄은 뺀다. 한 건도 없거나 상한을 넘으면 오류. */
export function textsFromCsv(csv: string): string[] {
  const rows = parseCsvRows(csv);
  if ((rows[0]?.[0] ?? '').trim().toLowerCase() === 'text') rows.shift();
  const texts = rows.map((r) => r[0] ?? '').filter((t) => t.trim() !== '');
  if (texts.length === 0) throw new AppError('BAD_INPUT', 'CSV 에 넣을 글이 없습니다.');
  if (texts.length > LIMITS.bulkMaxDocs) throw new AppError('BAD_INPUT', `한 번에 ${LIMITS.bulkMaxDocs}건까지 넣을 수 있습니다.`);
  return texts;
}
