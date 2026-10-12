// 용어 사전: 목록·더하기·승인·고치기와 경로. 승인된 용어만 글 만들기·글 검사·점검에 쓰이는지, 장부 키가 그대로인지 본다.
// 이 시험은 tests/ 아래가 아니라 여기 있다. DB 시험이 도는 자리(vitest 의 db 쪽 include)가 src/**/*.db.test.ts 이기 때문이다.
// 본보기 공간의 공용 줄을 건드리는 시험은 되돌릴 트랜잭션 안에서만 한다(다른 시험이 같은 DB 를 쓴다).
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PUBLIC_WORKSPACE_ID } from '@/contract/api';
import type { ContentCheckResponse } from '@/contract/content';
import type { LlmRequest } from '@/contract/llm-types';
import { GLOSSARY_LIMITS, GlossaryListResponseSchema, GlossaryWriteResponseSchema, type GlossaryListResponse, type GlossaryWriteResponse } from '@/contract/tools/glossary';
import contentApi from '@/content';
import { buildContentRequest, cacheKeyFor } from '@/llm';
import { POST as contentChecksRoute } from '../../app/api/content-checks/route';
import { PATCH as patchRoute } from '../../app/api/glossary/[id]/route';
import { GET as listRoute, POST as createRoute } from '../../app/api/glossary/route';
import { call } from '../../tests/api/helpers';
import { at, dropWorkspaces, field, newWorkspace, reviewableDraft, T0, track } from '../../tests/integration/helpers';
import { auditWorkspace } from './audit';
import { contentInputOf } from './content-input';
import { closePool, getPool } from './db';
import { listGlossary, patchGlossaryTermIn } from './glossary';
import { approvedGlossary, seedGlossary, seedGlossaryTerms } from './repos/glossary-terms';
import { saveProductTexts } from './repos/products';
import { approveDraft } from './review';
import { ensurePublicWorkspace } from './workspace';

afterAll(async () => {
  await dropWorkspaces();
  await closePool();
});

const AD = {
  type: 'ad' as const,
  subtype: '전광판',
  name: '합정역 전광판',
  price_krw: 1500000,
  spec: { region: '합정역' },
  options: [{ days: 7, price_krw: 1500000 }],
};
/** 이 상품의 글 만들기 요청의 장부 키. 용어집이 같으면 키가 같고, 그러면 받아 둔 녹화본이 그대로 맞는다. */
const keyOf = (glossary: Parameters<typeof contentInputOf>[1]) =>
  cacheKeyFor(buildContentRequest(contentInputOf(AD, glossary, contentApi.pickGlossary).content) as LlmRequest<unknown>, 'claude-haiku-5-5');

const create = (ws: string | null, body: unknown) => call<GlossaryWriteResponse>(createRoute, 'POST', '/api/glossary', { ws, body });
const patch = (ws: string | null, id: number, body: unknown) => call<GlossaryWriteResponse>(patchRoute, 'PATCH', `/api/glossary/${id}`, { ws, id, body });
const list = (ws: string | null, query = '') => call<GlossaryListResponse>(listRoute, 'GET', `/api/glossary${query}`, { ws });

describe('용어 더하기', () => {
  it('헤더 없이 더하면 새 공간이 생기고 제안 상태로 들어간다', async () => {
    const got = await create(null, { ko: '응원봉', en: 'light stick' });
    expect(got.status).toBe(201);
    expect(GlossaryWriteResponseSchema.safeParse(got.body).success).toBe(true);
    track(got.body.workspace);
    expect(got.body.term).toMatchObject({ ko: '응원봉', en: 'light stick', 'zh-Hans': null, status: 'proposed', note: null, shared: false, overridden: false });
  });

  it('같은 공간에 같은 낱말은 두 번 못 넣는다. 다른 공간에는 된다', async () => {
    const ws = await newWorkspace();
    expect((await create(ws, { ko: '응원봉' })).status).toBe(201);
    const again = await create(ws, { ko: ' 응원봉 ', en: 'light stick', 'zh-Hans': '应援棒', status: 'approved' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'ALREADY_EXISTS' });
    expect((await create(await newWorkspace(), { ko: '응원봉' })).status).toBe(201);
  });

  it('승인으로 넣으려면 두 표기가 다 있어야 한다. 꼴이 틀린 요청은 400', async () => {
    const ws = await newWorkspace();
    expect((await create(ws, { ko: '응원봉', en: 'light stick', status: 'approved' })).status).toBe(400);
    expect((await create(ws, { ko: '' })).status).toBe(400);
    expect((await create(ws, { ko: '가'.repeat(GLOSSARY_LIMITS.termMaxChars + 1) })).status).toBe(400);
    expect((await create(ws, { ko: '응원봉', extra: 1 })).status).toBe(400);
    // 제어 글자뿐인 표기는 정리하고 나면 빈 글자다.
    expect((await create(ws, { ko: '응원봉', en: '\u0001' })).status).toBe(400);
    const ok = await create(ws, { ko: '응원봉', en: 'light  stick', 'zh-Hans': '应援棒', note: '공연장에서 쓰는 것', status: 'approved' });
    expect(ok.status).toBe(201);
    expect(ok.body.term).toMatchObject({ en: 'light stick', status: 'approved', note: '공연장에서 쓰는 것' });
  });

  it('본보기 공간에는 못 넣는다', async () => {
    await ensurePublicWorkspace(getPool(), T0);
    const got = await create(PUBLIC_WORKSPACE_ID, { ko: '응원봉' });
    expect(got.status).toBe(403);
    expect(got.body).toMatchObject({ code: 'READ_ONLY_WORKSPACE' });
  });

  it('공간의 줄 수가 상한에 닿으면 429', async () => {
    const ws = await newWorkspace();
    await getPool().query(
      `INSERT INTO glossary_terms (workspace_id, ko) SELECT $1, '낱말' || n FROM generate_series(1, $2::int) AS n`,
      [ws, GLOSSARY_LIMITS.termsPerWorkspace],
    );
    const got = await create(ws, { ko: '하나 더' });
    expect(got.status).toBe(429);
    expect(got.body).toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});

describe('용어 고치기·승인', () => {
  it('준 칸만 바뀐다. 표기가 비면 승인하지 못한다. 승인을 풀 수 있다', async () => {
    const ws = await newWorkspace();
    const made = (await create(ws, { ko: '응원봉', en: 'light stick', note: '메모' })).body.term;

    const noZh = await patch(ws, made.id, { status: 'approved' });
    expect(noZh.status).toBe(400);

    const approved = await patch(ws, made.id, { 'zh-Hans': '应援棒', status: 'approved' });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ workspace: ws, term: { ko: '응원봉', en: 'light stick', 'zh-Hans': '应援棒', status: 'approved', note: '메모' } });

    // 승인된 줄의 표기를 비우면 승인일 수 없다. 승인을 함께 풀면 된다.
    expect((await patch(ws, made.id, { en: null })).status).toBe(400);
    const back = await patch(ws, made.id, { en: null, note: null, status: 'proposed' });
    expect(back.body.term).toMatchObject({ en: null, 'zh-Hans': '应援棒', status: 'proposed', note: null });

    expect((await patch(ws, made.id, {})).status).toBe(400);
    expect((await patch(ws, made.id, { ko: '다른 낱말' })).status).toBe(400);
  });

  it('다른 공간의 줄, 없는 번호, 헤더 없는 요청은 404', async () => {
    const ws = await newWorkspace();
    const made = (await create(ws, { ko: '응원봉' })).body.term;
    expect((await patch(await newWorkspace(), made.id, { en: 'x' })).status).toBe(404);
    expect((await patch(null, made.id, { en: 'x' })).status).toBe(404);
    expect((await patch(ws, 999_999_999, { en: 'x' })).status).toBe(404);
    expect((await patch(ws, 'abc' as unknown as number, { en: 'x' })).status).toBe(404);
  });
});

async function inRollback(run: (client: PoolClient, ws: string) => Promise<void>) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await ensurePublicWorkspace(client, T0);
    // 다른 시험이 남긴 공용 줄이 있어도 씨앗 파일의 줄에서 시작한다(되돌리므로 남지 않는다).
    await client.query('DELETE FROM glossary_terms WHERE workspace_id = $1', [PUBLIC_WORKSPACE_ID]);
    await seedGlossaryTerms(client, T0);
    const ws = await client.query<{ id: string }>(`INSERT INTO workspaces (kind) VALUES ('local') RETURNING id`);
    await run(client, ws.rows[0]?.id as string);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const insert = async (client: PoolClient, ws: string, ko: string, en: string | null, zh: string | null, status: 'proposed' | 'approved') => {
  const { rows } = await client.query<{ id: string }>(
    'INSERT INTO glossary_terms (workspace_id, ko, en, zh_hans, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [ws, ko, en, zh, status],
  );
  return Number(rows[0]?.id);
};

describe('목록과 공용 줄', () => {
  it('공용 줄이 먼저(낱말 순서), 그다음 내 줄. 내 승인 줄에 가린 공용 줄을 알려 준다', async () => {
    await inRollback(async (client, ws) => {
      const seeds = seedGlossary().length;
      await insert(client, ws, '전광판', 'LED billboard', '电子屏', 'approved');
      await insert(client, ws, '버스', 'city bus', null, 'proposed');
      await insert(client, ws, '응원봉', 'light stick', '应援棒', 'approved');

      const out = await listGlossary(ws, {}, client);
      expect(GlossaryListResponseSchema.safeParse(out).success).toBe(true);
      expect(out.items).toHaveLength(seeds + 3);
      const shared = out.items.slice(0, seeds);
      expect(shared.every((t) => t.shared && t.status === 'approved')).toBe(true);
      expect(shared.map((t) => t.ko)).toEqual([...shared.map((t) => t.ko)].sort());
      // 승인된 내 줄만 공용 줄을 가린다. 제안만 해 둔 "버스"는 가리지 않는다.
      expect(shared.filter((t) => t.overridden).map((t) => t.ko)).toEqual(['전광판']);
      expect(out.items.slice(seeds).map((t) => [t.ko, t.shared, t.status])).toEqual([
        ['버스', false, 'proposed'],
        ['응원봉', false, 'approved'],
        ['전광판', false, 'approved'],
      ]);
      expect(out.counts).toEqual({ proposed: 1, approved: seeds + 2 });
      // 쓰이는 수: 공용 줄 전부 + 새 낱말 하나("전광판"은 겹친다).
      expect(out.inUse).toBe(seeds + 1);

      const proposed = await listGlossary(ws, { status: 'proposed' }, client);
      expect(proposed.items.map((t) => t.ko)).toEqual(['버스']);
      expect(proposed.counts).toEqual(out.counts);

      // 본보기 공간에서 보면 공용 줄뿐이다.
      const pub = await listGlossary(PUBLIC_WORKSPACE_ID, {}, client);
      expect(pub.items).toHaveLength(seeds);
      expect(pub.inUse).toBe(seeds);
    });
  });

  it('공용 줄은 누구도 고치지 못한다', async () => {
    await inRollback(async (client, ws) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM glossary_terms WHERE workspace_id = $1 AND ko = '버스'`, [PUBLIC_WORKSPACE_ID]);
      const sharedId = Number(rows[0]?.id);
      await expect(patchGlossaryTermIn(client, ws, sharedId, { en: 'coach' }, T0)).rejects.toMatchObject({ code: 'READ_ONLY_WORKSPACE' });
      await expect(patchGlossaryTermIn(client, PUBLIC_WORKSPACE_ID, sharedId, { en: 'coach' }, T0)).rejects.toMatchObject({ code: 'READ_ONLY_WORKSPACE' });
      expect((await approvedGlossary(client, ws)).find((e) => e.ko === '버스')?.en).toBe('bus');
    });
  });

  it('장부 키: 제안만 해 두거나 상관없는 낱말을 승인해도 그대로다. 이 상품의 낱말을 승인하면 그 공간만 달라진다', async () => {
    await inRollback(async (client, ws) => {
      const before = keyOf(seedGlossary());
      expect(keyOf(await approvedGlossary(client, ws))).toBe(before);

      const mine = await insert(client, ws, '합정역', 'Hapjeong Stn.', '合井', 'proposed');
      const unrelated = await insert(client, ws, '응원봉', 'light stick', null, 'proposed');
      expect(keyOf(await approvedGlossary(client, ws))).toBe(before);

      await patchGlossaryTermIn(client, ws, unrelated, { 'zh-Hans': '应援棒', status: 'approved' }, T0);
      expect(keyOf(await approvedGlossary(client, ws))).toBe(before);

      await patchGlossaryTermIn(client, ws, mine, { status: 'approved' }, T0);
      expect(keyOf(await approvedGlossary(client, ws))).not.toBe(before);
      expect(keyOf(await approvedGlossary(client, PUBLIC_WORKSPACE_ID))).toBe(before);

      // 승인을 풀면 다시 공용 표기가 쓰이고 키가 돌아온다.
      await patchGlossaryTermIn(client, ws, mine, { status: 'proposed' }, T0);
      expect(keyOf(await approvedGlossary(client, ws))).toBe(before);
    });
  });
});

describe('승인된 용어만 쓰인다', () => {
  it('목록 경로: 내 줄과 쓰이는 수', async () => {
    const ws = await newWorkspace();
    const base = (await list(ws)).body;
    await create(ws, { ko: '응원봉', en: 'light stick', 'zh-Hans': '应援棒' });
    const after = (await list(ws)).body;
    expect(after.items.filter((t) => !t.shared).map((t) => t.ko)).toEqual(['응원봉']);
    expect(after.counts.proposed).toBe(base.counts.proposed + 1);
    expect(after.inUse).toBe(base.inUse);
    expect((await list(ws, '?status=approved')).body.items.some((t) => t.ko === '응원봉')).toBe(false);
    expect((await list(ws, '?status=nope')).status).toBe(400);
    // 헤더가 없으면 본보기 공간을 본다. 내 줄은 보이지 않는다.
    expect((await list(null)).body.items.some((t) => t.ko === '응원봉')).toBe(false);
  });

  it('번역 검사: 제안 상태의 표기는 요구하지 않고, 승인하면 요구한다', async () => {
    const ws = await newWorkspace();
    const check = async () =>
      (await call<ContentCheckResponse>(contentChecksRoute, 'POST', '/api/content-checks', {
        ws,
        body: { items: [{ lang: 'en', field: 'title', text: 'Cheering stick set', sourceKo: '응원봉 세트' }] },
      })).body.results[0];

    const made = (await create(ws, { ko: '응원봉', en: 'light stick', 'zh-Hans': '应援棒' })).body.term;
    expect(await check()).toMatchObject({ status: 'ok', checks: { glossary: 'skipped' } });
    await patch(ws, made.id, { status: 'approved' });
    expect(await check()).toMatchObject({ status: 'needs_review', failCodes: ['GLOSSARY_MISS'] });
    await patch(ws, made.id, { status: 'proposed' });
    expect(await check()).toMatchObject({ status: 'ok' });
  });

  it('점검: 내 표기를 승인하면 이미 만든 글이 "용어 표기 다름"으로 잡힌다', async () => {
    const ws = await newWorkspace();
    const fields = [
      field('name', '합정역 전광판'), field('price_krw', 1500000), field('list_price_krw', null), field('vat_included', false),
      field('region', '합정역'), field('size_m', { width: 7, height: 12 }), field('hours', { open: '05:00', close: '01:00', nextDay: true }),
      field('footfall_per_day', 100000), field('period_options', [{ days: 7, price_krw: 1500000 }]),
    ];
    const draft = await reviewableDraft(ws, 'READY', fields, 'ad', '전광판');
    const { productId } = await approveDraft({ workspaceId: ws, draftId: draft.draftId, version: draft.version, now: at(0) });
    await saveProductTexts(getPool(), productId, [
      { field: 'title', lang: 'en', text: 'Hapjeong Station digital billboard', source: 'llm', status: 'ok', failCodes: [] },
      { field: 'summary', lang: 'en', text: 'A digital billboard at Hapjeong Station, from KRW 1,500,000 for 7 days.', source: 'llm', status: 'ok', failCodes: [] },
      { field: 'title', lang: 'zh-Hans', text: '合井站电子屏', source: 'llm', status: 'ok', failCodes: [] },
      { field: 'summary', lang: 'zh-Hans', text: '合井站的电子屏，7天1,500,000韩元起。', source: 'llm', status: 'ok', failCodes: [] },
    ]);
    expect((await auditWorkspace(ws)).totals.findings).toBe(0);

    const made = (await create(ws, { ko: '전광판', en: 'LED billboard', 'zh-Hans': '电子屏' })).body.term;
    expect((await auditWorkspace(ws)).totals.findings).toBe(0);
    await patch(ws, made.id, { status: 'approved' });
    const after = await auditWorkspace(ws);
    expect(after.items[0]?.findings.map((f) => [f.code, f.field])).toEqual([
      ['GLOSSARY_MISS', 'title_en'],
      ['GLOSSARY_MISS', 'summary_en'],
    ]);
  });
});
