// 용어 사전의 표에서 "지금 쓰이는 용어집"을 읽는 길. 승인된 용어가 그대로면 글 만들기 요청(장부 키)이 그대로인지 본다.
// 본보기 공간의 줄을 건드리는 시험은 되돌릴 트랜잭션 안에서만 한다(다른 시험이 같은 DB 를 쓴다).
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PUBLIC_WORKSPACE_ID } from '@/contract/api';
import type { LlmRequest } from '@/contract/llm-types';
import contentApi from '@/content';
import { buildContentRequest, cacheKeyFor } from '@/llm';
import { contentInputOf } from '@/server/content-input';
import { closePool, getPool } from '@/server/db';
import { approvedGlossary, seedGlossary, seedGlossaryTerms } from '@/server/repos/glossary-terms';
import { ensurePublicWorkspace } from '@/server/workspace';
import { T0 } from './helpers';

afterAll(async () => {
  await closePool();
});

async function inRollback(run: (client: PoolClient, wsId: string) => Promise<void>) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await ensurePublicWorkspace(client, T0);
    // 다른 시험이 남긴 공용 줄이 있어도 빈 데서 시작한다(되돌리므로 남지 않는다).
    await client.query('DELETE FROM glossary_terms WHERE workspace_id = $1', [PUBLIC_WORKSPACE_ID]);
    const ws = await client.query<{ id: string }>(`INSERT INTO workspaces (kind) VALUES ('local') RETURNING id`);
    await run(client, ws.rows[0]?.id as string);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const byKo = <T extends { ko: string }>(items: readonly T[]) => [...items].sort((a, b) => (a.ko < b.ko ? -1 : a.ko > b.ko ? 1 : 0));

const AD = {
  type: 'ad' as const,
  subtype: '전광판',
  name: '합정역 전광판',
  price_krw: 1500000,
  spec: { region: '합정역' },
  options: [{ days: 7, price_krw: 1500000 }],
};
const keyOf = (glossary: Parameters<typeof contentInputOf>[1]) =>
  cacheKeyFor(buildContentRequest(contentInputOf(AD, glossary, contentApi.pickGlossary).content) as LlmRequest<unknown>, 'claude-haiku-5-5');

describe('쓰이는 용어집', () => {
  it('공용 줄이 한 줄도 없으면 씨앗 파일을 그대로 쓴다', async () => {
    await inRollback(async (client, ws) => {
      expect(await approvedGlossary(client, ws)).toEqual(byKo(seedGlossary()));
      expect(await approvedGlossary(client, PUBLIC_WORKSPACE_ID)).toEqual(byKo(seedGlossary()));
    });
  });

  it('씨앗이 파일의 줄을 승인 상태로 싣는다. 두 번 돌려도 같다', async () => {
    await inRollback(async (client, ws) => {
      const first = await seedGlossaryTerms(client, T0);
      expect(first).toEqual({ added: seedGlossary().length, kept: 0 });
      expect(await seedGlossaryTerms(client, T0)).toEqual({ added: 0, kept: seedGlossary().length });
      const { rows } = await client.query<{ status: string; n: string }>(
        'SELECT status, count(*) AS n FROM glossary_terms WHERE workspace_id = $1 GROUP BY status',
        [PUBLIC_WORKSPACE_ID],
      );
      expect(rows).toEqual([{ status: 'approved', n: String(seedGlossary().length) }]);
      expect(await approvedGlossary(client, ws)).toEqual(byKo(seedGlossary()));
    });
  });

  it('승인된 용어가 그대로면 글 만들기 요청의 장부 키가 그대로다(씨앗 파일 → 표)', async () => {
    await inRollback(async (client, ws) => {
      const before = keyOf(seedGlossary());
      await seedGlossaryTerms(client, T0);
      expect(keyOf(await approvedGlossary(client, ws))).toBe(before);
      // 상관없는 낱말을 승인해도, 제안만 해 두어도 이 상품의 요청은 그대로다.
      await client.query(`INSERT INTO glossary_terms (workspace_id, ko, en, zh_hans, status) VALUES ($1, '응원봉', 'light stick', '应援棒', 'approved')`, [ws]);
      await client.query(`INSERT INTO glossary_terms (workspace_id, ko, en, zh_hans, status) VALUES ($1, '합정역', 'Hapjeong Stn.', '合井', 'proposed')`, [ws]);
      expect(keyOf(await approvedGlossary(client, ws))).toBe(before);
    });
  });

  it('이 상품에 든 낱말의 승인된 표기를 바꾸면 그 공간의 요청만 달라진다', async () => {
    await inRollback(async (client, ws) => {
      await seedGlossaryTerms(client, T0);
      const before = keyOf(await approvedGlossary(client, ws));
      await client.query(`INSERT INTO glossary_terms (workspace_id, ko, en, zh_hans, status) VALUES ($1, '전광판', 'LED billboard', '电子屏', 'approved')`, [ws]);
      const mine = await approvedGlossary(client, ws);
      expect(mine.find((e) => e.ko === '전광판')?.en).toBe('LED billboard');
      expect(mine).toHaveLength(seedGlossary().length);
      expect(keyOf(mine)).not.toBe(before);
      // 다른 공간과 본보기 공간은 공용 줄 그대로다.
      const other = await client.query<{ id: string }>(`INSERT INTO workspaces (kind) VALUES ('local') RETURNING id`);
      expect(keyOf(await approvedGlossary(client, other.rows[0]?.id as string))).toBe(before);
      expect(keyOf(await approvedGlossary(client, PUBLIC_WORKSPACE_ID))).toBe(before);
    });
  });

  it('씨앗 파일의 표기가 바뀌면 다시 심을 때 공용 줄이 따라온다', async () => {
    await inRollback(async (client, ws) => {
      await seedGlossaryTerms(client, T0);
      const changed = seedGlossary().map((e) => (e.ko === '버스' ? { ...e, en: 'city bus' } : e));
      expect(await seedGlossaryTerms(client, T0, changed)).toEqual({ added: 0, kept: changed.length });
      expect((await approvedGlossary(client, ws)).find((e) => e.ko === '버스')?.en).toBe('city bus');
    });
  });
});
