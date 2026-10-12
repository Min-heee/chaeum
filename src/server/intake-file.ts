// 그림·PDF 올리기 접수.
//   검사(크기 → 형식 → 쪽수. PDF 는 눌린 묶음까지 풀어 다시 센다) → 같은 파일이 있는가(해시) → 모델이 글로 옮김 → 옮긴 글이 붙여 넣은 글과 같은 길로 접수.
// 파일 자체는 어디에도 저장하지 않는다. 그래서 글로 옮기기는 작업 줄에 넣지 않고 이 요청 안에서 끝낸다
// (줄에 넣으려면 파일을 DB 에 잠시라도 두어야 한다). 남는 것은 옮긴 글, 파일 해시, 파일 이름뿐이다.
// 모델을 부르는 동안에는 DB 트랜잭션을 열어 두지 않는다.
import { createHash } from 'node:crypto';
import { PUBLIC_WORKSPACE_ID, type SourceFileResponse } from '@/contract/api';
import type { LlmAttachment } from '@/contract/attachments';
import { checkUpload, cleanOriginName, UPLOAD_LIMITS, UPLOAD_PROBLEM_MESSAGES, type LlmRouter, type TranscribeStep, type UploadProblem } from '@/contract/pipeline-api';
import { LLM_SKIP_LABELS, type LlmSkipCause } from '@/contract/reasons';
import { getPool, withTx } from './db';
import { AppError, isAppError } from './errors';
import type { IntakeOptions } from './intake';
import { assertIntakeOpen, assertWorkspaceRoom, countIntake, prepareText } from './limits';
import { llmRouterFromEnv } from './llm-router';
import { countPdfPages } from './pdf-pages';
import { transcribe as transcribeStep } from './pipeline/transcribe';
import { findByFileHash, findByHash, receiveDoc } from './repos/source-docs';
import { sweepStaleWorkspaces, workspaceForWrite } from './workspace';

const PROBLEM_CODES: Record<UploadProblem, AppError['code']> = {
  empty: 'BAD_INPUT',
  too_large: 'FILE_TOO_LARGE',
  unsupported: 'UNSUPPORTED_FILE',
  too_many_pages: 'FILE_TOO_LARGE',
  encrypted: 'UNSUPPORTED_FILE',
  unknown_pages: 'UNSUPPORTED_FILE',
};

/** 모델을 못 불러 글로 옮기지 못했다. 그림은 규칙만 길이 없으므로 접수하지 않는다. 오늘 상한이 찬 경우만 429. */
function llmSkipped(cause: LlmSkipCause): AppError {
  const message = `파일을 글로 옮기지 못했습니다. ${LLM_SKIP_LABELS[cause]} 글자를 직접 붙여 넣으면 접수됩니다.`;
  return new AppError(cause === 'daily_cap' ? 'LIMIT_EXCEEDED' : 'LLM_UNAVAILABLE', message, undefined, cause);
}

export interface FileIntakeResult {
  /** 응답 본문(약속의 SourceFileResponse). */
  body: SourceFileResponse;
  /** 새로 접수했으면 true(201), 이미 있던 건이면 false(200). */
  created: boolean;
}

/**
 * 파일 하나를 받는다.
 * 던지는 오류: 빈 파일·옮긴 글이 너무 김 BAD_INPUT(400) · 크기·쪽수 FILE_TOO_LARGE(413) · 형식 UNSUPPORTED_FILE(415)
 *   · 글자를 못 읽음 UNREADABLE_FILE(422) · 모델을 못 부름 LLM_UNAVAILABLE(503, skipCause)
 *   · 오늘 실제 호출 상한 또는 접수·초안 상한 LIMIT_EXCEEDED(429) · 본보기 공간 READ_ONLY_WORKSPACE(403)
 */
export async function intakeFile(
  file: { bytes: Uint8Array; name?: string | null },
  options: IntakeOptions & { router?: LlmRouter; transcribe?: TranscribeStep },
): Promise<FileIntakeResult> {
  const { now } = options;
  const check = checkUpload(file.bytes);
  if (!check.ok) throw new AppError(PROBLEM_CODES[check.problem], UPLOAD_PROBLEM_MESSAGES[check.problem]);
  if (check.kind === 'pdf') {
    // 눌린 묶음까지 풀어 다시 센다. 그래도 세지 못한 PDF 는 몇 쪽인지 모른 채 모델에 넘기지 않는다(쪽마다 돈이 든다).
    const pages = countPdfPages(file.bytes);
    const problem: UploadProblem | null = pages === 0 ? 'unknown_pages' : pages > UPLOAD_LIMITS.pdfMaxPages ? 'too_many_pages' : null;
    if (problem) throw new AppError(PROBLEM_CODES[problem], UPLOAD_PROBLEM_MESSAGES[problem]);
  }
  if (options.workspaceId === PUBLIC_WORKSPACE_ID) throw new AppError('READ_ONLY_WORKSPACE', '본보기 공간은 읽기 전용입니다.');

  const originName = cleanOriginName(file.name);
  const fileHash = createHash('sha256').update(file.bytes).digest('hex');
  const source = (chars: number) => ({ kind: check.kind, originName, chars });

  // 같은 파일을 다시 올렸으면 모델을 부르지 않고 있던 건을 돌려준다. 꽉 찬 공간이면 돈을 쓰기 전에 알린다.
  if (options.workspaceId) {
    const pool = getPool();
    const existing = await findByFileHash(pool, options.workspaceId, fileHash);
    if (existing) {
      return {
        created: false,
        body: {
          workspace: options.workspaceId, sourceDocId: existing.sourceDocId, draftId: existing.draftId, status: existing.status,
          duplicate: true, source: source(existing.chars), transcribe: null,
        },
      };
    }
    await assertWorkspaceRoom(pool, options.workspaceId);
  }

  // 오늘 접수 상한이 이미 찼으면 모델을 부르기 전에 알린다(읽기만 한다. 올리기는 아래 트랜잭션에서).
  await assertIntakeOpen(getPool(), now);

  // 글로 옮기기. 트랜잭션 밖이다.
  const attachment: LlmAttachment = { kind: check.kind, mediaType: check.mediaType, dataBase64: Buffer.from(file.bytes).toString('base64') };
  const outcome = await (options.transcribe ?? transcribeStep)({ attachment, now }, options.router ?? llmRouterFromEnv());
  if (!outcome.ok) {
    if (outcome.problem === 'llm_skipped') throw llmSkipped(outcome.cause);
    throw new AppError('UNREADABLE_FILE', '파일에서 글자를 읽지 못했습니다. 글자가 또렷한 파일로 다시 올려 주세요.');
  }

  // 옮긴 글도 붙여 넣은 글과 똑같이 정리하고 길이를 본다.
  let prepared: { clean: string; hash: string };
  try {
    prepared = prepareText(outcome.text);
  } catch (err) {
    if (isAppError(err)) throw new AppError('BAD_INPUT', `파일에서 옮긴 글을 받을 수 없습니다. ${err.message}`);
    throw err;
  }
  const chars = [...prepared.clean].length;

  const received = await withTx(async (client) => {
    const workspace = await workspaceForWrite(client, options.workspaceId, now, options.kindForNew);
    // 모델을 부르는 사이 같은 파일이나 같은 글이 먼저 들어왔을 수 있다.
    const existing = (await findByFileHash(client, workspace.id, fileHash)) ?? (await findByHash(client, workspace.id, prepared.hash));
    if (existing) return { workspace: workspace.id, doc: existing };
    await assertWorkspaceRoom(client, workspace.id);
    await countIntake(client, now);
    const doc = await receiveDoc(client, {
      workspaceId: workspace.id, clean: prepared.clean, hash: prepared.hash, file: { kind: check.kind, originName, fileHash }, now,
    });
    return { workspace: workspace.id, doc };
  });

  try {
    await sweepStaleWorkspaces(getPool(), now);
  } catch (err) {
    console.error('[workspace] 낡은 공간 지우기 실패:', err instanceof Error ? err.message : err);
  }

  const { llm } = outcome;
  return {
    created: !received.doc.duplicate,
    body: {
      workspace: received.workspace,
      sourceDocId: received.doc.sourceDocId,
      draftId: received.doc.draftId,
      status: received.doc.status,
      duplicate: received.doc.duplicate,
      source: source(chars),
      transcribe: { recorded: llm.recorded, live: llm.live, originalLatencyMs: llm.latencyMs, originalCostUsd: llm.costUsd },
    },
  };
}
