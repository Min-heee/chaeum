// 상한과 글 정리. 글 길이와 한 번에 넣는 건수는 입력의 꼴이라 400, 하루·공간 상한은 429다.
import { createHash } from 'node:crypto';
import { LIMITS } from '@/contract/api';
import { AppError } from './errors';
import { bumpCounter, readCounter } from './repos/daily-counters';
import { countEvents } from './repos/draft-events';
import type { Db } from './types';

/**
 * 원문을 정리한다. 같은 글이 공백 차이로 다른 글이 되지 않게 한다.
 * 전각 글자를 반각으로(NFKC), 줄 끝 공백 떼기, 이어진 공백은 하나로, 빈 줄은 하나까지.
 */
export function cleanText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    // DB 가 받지 못하는 글자(NUL)와 그 밖의 제어 글자는 뺀다. 탭과 줄바꿈은 아래에서 따로 다룬다.
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd')
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
  if (count > LIMITS.bulkMaxDocs) throw new AppError('BAD_INPUT', `한 번에 ${LIMITS.bulkMaxDocs}건까지 넣을 수 있습니다.`);
}

/** 공간에 초안을 하나 더 만들어도 되는가. 공간 줄을 잠근 트랜잭션 안에서 부른다. */
export async function assertWorkspaceRoom(db: Db, workspaceId: string): Promise<void> {
  const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM drafts WHERE workspace_id = $1', [workspaceId]);
  if (Number(rows[0]?.n ?? 0) >= LIMITS.draftsPerWorkspace) {
    throw new AppError('LIMIT_EXCEEDED', `한 공간에는 초안을 ${LIMITS.draftsPerWorkspace}건까지 둘 수 있습니다.`);
  }
}

/**
 * 이 초안의 변경 기록을 더 쌓아도 되는가. 칸 고치기와 다시 돌리기가 쓰기 전에 부른다.
 * 공간을 보지 않는다. 공간을 확인한 초안의 번호로만 부른다.
 */
export async function assertEventRoom(db: Db, draftId: number): Promise<void> {
  if ((await countEvents(db, draftId)) >= LIMITS.eventsPerDraft) {
    throw new AppError('LIMIT_EXCEEDED', `이 초안은 변경 기록이 ${LIMITS.eventsPerDraft}줄에 닿아 더 고치거나 다시 돌릴 수 없습니다. 글을 새로 접수해 주세요.`);
  }
}

/** 오늘 접수 상한이 이미 찼으면 429. 읽기만 한다(올리지 않는다). 돈이 드는 일을 하기 전에 미리 본다. */
export async function assertIntakeOpen(db: Db, now: Date): Promise<void> {
  if ((await readCounter(db, 'intake', now)) >= LIMITS.intakePerDay) throw intakeFull();
}

const intakeFull = () => new AppError('LIMIT_EXCEEDED', '오늘 받을 수 있는 글이 다 찼습니다. 내일 다시 해 주세요.');

/** 오늘(한국 날짜) 전체 접수 수를 하나 올린다. 상한을 넘으면 올리지 않고 429. */
export async function countIntake(db: Db, now: Date): Promise<void> {
  const bumped = await bumpCounter(db, 'intake', now, 1, LIMITS.intakePerDay);
  if (!bumped.ok) throw intakeFull();
}

/**
 * 오늘의 실제 호출 자리를 하나 잡는다. 잡았으면 true. 호출하기 전에 부른다(실패해도 돌려놓지 않는다).
 * 한 문장으로 올리므로 여럿이 동시에 잡아도 상한을 넘지 않는다. cap 이 0 이하면 꺼진 것이다.
 * 글 길이는 여기서 보지 않는다. 길을 고르는 쪽(planLlmRoute)이 먼저 가른다.
 */
export async function takeLiveLlmSlot(db: Db, now: Date, cap: number): Promise<boolean> {
  if (!(cap > 0)) return false;
  return (await bumpCounter(db, 'live_llm', now, 1, cap)).ok;
}
