// 용어 사전의 줄(glossary_terms)에서 "지금 쓰이는 용어집"을 읽는다. 글 만들기·글 검사·번역 검사가 모두 이것만 본다.
// 무엇이 쓰이는지 정하는 규칙은 약속의 순수 함수(effectiveGlossary)에 있고, 여기는 줄을 읽어 넘기는 얇은 층이다.
// 줄을 더하고 고치는 일(용어 사전 화면의 API)은 src/server/glossary.ts 가 한다.
import { PUBLIC_WORKSPACE_ID } from '@/contract/api';
import { GlossarySchema, type GlossaryEntry } from '@/contract/content';
import { effectiveGlossary, type GlossaryRow, type GlossaryStatus } from '@/contract/tools/glossary';
import glossaryJson from '../../../data/seed/glossary.json';
import type { Db } from '../types';

/** data/seed/glossary.json. 꼴이 틀리면 여기서 멈춘다. 씨앗이 이것을 공용 줄로 싣는다. */
export function seedGlossary(): GlossaryEntry[] {
  return GlossarySchema.parse(glossaryJson);
}

/**
 * 이 공간의 글 만들기·글 검사가 쓰는 용어집. 승인된 공용 줄 + 승인된 내 줄이고, 같은 낱말이면 내 줄이다.
 * 공용 줄이 한 줄도 없는 DB(씨앗을 심지 않았다)에서는 씨앗 파일을 공용 줄로 본다.
 * 그래서 이행만 하고 씨앗을 안 심은 DB 에서도 글 만들기가 전과 같은 용어집으로 돈다.
 */
export async function approvedGlossary(db: Db, workspaceId: string): Promise<GlossaryEntry[]> {
  const { rows } = await db.query<{ workspace_id: string; ko: string; en: string | null; zh_hans: string | null; status: GlossaryStatus }>(
    `SELECT workspace_id, ko, en, zh_hans, status FROM glossary_terms
      WHERE workspace_id = $1 OR workspace_id = $2
      ORDER BY id`,
    [workspaceId, PUBLIC_WORKSPACE_ID],
  );
  const toRow = (r: (typeof rows)[number]): GlossaryRow => ({ ko: r.ko, en: r.en, 'zh-Hans': r.zh_hans, status: r.status });
  const sharedRows = rows.filter((r) => r.workspace_id === PUBLIC_WORKSPACE_ID).map(toRow);
  const own = workspaceId === PUBLIC_WORKSPACE_ID ? [] : rows.filter((r) => r.workspace_id === workspaceId).map(toRow);
  const shared = sharedRows.length > 0 ? sharedRows : seedGlossary().map((e): GlossaryRow => ({ ...e, status: 'approved' }));
  return effectiveGlossary(own, shared);
}

/**
 * 씨앗 파일의 줄을 본보기 공간에 승인 상태로 싣는다. 두 번 돌려도 같은 결과다.
 * 같은 낱말이 이미 있으면 표기를 씨앗 파일의 것으로 맞춘다(본보기 공간은 씨앗만 쓴다).
 * 본보기 공간이 먼저 있어야 한다(ensurePublicWorkspace).
 */
export async function seedGlossaryTerms(db: Db, now: Date, entries: readonly GlossaryEntry[] = seedGlossary()): Promise<{ added: number; kept: number }> {
  let added = 0;
  for (const entry of entries) {
    const { rows } = await db.query<{ inserted: boolean }>(
      `INSERT INTO glossary_terms (workspace_id, ko, en, zh_hans, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'approved', $5, $5)
       ON CONFLICT (workspace_id, ko) DO UPDATE
         SET en = EXCLUDED.en, zh_hans = EXCLUDED.zh_hans, status = 'approved',
             updated_at = CASE WHEN glossary_terms.en IS DISTINCT FROM EXCLUDED.en
                                 OR glossary_terms.zh_hans IS DISTINCT FROM EXCLUDED.zh_hans
                                 OR glossary_terms.status <> 'approved'
                               THEN EXCLUDED.updated_at ELSE glossary_terms.updated_at END
       RETURNING (xmax = 0) AS inserted`,
      [PUBLIC_WORKSPACE_ID, entry.ko, entry.en, entry['zh-Hans'], now],
    );
    if (rows[0]?.inserted) added += 1;
  }
  return { added, kept: entries.length - added };
}
