// 접수: 같은 글은 한 건, 셋이 함께 들어감, 상한, 작업 공간.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, PUBLIC_WORKSPACE_ID } from '@/contract/api';
import { closePool, getPool, withTx } from '@/server/db';
import { intakeMany, intakeOne } from '@/server/intake';
import { cleanText, hashText, prepareText } from '@/server/limits';
import { bumpCounter, readCounter } from '@/server/repos/daily-counters';
import { getDraftDetail, listDrafts } from '@/server/repos/drafts';
import { receiveDoc } from '@/server/repos/source-docs';
import { ensurePublicWorkspace, parseWorkspaceId, sweepStaleWorkspaces, workspaceForWrite } from '@/server/workspace';
import { at, count, dropWorkspaces, newWorkspace, sampleText, T0, track } from './helpers';

const local = { workspaceId: null, now: T0, kindForNew: 'local' as const };

beforeEach(async () => {
  await getPool().query('DELETE FROM daily_counters WHERE day < $1', ['2002-01-01']);
});

afterAll(async () => {
  await dropWorkspaces();
  await closePool();
});

describe('글 정리', () => {
  it('전각 글자, 줄바꿈 꼴, 이어진 공백이 달라도 같은 글이 된다', () => {
    const a = cleanText('강남역  ４번출구 LED\r\n\r\n\r\n１주 150만원  ');
    const b = cleanText(' 강남역 4번출구 LED\n\n1주 150만원');
    expect(a).toBe('강남역 4번출구 LED\n\n1주 150만원');
    expect(hashText(a)).toBe(hashText(b));
  });

  it('빈 글과 4,000자가 넘는 글은 400 이다. 4,000자는 된다', () => {
    expect(() => prepareText('   \n ')).toThrow(expect.objectContaining({ code: 'BAD_INPUT' }));
    expect(() => prepareText(123)).toThrow(expect.objectContaining({ code: 'BAD_INPUT' }));
    expect(() => prepareText('가'.repeat(LIMITS.textMaxChars + 1))).toThrow(expect.objectContaining({ code: 'BAD_INPUT' }));
    expect(prepareText('가'.repeat(LIMITS.textMaxChars)).clean).toHaveLength(LIMITS.textMaxChars);
  });
});

describe('접수', () => {
  it('글 한 건이 원문 1줄 + 초안 1줄(처리 중) + 작업 1줄 + 변경 기록 1줄이 된다', async () => {
    const ws = await newWorkspace();
    const got = await intakeOne(sampleText(), { workspaceId: ws, now: T0 });
    expect(got).toMatchObject({ workspace: ws, status: 'PROCESSING', duplicate: false });

    const detail = await getDraftDetail(getPool(), ws, got.draftId);
    expect(detail?.draft).toMatchObject({ status: 'PROCESSING', version: 1, sourceDocId: got.sourceDocId });
    expect(detail?.events).toEqual([expect.objectContaining({ actor: 'system', action: 'status', from: null, to: 'PROCESSING' })]);
    expect(await count(`jobs WHERE kind = 'extract' AND ref_id = $1 AND status = 'queued'`, [got.draftId])).toBe(1);
  });

  it('같은 글을 두 번 넣으면 한 건이다(공백만 다른 글도)', async () => {
    const ws = await newWorkspace();
    const text = sampleText('같은 글');
    const first = await intakeOne(text, { workspaceId: ws, now: T0 });
    const second = await intakeOne(`  ${text.replace(' ', '   ')}\r\n`, { workspaceId: ws, now: at(1000) });

    expect(second).toMatchObject({ duplicate: true, draftId: first.draftId, sourceDocId: first.sourceDocId });
    expect(await count('source_docs WHERE workspace_id = $1', [ws])).toBe(1);
    expect(await count('drafts WHERE workspace_id = $1', [ws])).toBe(1);
    expect(await count(`jobs WHERE kind = 'extract' AND ref_id = $1`, [first.draftId])).toBe(1);
    expect(await readCounter(getPool(), 'intake', T0)).toBe(1);
  });

  it('같은 글을 다섯이 동시에 넣어도 한 건이다', async () => {
    const ws = await newWorkspace();
    const text = sampleText('동시');
    const results = await Promise.all(Array.from({ length: 5 }, () => intakeOne(text, { workspaceId: ws, now: T0 })));

    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.draftId)).size).toBe(1);
    expect(await count('source_docs WHERE workspace_id = $1', [ws])).toBe(1);
    expect(await count('drafts WHERE workspace_id = $1', [ws])).toBe(1);
  });

  it('공간을 잠그지 않고 두 트랜잭션이 같은 글을 넣어도 UNIQUE 가 하나만 남긴다', async () => {
    const ws = await newWorkspace();
    const { clean, hash } = prepareText(sampleText('잠금 없이'));
    const results = await Promise.all([1, 2].map(() => withTx((c) => receiveDoc(c, { workspaceId: ws, clean, hash, now: T0 }))));

    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(results[0]?.draftId).toBe(results[1]?.draftId);
    expect(await count('drafts WHERE workspace_id = $1', [ws])).toBe(1);
  });

  it('같은 글이라도 공간이 다르면 따로 받는다', async () => {
    const text = sampleText('공간 둘');
    const a = await intakeOne(text, { workspaceId: await newWorkspace(), now: T0 });
    const b = await intakeOne(text, { workspaceId: await newWorkspace(), now: T0 });
    expect(b.duplicate).toBe(false);
    expect(b.draftId).not.toBe(a.draftId);
  });

  it('여러 건: 건마다 new / duplicate / error 를 돌려주고, 틀린 건이 있어도 나머지는 들어간다', async () => {
    const ws = await newWorkspace();
    const one = sampleText('묶음');
    const { items } = await intakeMany([one, '', one, sampleText('묶음'), '가'.repeat(4001)], { workspaceId: ws, now: T0 });

    expect(items.map((i) => i.result)).toEqual(['new', 'error', 'duplicate', 'new', 'error']);
    expect(await count('source_docs WHERE workspace_id = $1 AND batch_no = 1', [ws])).toBe(2);
  });

  it('여러 건은 50건까지다', async () => {
    const texts = Array.from({ length: LIMITS.bulkMaxDocs + 1 }, (_, i) => `글 ${i}`);
    await expect(intakeMany(texts, { workspaceId: await newWorkspace(), now: T0 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(intakeMany([], local)).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});

describe('상한', () => {
  it('공간 하나에 초안은 100건까지다. 101번째는 429 이고 아무것도 남기지 않는다', async () => {
    const ws = await newWorkspace();
    await getPool().query(
      `WITH docs AS (
         INSERT INTO source_docs (workspace_id, clean_text, content_hash)
         SELECT $1, '글 ' || g, 'fill-' || g FROM generate_series(1, $2::int) g RETURNING id)
       INSERT INTO drafts (workspace_id, source_doc_id) SELECT $1, id FROM docs`,
      [ws, LIMITS.draftsPerWorkspace - 1],
    );
    await expect(intakeOne(sampleText(), { workspaceId: ws, now: T0 })).resolves.toMatchObject({ duplicate: false });
    await expect(intakeOne(sampleText(), { workspaceId: ws, now: T0 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(await count('drafts WHERE workspace_id = $1', [ws])).toBe(LIMITS.draftsPerWorkspace);
    expect(await readCounter(getPool(), 'intake', T0)).toBe(1);
  });

  it('하루 전체 접수는 2,000건까지다. 날짜(한국 시각)가 바뀌면 다시 받는다', async () => {
    const ws = await newWorkspace();
    await bumpCounter(getPool(), 'intake', T0, LIMITS.intakePerDay - 1, LIMITS.intakePerDay);
    await expect(intakeOne(sampleText(), { workspaceId: ws, now: T0 })).resolves.toBeDefined();
    await expect(intakeOne(sampleText(), { workspaceId: ws, now: T0 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });

    // T0 은 한국 시각 낮 12시. 12시간 뒤는 다음 날이다.
    await expect(intakeOne(sampleText(), { workspaceId: ws, now: at(12 * 3600_000) })).resolves.toBeDefined();
    expect(await count('drafts WHERE workspace_id = $1', [ws])).toBe(2);
  });

  it('하루 세기는 여럿이 동시에 올려도 상한을 넘지 않는다', async () => {
    const tries = await Promise.all(Array.from({ length: 12 }, () => bumpCounter(getPool(), 'live_llm', T0, 1, 5)));
    expect(tries.filter((t) => t.ok)).toHaveLength(5);
    expect(await readCounter(getPool(), 'live_llm', T0)).toBe(5);
  });
});

describe('작업 공간', () => {
  it('번호 없이 쓰면 그때 공간이 생기고 응답에 실린다', async () => {
    const got = await intakeOne(sampleText(), local);
    track(got.workspace);
    expect(parseWorkspaceId(got.workspace)).toBe(got.workspace);
    expect(await count(`workspaces WHERE id = $1 AND kind = 'local'`, [got.workspace])).toBe(1);
  });

  it('틀린 글로는 공간이 생기지 않는다', async () => {
    const before = await count('workspaces');
    await expect(intakeOne('  ', local)).rejects.toMatchObject({ code: 'BAD_INPUT' });
    const many = await intakeMany(['', ' '], local);
    expect(many.workspace).toBeNull();
    expect(await count('workspaces')).toBe(before);
  });

  it('모르는 번호(지워진 공간)로 쓰면 그 번호로 공간을 다시 만든다. 동시에 셋이 와도 공간은 하나다', async () => {
    const gone = track('11111111-2222-4333-8444-555555555555');
    await getPool().query('DELETE FROM workspaces WHERE id = $1', [gone]);
    const got = await Promise.all([1, 2, 3].map(() => intakeOne(sampleText(), { ...local, workspaceId: gone })));
    expect(got.map((g) => g.workspace)).toEqual([gone, gone, gone]);
    expect(await count('workspaces WHERE id = $1', [gone])).toBe(1);
    expect(await count('drafts WHERE workspace_id = $1', [gone])).toBe(3);
  });

  it('본보기 공간에는 쓰지 못한다', async () => {
    await ensurePublicWorkspace(getPool(), T0);
    await expect(intakeOne(sampleText(), { workspaceId: PUBLIC_WORKSPACE_ID, now: T0 })).rejects.toMatchObject({ code: 'READ_ONLY_WORKSPACE' });
    expect(await count('drafts WHERE workspace_id = $1', [PUBLIC_WORKSPACE_ID])).toBe(0);
  });

  it('공간 번호의 꼴이 틀리면 400, 없으면 null', () => {
    expect(parseWorkspaceId(undefined)).toBeNull();
    expect(parseWorkspaceId('  ')).toBeNull();
    expect(() => parseWorkspaceId("1' OR '1'='1")).toThrow(expect.objectContaining({ code: 'BAD_INPUT' }));
  });

  it('쓰면 마지막 쓰기 시각이 바뀐다', async () => {
    const ws = await newWorkspace();
    await withTx((c) => workspaceForWrite(c, ws, at(5000)));
    const { rows } = await getPool().query<{ last_write_at: Date }>('SELECT last_write_at FROM workspaces WHERE id = $1', [ws]);
    expect(rows[0]?.last_write_at.toISOString()).toBe(at(5000).toISOString());
  });

  it('2일 넘게 쓰기가 없던 방문자 공간만 묶어 지운다. 원문·초안·작업도 함께 사라진다', async () => {
    const day = 24 * 3600_000;
    const old1 = await newWorkspace('sandbox', at(-10 * day));
    const old2 = await newWorkspace('sandbox', at(-9 * day));
    const old3 = await newWorkspace('sandbox', at(-8 * day));
    const fresh = await newWorkspace('sandbox', at(-1 * day));
    const mine = await newWorkspace('local', at(-10 * day));
    const doc = await intakeOne(sampleText(), { workspaceId: old1, now: at(-10 * day) });
    await getPool().query('UPDATE workspaces SET last_write_at = $2 WHERE id = $1', [old1, at(-10 * day)]);

    // 한 번에 두 개씩: 오래된 것부터.
    expect(await sweepStaleWorkspaces(getPool(), T0, 2)).toBe(2);
    expect(await count('workspaces WHERE id = ANY($1::uuid[])', [[old1, old2]])).toBe(0);
    expect(await count('drafts WHERE id = $1', [doc.draftId])).toBe(0);
    expect(await count(`jobs WHERE kind = 'extract' AND ref_id = $1`, [doc.draftId])).toBe(0);

    expect(await sweepStaleWorkspaces(getPool(), T0, 2)).toBe(1);
    expect(await count('workspaces WHERE id = $1', [old3])).toBe(0);
    expect(await count('workspaces WHERE id = ANY($1::uuid[])', [[fresh, mine]])).toBe(2);
  });
});

describe('검수함 목록', () => {
  it('새것부터, 쪽을 넘기며, 상태로 거른다. 남의 공간 것은 안 보인다', async () => {
    const ws = await newWorkspace();
    const other = await newWorkspace();
    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await intakeOne(sampleText(), { workspaceId: ws, now: T0 })).draftId);
    await intakeOne(sampleText(), { workspaceId: other, now: T0 });

    const page1 = await listDrafts(getPool(), ws, { limit: 2 });
    expect(page1.items.map((d) => d.id)).toEqual([ids[4], ids[3]]);
    const page2 = await listDrafts(getPool(), ws, { limit: 2, cursor: page1.nextCursor ?? undefined });
    expect(page2.items.map((d) => d.id)).toEqual([ids[2], ids[1]]);
    const page3 = await listDrafts(getPool(), ws, { limit: 2, cursor: page2.nextCursor ?? undefined });
    expect(page3).toMatchObject({ items: [{ id: ids[0] }], nextCursor: null });

    expect((await listDrafts(getPool(), ws, { status: 'READY' })).items).toEqual([]);
    expect((await listDrafts(getPool(), ws, { status: 'PROCESSING' })).items).toHaveLength(5);
    await expect(listDrafts(getPool(), ws, { status: 'DONE' })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(await getDraftDetail(getPool(), other, ids[0] as number)).toBeNull();
  });
});
