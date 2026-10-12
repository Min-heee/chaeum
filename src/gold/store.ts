// 정답 세트의 DB 일: 싣기, 읽기, 확인 줄, 확인 기록, 내보낼 것 고르기. SQL 은 직접 쓴다.
import { FIELDS_BY_TYPE, isSubtypeOf, parseFieldValue, type FieldKey } from '@/contract/fields';
import {
  GoldDocSchema,
  type GoldAuthor,
  type GoldDoc,
  type GoldSplit,
  type GoldTrap,
  type GoldTruth,
  type ReviewVerdict,
} from '@/contract/eval-types';
import { canon, docToLine } from './files';
import { makeRng } from './rng';

/** 풀과 트랜잭션 연결 둘 다 받는다. */
export interface Db {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export class GoldError extends Error {
  constructor(
    public code: 'NOT_FOUND' | 'INVALID' | 'CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

interface DocRow {
  id: string;
  split: GoldSplit;
  gold_version: number;
  content: string;
  truth: GoldTruth;
  author: GoldAuthor;
  traps: GoldTrap[];
}

const DOC_COLUMNS = 'id, split, gold_version, content, truth, author, traps';

const rowToDoc = (r: DocRow): GoldDoc => ({
  id: r.id,
  split: r.split,
  goldVersion: r.gold_version,
  content: r.content,
  truth: r.truth,
  author: r.author,
  traps: r.traps,
});

// ── 싣기와 읽기 ────────────────────────────────────────────

export interface LoadResult {
  inserted: number;
  updated: number;
  skipped: number;
}

/**
 * 정답 문서를 DB 에 싣는다.
 * 이미 있는 문서는 파일의 버전이 더 높을 때만 덮어쓴다. 사람이 고친 정답을 옛 파일로 되돌리지 않기 위해서다.
 */
export async function loadDocs(db: Db, docs: readonly GoldDoc[], opts: { force?: boolean } = {}): Promise<LoadResult> {
  const result: LoadResult = { inserted: 0, updated: 0, skipped: 0 };
  for (const doc of docs) {
    const params = [doc.id, doc.split, doc.goldVersion, doc.content, JSON.stringify(doc.truth), doc.author, doc.traps];
    const found = await db.query('SELECT gold_version FROM gold_docs WHERE id = $1', [doc.id]);
    const existing = found.rows[0] as { gold_version: number } | undefined;
    if (!existing) {
      await db.query(
        `INSERT INTO gold_docs (id, split, gold_version, content, truth, author, traps)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::text[])`,
        params,
      );
      result.inserted += 1;
    } else if (opts.force || doc.goldVersion > existing.gold_version) {
      await db.query(
        `UPDATE gold_docs SET split = $2, gold_version = $3, content = $4, truth = $5::jsonb, author = $6, traps = $7::text[]
          WHERE id = $1`,
        params,
      );
      result.updated += 1;
    } else {
      result.skipped += 1;
    }
  }
  return result;
}

export async function listDocs(db: Db, split?: GoldSplit): Promise<GoldDoc[]> {
  const { rows } = split
    ? await db.query(`SELECT ${DOC_COLUMNS} FROM gold_docs WHERE split = $1 ORDER BY id`, [split])
    : await db.query(`SELECT ${DOC_COLUMNS} FROM gold_docs ORDER BY id`);
  return (rows as DocRow[]).map(rowToDoc);
}

export async function getDoc(db: Db, id: string): Promise<GoldDoc | null> {
  const { rows } = await db.query(`SELECT ${DOC_COLUMNS} FROM gold_docs WHERE id = $1`, [id]);
  return rows[0] ? rowToDoc(rows[0] as DocRow) : null;
}

// ── 확인 줄 ────────────────────────────────────────────────

export interface Queue {
  docs: GoldDoc[];
  /** 이 줄의 전체 건수와 끝낸 건수 */
  total: number;
  done: number;
}

/**
 * 첫 확인: 아직 한 번도 안 본 문서를 번호순으로 limit 건.
 * only 를 주면 그 번호들(이번에 확인하기로 고른 문서) 안에서만 고르고 센다.
 */
export async function firstPassQueue(db: Db, split: GoldSplit, limit: number, only?: readonly string[]): Promise<Queue> {
  const within = only ? 'AND d.id = ANY($3::text[])' : '';
  const { rows } = await db.query(
    `SELECT ${DOC_COLUMNS} FROM gold_docs d
      WHERE d.split = $1 AND NOT EXISTS (SELECT 1 FROM gold_reviews r WHERE r.gold_doc_id = d.id AND r.pass = 1) ${within}
      ORDER BY d.id LIMIT $2`,
    only ? [split, limit, only] : [split, limit],
  );
  const count = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM gold_reviews r WHERE r.gold_doc_id = d.id AND r.pass = 1))::int AS done
       FROM gold_docs d WHERE d.split = $1 ${only ? 'AND d.id = ANY($2::text[])' : ''}`,
    only ? [split, only] : [split],
  );
  const c = count.rows[0] as { total: number; done: number };
  return { docs: (rows as DocRow[]).map(rowToDoc), total: c.total, done: c.done };
}

/**
 * 다시 보기: 첫 확인에서 버리지 않은 문서 가운데 씨앗으로 count 건을 고른다.
 * 씨앗이 같으면 같은 문서가 나온다. 이미 다시 본 것은 줄에서 빠진다.
 */
export async function recheckQueue(db: Db, seed: number, count: number): Promise<Queue> {
  const eligible = await db.query(
    `SELECT gold_doc_id FROM (
       SELECT DISTINCT ON (gold_doc_id) gold_doc_id, verdict FROM gold_reviews WHERE pass = 1 ORDER BY gold_doc_id, id DESC
     ) latest WHERE verdict <> 'dropped' ORDER BY gold_doc_id`,
  );
  const ids = (eligible.rows as { gold_doc_id: string }[]).map((r) => r.gold_doc_id);
  const picks = makeRng(seed).shuffle(ids).slice(0, count);
  if (picks.length === 0) return { docs: [], total: 0, done: 0 };

  const seen = await db.query('SELECT DISTINCT gold_doc_id FROM gold_reviews WHERE pass = 2 AND gold_doc_id = ANY($1::text[])', [picks]);
  const done = new Set((seen.rows as { gold_doc_id: string }[]).map((r) => r.gold_doc_id));
  const left = picks.filter((id) => !done.has(id));
  const { rows } = await db.query(`SELECT ${DOC_COLUMNS} FROM gold_docs WHERE id = ANY($1::text[])`, [left]);
  const byId = new Map((rows as DocRow[]).map((r) => [r.id, rowToDoc(r)]));
  return { docs: left.map((id) => byId.get(id)).filter((d): d is GoldDoc => d !== undefined), total: picks.length, done: done.size };
}

// ── 확인 기록 ──────────────────────────────────────────────

export interface ReviewInput {
  docId: string;
  pass: 1 | 2;
  /** 이 건 버림 */
  drop?: boolean;
  /** 고친 칸: 칸 이름 → 새 값(없음은 null) */
  fixes?: Record<string, unknown>;
  /** 갈래를 고쳤으면 새 갈래 */
  subtype?: string | null;
  /** 이 건을 보는 데 걸린 초 */
  seconds?: number | null;
}

export interface ReviewOutcome {
  verdict: ReviewVerdict;
  fixedFields: number;
  /** 방금 적은 확인 기록의 번호. 되돌리기가 이 번호를 다시 보낸다. */
  reviewId: string;
  /** 정답을 고쳤으면 고치기 전 정답. 되돌리기가 이것을 다시 보낸다. 고치지 않았으면 null. */
  before: GoldTruth | null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));

/**
 * 확인 한 건을 적는다. 고친 칸이 있으면 정답도 함께 바꾼다.
 * 트랜잭션 안에서 부른다(정답 고침과 기록이 함께 들어가야 한다).
 */
export async function recordReview(db: Db, input: ReviewInput): Promise<ReviewOutcome> {
  const { rows } = await db.query(`SELECT ${DOC_COLUMNS} FROM gold_docs WHERE id = $1 FOR UPDATE`, [input.docId]);
  if (!rows[0]) throw new GoldError('NOT_FOUND', `없는 정답 문서: ${input.docId}`);
  const doc = rowToDoc(rows[0] as DocRow);
  const seconds = typeof input.seconds === 'number' && Number.isFinite(input.seconds) ? Math.max(0, Math.round(input.seconds)) : null;

  let verdict: ReviewVerdict = 'ok';
  let fixedFields = 0;
  let before: GoldTruth | null = null;

  if (input.drop) {
    verdict = 'dropped';
  } else {
    const { type } = doc.truth;
    const fields = { ...doc.truth.fields };
    for (const [key, raw] of Object.entries(input.fixes ?? {})) {
      if (!(FIELDS_BY_TYPE[type] as readonly string[]).includes(key)) throw new GoldError('INVALID', `그 종류에 없는 칸: ${key}`);
      const field = key as FieldKey;
      const parsed = parseFieldValue(field, raw);
      if (!parsed.ok) throw new GoldError('INVALID', `값의 꼴이 다르다: ${key}`);
      // 빈 목록과 빈 글은 "없음"으로 적는다.
      const empty = (Array.isArray(parsed.value) && parsed.value.length === 0) || (typeof parsed.value === 'string' && parsed.value.trim() === '');
      const value = empty ? null : typeof parsed.value === 'string' ? parsed.value.trim() : parsed.value;
      if (!same(fields[field], value)) {
        fields[field] = value;
        fixedFields += 1;
      }
    }
    let subtype = doc.truth.subtype;
    if (input.subtype !== undefined && input.subtype !== subtype) {
      if (!isSubtypeOf(type, input.subtype)) throw new GoldError('INVALID', '갈래가 그 종류의 목록에 없다');
      subtype = input.subtype;
      fixedFields += 1;
    }
    if (fixedFields > 0) {
      const truth: GoldTruth = { type, subtype, fields };
      if (!GoldDocSchema.safeParse({ ...doc, truth }).success) throw new GoldError('INVALID', '고친 정답의 꼴이 약속과 다르다');
      await db.query('UPDATE gold_docs SET truth = $2::jsonb WHERE id = $1', [doc.id, JSON.stringify(truth)]);
      verdict = 'fixed';
      before = doc.truth;
    }
  }

  const made = await db.query(
    'INSERT INTO gold_reviews (gold_doc_id, pass, verdict, fixed_fields, seconds) VALUES ($1, $2, $3, $4, $5) RETURNING id::text AS id',
    [doc.id, input.pass, verdict, fixedFields, seconds],
  );
  return { verdict, fixedFields, reviewId: (made.rows[0] as { id: string }).id, before };
}

// ── 방금 판정 되돌리기 ─────────────────────────────────────

export interface UndoInput {
  docId: string;
  /** 되돌릴 확인 기록의 번호(판정을 적을 때 받은 것) */
  reviewId: string;
  /** 그 판정이 정답을 고쳤다면, 그때 받은 고치기 전 정답 */
  before?: unknown;
}

export interface UndoOutcome {
  /** 지운 기록의 판정 */
  verdict: ReviewVerdict;
  /** 정답을 고치기 전 값으로 돌렸는가 */
  restored: boolean;
}

/**
 * 잘못 누른 판정 하나를 되돌린다. 그 문서의 가장 최근 확인 기록이 방금 그 판정(reviewId)일 때만 지운다.
 * 그 판정이 정답을 고친 것이었으면 정답도 고치기 전 값(before)으로 돌린다. 지우고 나면 그 문서는 "아직"으로 돌아간다.
 * 트랜잭션 안에서 부른다(정답 되돌림과 기록 지움이 함께 들어가야 한다).
 */
export async function undoReview(db: Db, input: UndoInput): Promise<UndoOutcome> {
  const { rows } = await db.query(`SELECT ${DOC_COLUMNS} FROM gold_docs WHERE id = $1 FOR UPDATE`, [input.docId]);
  if (!rows[0]) throw new GoldError('NOT_FOUND', `없는 정답 문서: ${input.docId}`);
  const doc = rowToDoc(rows[0] as DocRow);

  // 번호는 수로 줄 세운다(글자로 줄 세우면 "9"가 "10"보다 뒤에 온다). 그래서 글자로 바꾼 것에는 다른 이름을 붙인다.
  const latest = await db.query('SELECT r.id::text AS review_id, r.verdict FROM gold_reviews r WHERE r.gold_doc_id = $1 ORDER BY r.id DESC LIMIT 1', [doc.id]);
  const last = latest.rows[0] as { review_id: string; verdict: ReviewVerdict } | undefined;
  if (!last || last.review_id !== input.reviewId) {
    throw new GoldError('CONFLICT', '그 문서의 가장 최근 확인 기록이 방금 그 판정이 아니다. 되돌리지 않았다.');
  }

  let restored = false;
  if (last.verdict === 'fixed') {
    const before = input.before as GoldTruth | undefined;
    const ok = before !== null && typeof before === 'object' && before.type === doc.truth.type && GoldDocSchema.safeParse({ ...doc, truth: before }).success;
    if (!ok) throw new GoldError('INVALID', '고치기 전 정답이 없거나 꼴이 약속과 다르다. 되돌리지 않았다.');
    const truth: GoldTruth = { type: before.type, subtype: before.subtype, fields: before.fields };
    await db.query('UPDATE gold_docs SET truth = $2::jsonb WHERE id = $1', [doc.id, JSON.stringify(truth)]);
    restored = true;
  }
  await db.query('DELETE FROM gold_reviews WHERE id = $1::bigint', [last.review_id]);
  return { verdict: last.verdict, restored };
}

/** 지금까지 건마다 걸린 초(그 차례의 확인만, 적힌 순서대로). 남은 시간을 어림할 때 쓴다. */
export async function reviewSeconds(db: Db, pass: 1 | 2): Promise<number[]> {
  const { rows } = await db.query('SELECT seconds FROM gold_reviews WHERE pass = $1 AND seconds IS NOT NULL ORDER BY id', [pass]);
  return (rows as { seconds: number }[]).map((r) => r.seconds);
}

// ── 진행 상황 ──────────────────────────────────────────────

export interface SplitSummary {
  split: GoldSplit;
  total: number;
  /** 첫 확인을 끝낸 문서(가장 최근 판정 기준) */
  reviewed: number;
  ok: number;
  fixed: number;
  dropped: number;
  fixedFields: number;
  /** 첫 확인에 쓴 초의 합 */
  seconds: number;
}

export interface Summary {
  splits: SplitSummary[];
  /** 다시 보기: 본 건수와, 고치지도 버리지도 않은 건수 */
  recheck: { reviewed: number; same: number; fixed: number; dropped: number };
}

/**
 * 문서마다 첫 확인(pass = 1) 줄을 하나로 모은다. 같은 문서를 다시 열어 확인하면 줄이 여러 개다.
 * - 판정: 마지막 줄이 버림이면 버림. 아니고 한 번이라도 고쳤으면 고침. 그 밖에는 맞음.
 *   (고친 뒤 다시 열어 그대로 확인했다고 "맞음, 고친 칸 0"이 되면 고친 일이 사라진다.)
 * - 고친 칸 수: 한 번에 가장 많이 고친 수. 고쳤다 되돌린 칸을 두 번 세지 않으려고 더하지 않는다.
 * - 걸린 초: 모두 더한다.
 */
export const FIRST_PASS_PER_DOC = `
  SELECT gold_doc_id,
         CASE WHEN (array_agg(verdict ORDER BY id DESC))[1] = 'dropped' THEN 'dropped'
              WHEN bool_or(verdict = 'fixed') THEN 'fixed'
              ELSE 'ok' END AS verdict,
         max(fixed_fields)::int AS fixed_fields,
         sum(seconds)::int AS seconds
    FROM gold_reviews WHERE pass = 1 GROUP BY gold_doc_id`;

export async function summarize(db: Db): Promise<Summary> {
  const first = await db.query(
    `SELECT d.split,
            count(*)::int AS total,
            count(l.verdict)::int AS reviewed,
            count(*) FILTER (WHERE l.verdict = 'ok')::int AS ok,
            count(*) FILTER (WHERE l.verdict = 'fixed')::int AS fixed,
            count(*) FILTER (WHERE l.verdict = 'dropped')::int AS dropped,
            coalesce(sum(l.fixed_fields), 0)::int AS fixed_fields,
            coalesce(sum(l.seconds), 0)::int AS seconds
       FROM gold_docs d
       LEFT JOIN (${FIRST_PASS_PER_DOC}) l ON l.gold_doc_id = d.id
      GROUP BY d.split ORDER BY d.split`,
  );
  const second = await db.query(
    `SELECT count(*)::int AS reviewed,
            count(*) FILTER (WHERE verdict = 'ok')::int AS same,
            count(*) FILTER (WHERE verdict = 'fixed')::int AS fixed,
            count(*) FILTER (WHERE verdict = 'dropped')::int AS dropped
       FROM (SELECT DISTINCT ON (gold_doc_id) verdict FROM gold_reviews WHERE pass = 2 ORDER BY gold_doc_id, id DESC) l`,
  );
  return {
    splits: (first.rows as (Omit<SplitSummary, 'fixedFields'> & { fixed_fields: number })[]).map((r) => ({
      split: r.split,
      total: r.total,
      reviewed: r.reviewed,
      ok: r.ok,
      fixed: r.fixed,
      dropped: r.dropped,
      fixedFields: r.fixed_fields,
      seconds: r.seconds,
    })),
    recheck: second.rows[0] as Summary['recheck'],
  };
}

// ── 내보내기 ───────────────────────────────────────────────

export interface ExportPlan {
  docs: GoldDoc[];
  version: number;
  /** 파일과 달라진 문서 번호 */
  changed: string[];
}

const lineWithoutVersion = (doc: GoldDoc) => docToLine({ ...doc, goldVersion: 1, style: undefined });

/**
 * DB 의 정답을 파일로 되돌려 쓸 내용을 정한다.
 * 파일과 달라진 문서가 하나라도 있으면 그 묶음 전체의 정답 버전을 하나 올린다.
 * 꼴(style)은 DB 에 없으므로 파일의 것을 그대로 잇는다.
 */
export function planExport(fileDocs: readonly GoldDoc[] | null, dbDocs: readonly GoldDoc[]): ExportPlan {
  const fileById = new Map((fileDocs ?? []).map((d) => [d.id, d]));
  const changed = dbDocs.filter((d) => {
    const old = fileById.get(d.id);
    return !old || lineWithoutVersion(old) !== lineWithoutVersion(d);
  }).map((d) => d.id);
  const dbIds = new Set(dbDocs.map((d) => d.id));
  for (const old of fileDocs ?? []) if (!dbIds.has(old.id)) changed.push(old.id);

  const top = Math.max(0, ...(fileDocs ?? []).map((d) => d.goldVersion), ...dbDocs.map((d) => d.goldVersion));
  const version = fileDocs === null ? Math.max(1, top) : changed.length > 0 ? top + 1 : Math.max(1, top);
  return {
    docs: dbDocs.map((d) => ({ ...d, goldVersion: version, ...(fileById.get(d.id)?.style ? { style: fileById.get(d.id)?.style } : {}) })),
    version,
    changed,
  };
}

export async function setSplitVersion(db: Db, split: GoldSplit, version: number): Promise<void> {
  await db.query('UPDATE gold_docs SET gold_version = $2 WHERE split = $1', [split, version]);
}

// ── 확인 기록을 파일로 ─────────────────────────────────────

export interface ReviewRow {
  goldDocId: string;
  pass: 1 | 2;
  verdict: ReviewVerdict;
  fixedFields: number;
  seconds: number | null;
  reviewedAt: string;
}

export async function listReviews(db: Db): Promise<ReviewRow[]> {
  const { rows } = await db.query('SELECT gold_doc_id, pass, verdict, fixed_fields, seconds, reviewed_at FROM gold_reviews ORDER BY id');
  return (rows as { gold_doc_id: string; pass: 1 | 2; verdict: ReviewVerdict; fixed_fields: number; seconds: number | null; reviewed_at: Date }[]).map((r) => ({
    goldDocId: r.gold_doc_id,
    pass: r.pass,
    verdict: r.verdict,
    fixedFields: r.fixed_fields,
    seconds: r.seconds,
    reviewedAt: r.reviewed_at.toISOString(),
  }));
}

/** 파일의 확인 기록을 싣는다. 확인 기록이 하나도 없는 문서에만 넣는다(두 번 실어도 늘지 않는다). */
export async function loadReviews(db: Db, reviews: readonly ReviewRow[]): Promise<number> {
  const has = await db.query('SELECT DISTINCT gold_doc_id FROM gold_reviews');
  const skip = new Set((has.rows as { gold_doc_id: string }[]).map((r) => r.gold_doc_id));
  const docs = await db.query('SELECT id FROM gold_docs');
  const known = new Set((docs.rows as { id: string }[]).map((r) => r.id));
  let inserted = 0;
  for (const r of reviews) {
    if (skip.has(r.goldDocId) || !known.has(r.goldDocId)) continue;
    await db.query(
      'INSERT INTO gold_reviews (gold_doc_id, pass, verdict, fixed_fields, seconds, reviewed_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [r.goldDocId, r.pass, r.verdict, r.fixedFields, r.seconds, r.reviewedAt],
    );
    inserted += 1;
  }
  return inserted;
}
