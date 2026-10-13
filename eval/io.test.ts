// 실행별 답 파일을 두는 자리가 장부에 섞이지 않는지 본다.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { LlmCallRecord } from '@/contract/llm-types';
import { JsonlCallStore } from '@/llm';
import { RECORDINGS_DIR, RUN_ANSWERS_DIR } from './io';

const dir = mkdtempSync(path.join(os.tmpdir(), 'chaeum-io-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const record = (key: string, response: unknown): LlmCallRecord => ({
  task: 'extract', provider: 'anthropic', model: 'm', promptVersion: 'p', cacheKey: key.repeat(64), response,
  stopReason: 'end_turn', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, isRecorded: false,
});

describe('실행별 답 파일의 자리', () => {
  it('녹화 폴더의 아래 폴더다', () => {
    expect(path.dirname(RUN_ANSWERS_DIR)).toBe(RECORDINGS_DIR);
  });

  it('아래 폴더에 남긴 답은 녹화 폴더를 읽는 장부에 보이지 않는다(같은 키여도 장부의 답이 그대로다)', async () => {
    await new JsonlCallStore(dir, 'ledger.jsonl').save(record('a', '장부의 답'));
    await new JsonlCallStore(path.join(dir, 'runs'), 'one-run.jsonl').save(record('a', '따로 남긴 답'));
    await new JsonlCallStore(path.join(dir, 'runs'), 'one-run.jsonl').save(record('b', '따로 남긴 답'));
    const ledger = new JsonlCallStore(dir);
    expect((await ledger.find('a'.repeat(64)))?.response).toBe('장부의 답');
    expect(await ledger.find('b'.repeat(64))).toBeNull();
  });
});
