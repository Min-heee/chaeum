// 키가 없는 서버: 글은 "규칙만" 길로 가고(까닭 no_key), 그림은 접수하지 않는다. 모델은 한 번도 부르지 않는다.
// 내 컴퓨터의 .env.local 에 키가 있어도 이 파일에서는 지우고 돈다.
process.env.LLM_PROVIDER = 'replay';
delete process.env.ANTHROPIC_API_KEY;
process.env.LIVE_LLM_DAILY_CAP = '0';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiErrorBodySchema, DraftDetailResponseSchema, HealthResponseSchema, type DraftDetailResponse, type IntakeResponse } from '@/contract/api';
import { closePool, getPool } from '@/server/db';
import { GET as draftDetail } from '../../app/api/drafts/[id]/route';
import { GET as health } from '../../app/api/health/route';
import { POST as drain } from '../../app/api/jobs/drain/route';
import { POST as intake } from '../../app/api/source-docs/route';
import { POST as upload } from '../../app/api/source-files/route';
import { count, dropWorkspaces, track } from '../integration/helpers';
import { call, fileForm, pngBytes, resetToday } from './helpers';

beforeAll(async () => {
  await resetToday();
});

beforeEach(async () => {
  await getPool().query('TRUNCATE jobs RESTART IDENTITY');
});

afterAll(async () => {
  await dropWorkspaces();
  await resetToday();
  await closePool();
});

describe('키가 없는 서버', () => {
  it('글은 규칙만으로 뽑히고 까닭이 "키 없음"으로 남는다', async () => {
    const text = '새벽달 응원 슬로건 판매합니다.\n가격은 5,000원입니다.\n크기는 200x600mm 입니다.';
    const got = await call<IntakeResponse>(intake, 'POST', '/api/source-docs', { body: { text } });
    expect(got.status).toBe(201);
    const ws = track(got.body.workspace);
    await call(drain, 'POST', '/api/jobs/drain');
    const detail = await call<DraftDetailResponse>(draftDetail, 'GET', `/api/drafts/${got.body.draftId}`, { ws, id: got.body.draftId });
    expect(DraftDetailResponseSchema.parse(detail.body)).toMatchObject({ extractedBy: 'rules', llm: { recorded: false, live: false, skipCause: 'no_key' } });
    expect(detail.body.reasons).toContain('LLM_SKIPPED');
  });

  it('그림은 접수하지 않는다(503, 까닭 no_key). 공간도 남기지 않는다', async () => {
    const before = await count('workspaces');
    const got = await call(upload, 'POST', '/api/source-files', { body: fileForm(pngBytes()) });
    expect(got.status).toBe(503);
    expect(ApiErrorBodySchema.parse(got.body)).toMatchObject({ code: 'LLM_UNAVAILABLE', skipCause: 'no_key' });
    expect(await count('workspaces')).toBe(before);
  });

  it('살아 있는지 응답이 실제 호출이 닫혀 있다고 말한다', async () => {
    const got = await call(health, 'GET', '/api/health');
    expect(HealthResponseSchema.parse(got.body).llm).toMatchObject({ live: false, liveCap: 0, liveLeftToday: 0 });
  });
});
