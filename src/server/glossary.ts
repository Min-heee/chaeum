// 용어 사전의 줄을 읽고(목록), 더하고, 고친다. 용어 사전 화면의 API 가 부른다.
// "지금 쓰이는 용어집"을 정하는 규칙은 약속의 순수 함수(effectiveGlossary)에 있고, 글 만들기·글 검사는
// src/server/repos/glossary-terms.ts 의 approvedGlossary 로 그것을 읽는다. 여기서는 그 규칙을 다시 짜지 않는다.
import { PUBLIC_WORKSPACE_ID } from '@/contract/api';
import { cleanShortText } from '@/contract/fields';
import {
  effectiveGlossary,
  GLOSSARY_LIMITS,
  type GlossaryCreateRequest,
  type GlossaryListResponse,
  type GlossaryPatchRequest,
  type GlossaryRow,
  type GlossaryStatus,
  type GlossaryTerm,
  type GlossaryWriteResponse,
} from '@/contract/tools/glossary';
import { getPool, withTx } from './db';
import { AppError } from './errors';
import { approvedGlossary } from './repos/glossary-terms';
import { toId, type Db } from './types';
import { touchWorkspaceForWrite, workspaceForWrite } from './workspace';

interface TermRow {
  id: string;
  workspace_id: string;
  ko: string;
  en: string | null;
  zh_hans: string | null;
  status: GlossaryStatus;
  note: string | null;
  updated_at: Date;
}

const COLUMNS = 'id, workspace_id, ko, en, zh_hans, status, note, updated_at';

const toTerm = (r: TermRow, overridden = false): GlossaryTerm => ({
  id: toId(r.id),
  ko: r.ko,
  en: r.en,
  'zh-Hans': r.zh_hans,
  status: r.status,
  note: r.note,
  shared: r.workspace_id === PUBLIC_WORKSPACE_ID,
  overridden,
  updatedAt: r.updated_at.toISOString(),
});

const toRow = (r: TermRow): GlossaryRow => ({ ko: r.ko, en: r.en, 'zh-Hans': r.zh_hans, status: r.status });
const byKo = (a: { ko: string }, b: { ko: string }) => (a.ko < b.ko ? -1 : a.ko > b.ko ? 1 : 0);

/**
 * 공용 줄 + 이 공간의 줄. 공용 줄이 먼저, 그 안에서는 한국어 낱말 순서다.
 * counts 는 거르기 전의 수이고, inUse 는 이 공간의 글 만들기·글 검사가 지금 실제로 쓰는 용어의 수다.
 */
export async function listGlossary(workspaceId: string, options: { status?: GlossaryStatus } = {}, db: Db = getPool()): Promise<GlossaryListResponse> {
  const { rows } = await db.query<TermRow>(
    `SELECT ${COLUMNS} FROM glossary_terms WHERE workspace_id = $1 OR workspace_id = $2 ORDER BY id`,
    [workspaceId, PUBLIC_WORKSPACE_ID],
  );
  const shared = rows.filter((r) => r.workspace_id === PUBLIC_WORKSPACE_ID).sort(byKo);
  const own = rows.filter((r) => r.workspace_id !== PUBLIC_WORKSPACE_ID).sort(byKo);
  // 같은 낱말의 내 승인 줄이 있으면 그 공용 줄은 쓰이지 않는다. 쓰이는 규칙(effectiveGlossary)에 내 줄만 넣어 그 낱말들을 얻는다.
  const mine = new Set(effectiveGlossary(own.map(toRow), []).map((e) => e.ko));
  const all = [...shared.map((r) => toTerm(r, mine.has(r.ko))), ...own.map((r) => toTerm(r))];
  const counts: Record<GlossaryStatus, number> = { proposed: 0, approved: 0 };
  for (const term of all) counts[term.status] += 1;
  return {
    items: options.status ? all.filter((t) => t.status === options.status) : all,
    counts,
    inUse: (await approvedGlossary(db, workspaceId)).length,
  };
}

/** 글자를 정리한다(제어 글자, 이어진 빈칸). 정리하고 나니 비었으면 BAD_INPUT. null·undefined 는 그대로 둔다. */
function clean(value: string | null | undefined, what: string, allowEmpty = false): string | null | undefined {
  if (value === null || value === undefined) return value;
  const text = cleanShortText(value);
  if (text === '') {
    if (allowEmpty) return null;
    throw new AppError('BAD_INPUT', `${what}: 비었습니다. 값을 적어 주세요.`);
  }
  return text;
}

const needsBoth = () => new AppError('BAD_INPUT', '승인하려면 영어 표기와 중국어(간체) 표기가 모두 있어야 합니다.');

/**
 * 내 공간에 용어 한 줄을 더한다. status 를 비우면 제안이다. 공간이 없으면 그때 만든다.
 * 본보기 공간이면 READ_ONLY_WORKSPACE, 같은 낱말이 이 공간에 이미 있으면 ALREADY_EXISTS, 줄 수가 상한에 닿았으면 LIMIT_EXCEEDED.
 */
export async function createGlossaryTerm(workspaceId: string | null, body: GlossaryCreateRequest, now: Date): Promise<GlossaryWriteResponse> {
  const ko = clean(body.ko, '한국어 낱말') as string;
  const en = clean(body.en, '영어 표기') ?? null;
  const zh = clean(body['zh-Hans'], '중국어(간체) 표기') ?? null;
  const note = clean(body.note, '메모', true) ?? null;
  const status = body.status ?? 'proposed';
  if (status === 'approved' && (!en || !zh)) throw needsBoth();

  return withTx(async (client) => {
    // 공간 줄이 잠겨 같은 공간의 더하기가 한 줄로 선다. 그래서 아래의 수 세기가 상한을 넘지 않는다.
    const ws = await workspaceForWrite(client, workspaceId, now);
    const count = await client.query<{ n: string }>('SELECT count(*) AS n FROM glossary_terms WHERE workspace_id = $1', [ws.id]);
    if (Number(count.rows[0]?.n ?? 0) >= GLOSSARY_LIMITS.termsPerWorkspace) {
      throw new AppError('LIMIT_EXCEEDED', `한 공간에는 용어를 ${GLOSSARY_LIMITS.termsPerWorkspace}줄까지 둘 수 있습니다.`);
    }
    const { rows } = await client.query<TermRow>(
      `INSERT INTO glossary_terms (workspace_id, ko, en, zh_hans, status, note, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (workspace_id, ko) DO NOTHING
       RETURNING ${COLUMNS}`,
      [ws.id, ko, en, zh, status, note, now],
    );
    const row = rows[0];
    if (!row) throw new AppError('ALREADY_EXISTS', `이 공간의 용어 사전에 이미 있는 낱말입니다: "${ko}". 그 줄을 고쳐 주세요.`);
    return { workspace: ws.id, term: toTerm(row) };
  });
}

/**
 * 내 공간의 줄을 고친다. 준 칸만 바뀐다(null 은 그 칸을 비운다). 한국어 낱말은 고치지 못한다.
 * 없는 번호나 다른 공간의 줄이면 NOT_FOUND, 공용 줄이면 READ_ONLY_WORKSPACE, 고친 뒤 승인인데 표기가 비면 BAD_INPUT.
 */
export async function patchGlossaryTerm(workspaceId: string, termId: number, body: GlossaryPatchRequest, now: Date): Promise<GlossaryWriteResponse> {
  return withTx((client) => patchGlossaryTermIn(client, workspaceId, termId, body, now));
}

/** patchGlossaryTerm 의 몸. 부르는 쪽의 트랜잭션 안에서 돈다. */
export async function patchGlossaryTermIn(client: Db, workspaceId: string, termId: number, body: GlossaryPatchRequest, now: Date): Promise<GlossaryWriteResponse> {
  const en = clean(body.en, '영어 표기');
  const zh = clean(body['zh-Hans'], '중국어(간체) 표기');
  const note = clean(body.note, '메모', true);

  const found = await client.query<TermRow>(`SELECT ${COLUMNS} FROM glossary_terms WHERE id = $1 FOR UPDATE`, [termId]);
  const row = found.rows[0];
  if (!row) throw new AppError('NOT_FOUND', '용어가 없습니다.');
  if (row.workspace_id === PUBLIC_WORKSPACE_ID) throw new AppError('READ_ONLY_WORKSPACE', '공용 용어는 고칠 수 없습니다. 같은 낱말을 내 작업 공간에 더하면 내 표기가 쓰입니다.');
  if (row.workspace_id !== workspaceId) throw new AppError('NOT_FOUND', '용어가 없습니다.');
  await touchWorkspaceForWrite(client, workspaceId, now);

  const next = {
    en: en === undefined ? row.en : en,
    zh: zh === undefined ? row.zh_hans : zh,
    note: note === undefined ? row.note : note,
    status: body.status ?? row.status,
  };
  if (next.status === 'approved' && (!next.en || !next.zh)) throw needsBoth();
  const { rows } = await client.query<TermRow>(
    `UPDATE glossary_terms SET en = $2, zh_hans = $3, note = $4, status = $5, updated_at = $6 WHERE id = $1 RETURNING ${COLUMNS}`,
    [termId, next.en, next.zh, next.note, next.status, now],
  );
  return { workspace: workspaceId, term: toTerm(rows[0] as TermRow) };
}
