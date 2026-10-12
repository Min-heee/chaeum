// 상한과 글 정리. 넘으면 400(글) 또는 429(건수)다.
import { createHash } from 'node:crypto';
import { LIMITS } from '@/contract/api';
import { AppError } from './errors';
import { bumpCounter } from './repos/daily-counters';
import type { Db } from './types';

/**
 * 원문을 정리한다. 같은 글이 공백 차이로 다른 글이 되지 않게 한다.
 * 전각 글자를 반각으로(NFKC), 줄 끝 공백 떼기, 이어진 공백은 하나로, 빈 줄은 하나까지.
 */
export function cleanText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 글자 수. 이모지 같은 글자도 하나로 센다(PostgreSQL 의 length 와 같다). */
export function charCount(text: string): number {
  return [...text].length;
}

export function hashText(clean: string): string {
  return createHash('sha256').update(clean, 'utf8').digest('hex');
}

/** 접수할 글 한 건을 정리하고 길이를 본다. 비었거나 길면 BAD_INPUT. */
export function prepareText(input: unknown): { clean: string; hash: string } {
  if (typeof input !== 'string') throw new AppError('BAD_INPUT', '글은 글자여야 합니다.');
  const clean = cleanText(input);
  if (clean.length === 0) throw new AppError('BAD_INPUT', '글이 비었습니다.');
  if (charCount(clean) > LIMITS.textMaxChars) {
    throw new AppError('BAD_INPUT', `글은 ${LIMITS.textMaxChars.toLocaleString('ko-KR')}자까지 넣을 수 있습니다.`);
  }
  return { clean, hash: hashText(clean) };
}

/** 한 번에 넣는 건수를 본다. */
export function assertBulkSize(count: number): void {
  if (count < 1) throw new AppError('BAD_INPUT', '넣을 글이 없습니다.');
  if (count > LIMITS.bulkMaxDocs) throw new AppError('LIMIT_EXCEEDED', `한 번에 ${LIMITS.bulkMaxDocs}건까지 넣을 수 있습니다.`);
}

/** 공간에 초안을 하나 더 만들어도 되는가. 공간 줄을 잠근 트랜잭션 안에서 부른다. */
export async function assertWorkspaceRoom(db: Db, workspaceId: string): Promise<void> {
  const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM drafts WHERE workspace_id = $1', [workspaceId]);
  if (Number(rows[0]?.n ?? 0) >= LIMITS.draftsPerWorkspace) {
    throw new AppError('LIMIT_EXCEEDED', `한 공간에는 초안을 ${LIMITS.draftsPerWorkspace}건까지 둘 수 있습니다.`);
  }
}

/** 오늘(한국 날짜) 전체 접수 수를 하나 올린다. 상한을 넘으면 올리지 않고 429. */
export async function countIntake(db: Db, now: Date): Promise<void> {
  const bumped = await bumpCounter(db, 'intake', now, 1, LIMITS.intakePerDay);
  if (!bumped.ok) throw new AppError('LIMIT_EXCEEDED', '오늘 받을 수 있는 글이 다 찼습니다. 내일 다시 해 주세요.');
}

/**
 * 방문자 글에 진짜 LLM 을 돌려도 되는가. 되면 오늘 수를 하나 올리고 true.
 * cap 이 0 이하면 꺼진 것이다. 글이 길어도 false(규칙만 길로 간다).
 */
export async function takeLiveLlmSlot(db: Db, now: Date, cap: number, textChars: number): Promise<boolean> {
  if (!(cap > 0) || textChars > LIMITS.liveLlmTextMaxChars) return false;
  return (await bumpCounter(db, 'live_llm', now, 1, cap)).ok;
}
