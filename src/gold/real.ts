// 실제 자료 묶음(real)을 만드는 길: 붙여 넣은 글 → 얼린 파이프라인의 초안 → 사람이 칸마다 확정 → 정답 문서.
// 서버에서만 돈다. 화면은 로컬 전용이다(LABEL_ENABLED=1).
//
// 원문은 남이 쓴 글이다. 저장소 밖의 파일(realGoldFile)과 DB 에만 둔다. 저장소에는 출처 목록과 "사람이 무엇을 바꿨는가"의 셈만 남긴다.
// 얼린 것(프롬프트, 맞추기·따지기)은 부르기만 한다. 평가기가 문서를 돌리는 것과 같은 순서다(eval/runner.ts 의 methodOutputs 의 llm_code).
import { LIMITS } from '@/contract/api';
import { GoldDocSchema, SPLIT_SIZES, type GoldDoc, type GoldTruth } from '@/contract/eval-types';
import { DOC_TYPES, FIELDS_BY_TYPE, isSubtypeOf, parseFieldValue, type DocType, type Extraction, type FieldKey } from '@/contract/fields';
import { DEFAULT_LLM_MODEL, isLlmUnavailable, type LlmCallRecord, type LlmCallStore, type LlmProvider, type LlmRequest } from '@/contract/llm-types';
import { evaluateDraft } from '@/core';
import { buildExtractRequest, cacheKeyFor, costUsd, createProvider } from '@/llm';
import { charCount, cleanText } from '@/server/limits';
import { readJsonlFile, writeJsonlFile } from './files';
import {
  REAL_SOURCE_KINDS,
  changedCount,
  docOrigin,
  draftFromEvaluation,
  isDate,
  isSourceUrl,
  makeGoldDoc,
  nextDocId,
  tallyOrigins,
  type DocOrigin,
  type ModelDraft,
  type OriginTally,
  type RealSourceEntry,
  type RealSourceKind,
} from './origins';
import { GoldError, listDocs, loadDocs, type Db } from './store';

/** 이 묶음에서 모으기로 한 건수 */
export const REAL_TARGET = SPLIT_SIZES.real;

/**
 * 초안을 채우는 실제 호출의 전체 상한. 앱의 하루 상한(LIVE_LLM_DAILY_CAP)과 따로 센다. LABEL_REAL_CALL_CAP 로 바꾼다.
 * 세는 것: 답을 받아 초안이 된 호출(넣은 글의 표에 남는다) + 이 서버가 뜬 뒤 답을 못 받은 호출(메모리에만 있다. 서버를 다시 띄우면 0).
 * 그러니 서버를 다시 띄운 사이의 실패한 호출은 세지 못한다. 돈이 나가는 것을 막는 마지막 줄은 콘솔의 지출 한도다.
 */
export const REAL_CALL_CAP_DEFAULT = 60;
export function realCallCap(env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env.LABEL_REAL_CALL_CAP?.trim() || NaN);
  return Number.isInteger(set) && set >= 0 ? Math.min(set, 1000) : REAL_CALL_CAP_DEFAULT;
}

/** 표가 아직 없다(이행 0006 을 돌리기 전). 화면과 API 가 이것을 잡아 안내한다. */
export const isMissingTable = (err: unknown) => (err as { code?: string } | null)?.code === '42P01';
export const MISSING_TABLE_NOTE = '넣은 글의 표가 아직 없다. 저장소에서 npm run db:migrate 를 한 번 돌린 뒤 다시 연다.';

// ── 초안 채우기 ────────────────────────────────────────────

export interface DraftDeps {
  /** 호출 장부. 같은 글의 답이 있으면 다시 부르지 않는다. */
  store: LlmCallStore;
  /** 실제로 부르는 공급자. 없으면 장부에 있는 답만 쓴다. */
  live: LlmProvider | null;
  /** 실제 호출을 더 해도 되는가(상한). 장부에 답이 없을 때만 묻는다. */
  mayCall: () => Promise<boolean>;
  /** 실제로 불렀는데 답을 못 받았을 때 알린다(상한에 세려고). */
  onFailedCall?: () => void;
  model?: string;
}

export interface FrozenDraft {
  draft: ModelDraft;
  /** 실제로 모델을 불렀는가 */
  called: boolean;
  costUsd: number;
  model: string;
  promptVersion: string;
}

/**
 * 얼린 파이프라인으로 초안을 낸다: 글 정리 → 뽑기(지금 쓰는 프롬프트 판, 가장 작은 모델) → 맞추기·따지기.
 * 답을 못 받으면 GoldError 를 던진다. "규칙만" 길로 내려가지 않는다(이 묶음의 초안은 모델 + 코드의 답이어야 한다).
 */
export async function frozenDraft(cleanContent: string, deps: DraftDeps): Promise<FrozenDraft> {
  const model = deps.model ?? DEFAULT_LLM_MODEL;
  const req = buildExtractRequest(cleanContent);
  const hit = await deps.store.find(cacheKeyFor(req as LlmRequest<unknown>, model));
  const inLedger = hit !== null && hit.provider !== 'fake';

  let provider: LlmProvider;
  if (inLedger) provider = createProvider({ kind: 'replay', model, store: deps.store });
  else if (!deps.live) throw new GoldError('INVALID', 'ANTHROPIC_API_KEY 가 없어 초안을 채울 수 없다. .env.local 에 키를 넣고 서버를 다시 띄운다.');
  else if (!(await deps.mayCall())) throw new GoldError('CONFLICT', '초안을 채우는 실제 호출이 상한에 닿았다(LABEL_REAL_CALL_CAP).');
  else provider = deps.live;

  let extraction: Extraction;
  let cost = 0;
  let called = false;
  try {
    const result = await provider.complete(req);
    extraction = result.output;
    called = !result.recorded;
    cost = called ? costUsd(model, result.usage) : 0;
  } catch (err) {
    // 장부의 답을 읽다 난 일이 아니면 실제로 부른 것이다. 키가 없어 부르지도 못한 것(NO_KEY)은 세지 않는다.
    if (!inLedger && !(isLlmUnavailable(err) && err.code === 'NO_KEY')) deps.onFailedCall?.();
    if (!isLlmUnavailable(err)) throw err;
    throw new GoldError('INVALID', `모델의 답을 못 받았다(${err.code}). 잠시 뒤 다시 누른다.`);
  }
  const evaluation = evaluateDraft({ sourceText: cleanContent, extraction, extractedBy: 'llm' });
  return { draft: draftFromEvaluation(evaluation), called, costUsd: cost, model, promptVersion: req.promptVersion };
}

// ── 넣은 글(intake) ────────────────────────────────────────

export interface IntakeInput {
  content: string;
  sourceUrl: string;
  fetchedOn: string;
  kind: RealSourceKind;
}

export type IntakeStatus = 'open' | 'saved' | 'skipped';

export interface Intake {
  id: string;
  content: string;
  sourceUrl: string;
  fetchedOn: string;
  kind: RealSourceKind;
  model: ModelDraft;
  modelName: string;
  promptVersion: string;
  called: boolean;
  costUsd: number;
  status: IntakeStatus;
  skipNote: string | null;
  goldDocId: string | null;
  createdAt: string;
}

interface IntakeRow {
  id: string;
  content: string;
  source_url: string;
  fetched_on: string;
  source_kind: RealSourceKind;
  model: ModelDraft;
  model_name: string;
  prompt_version: string;
  called: boolean;
  cost_usd: string;
  status: IntakeStatus;
  skip_note: string | null;
  gold_doc_id: string | null;
  created_at: Date;
}

const COLUMNS = `id::text AS id, content, source_url, to_char(fetched_on, 'YYYY-MM-DD') AS fetched_on, source_kind, model, model_name, prompt_version,
                 called, cost_usd::text AS cost_usd, status, skip_note, gold_doc_id, created_at`;

const toIntake = (r: IntakeRow): Intake => ({
  id: r.id,
  content: r.content,
  sourceUrl: r.source_url,
  fetchedOn: r.fetched_on,
  kind: r.source_kind,
  model: r.model,
  modelName: r.model_name,
  promptVersion: r.prompt_version,
  called: r.called,
  costUsd: Number(r.cost_usd),
  status: r.status,
  skipNote: r.skip_note,
  goldDocId: r.gold_doc_id,
  createdAt: r.created_at.toISOString(),
});

/** 넣을 글과 출처를 본다. 글은 앱의 접수와 같은 정리(공백, 전각 글자)를 거친 꼴로 돌려준다. 얼린 파이프라인이 읽는 것이 그 꼴이다. */
export function checkIntakeInput(raw: Record<string, unknown>): IntakeInput {
  if (typeof raw.content !== 'string') throw new GoldError('INVALID', '글이 없다');
  const content = cleanText(raw.content);
  if (content === '') throw new GoldError('INVALID', '글이 비었다');
  if (charCount(content) > LIMITS.textMaxChars) {
    throw new GoldError('INVALID', `글은 ${LIMITS.textMaxChars.toLocaleString('ko-KR')}자까지다(앱의 접수 상한과 같다). 상품 한 건에 해당하는 부분만 붙여 넣는다. 지금 ${charCount(content).toLocaleString('ko-KR')}자.`);
  }
  if (typeof raw.sourceUrl !== 'string' || !isSourceUrl(raw.sourceUrl)) throw new GoldError('INVALID', '출처 주소는 http(s) 로 시작하는 주소여야 한다');
  if (typeof raw.fetchedOn !== 'string' || !isDate(raw.fetchedOn)) throw new GoldError('INVALID', '받은 날짜는 YYYY-MM-DD 꼴이어야 한다');
  if (typeof raw.kind !== 'string' || !(REAL_SOURCE_KINDS as readonly string[]).includes(raw.kind)) throw new GoldError('INVALID', '원문의 꼴을 골라야 한다');
  return { content, sourceUrl: raw.sourceUrl.trim(), fetchedOn: raw.fetchedOn, kind: raw.kind as RealSourceKind };
}

/** 이 서버가 뜬 뒤 실제로 불렀지만 답을 못 받은 횟수(시간 초과, 답의 꼴이 틀림 등). 줄이 남지 않아 메모리에만 센다. */
let failedCalls = 0;
export const failedRealCalls = () => failedCalls;
export const resetFailedRealCalls = () => {
  failedCalls = 0;
};

/** 지금까지 초안을 채우느라 실제로 불러 답을 받은 횟수(초안이 된 호출) */
export async function countRealCalls(db: Db): Promise<number> {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM gold_real_intake WHERE called');
  return (rows[0] as { n: number }).n;
}

/** 풀. 초안을 채우는 동안 잠금을 쥘 연결 하나를 빌린다. */
export interface DbPool extends Db {
  connect(): Promise<Db & { release(): void }>;
}

/**
 * 초안 채우기를 한 번에 하나만 돌린다(세션 단위 잠금). 같은 글을 동시에 두 번 보내도 한 번만 부르고, 상한을 넘겨 부르지 않는다.
 * 기다리지 않는다: 다른 초안을 채우는 중이면 바로 CONFLICT 를 던진다(기다리면 연결을 쥔 채 서 있게 된다).
 */
export async function createIntakeLocked(pool: DbPool, input: IntakeInput, deps: Omit<DraftDeps, 'mayCall' | 'onFailedCall'> & { cap: number }): Promise<{ intake: Intake; resumed: boolean }> {
  const client = await pool.connect();
  try {
    const got = await client.query("SELECT pg_try_advisory_lock(hashtext('chaeum_gold_real_draft')) AS ok");
    if (!(got.rows[0] as { ok: boolean }).ok) throw new GoldError('CONFLICT', '다른 초안을 채우는 중이다. 끝난 뒤에 다시 누른다.');
    try {
      return await createIntake(client, input, deps);
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('chaeum_gold_real_draft'))");
    }
  } finally {
    client.release();
  }
}

export async function getIntake(db: Db, id: string): Promise<Intake | null> {
  if (!/^\d+$/.test(id)) return null;
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM gold_real_intake WHERE id = $1::bigint`, [id]);
  return rows[0] ? toIntake(rows[0] as IntakeRow) : null;
}

export async function listIntakes(db: Db): Promise<Intake[]> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM gold_real_intake ORDER BY id`);
  return (rows as IntakeRow[]).map(toIntake);
}

/**
 * 글 한 건을 넣고 초안을 채운다.
 * 같은 글이 이미 있으면 새로 부르지 않는다: 아직 확정하지 않은 것이면 그것을 돌려주고(이어서 본다), 이미 끝난 것이면 막는다.
 * 모델을 부르는 동안에는 트랜잭션을 잡지 않는다. 겹쳐 부르는 것은 createIntakeLocked 가 막는다(화면의 API 는 그쪽을 쓴다).
 */
export async function createIntake(db: Db, input: IntakeInput, deps: Omit<DraftDeps, 'mayCall' | 'onFailedCall'> & { cap: number }): Promise<{ intake: Intake; resumed: boolean }> {
  const same = await db.query(`SELECT ${COLUMNS} FROM gold_real_intake WHERE content = $1 ORDER BY id DESC LIMIT 1`, [input.content]);
  if (same.rows[0]) {
    const old = toIntake(same.rows[0] as IntakeRow);
    if (old.status === 'open') return { intake: old, resumed: true };
    throw new GoldError('CONFLICT', old.status === 'saved' ? `이미 넣은 글이다(${old.goldDocId}).` : '이미 넣었다가 넘긴 글이다.');
  }
  const made = await frozenDraft(input.content, {
    ...deps,
    mayCall: async () => (await countRealCalls(db)) + failedCalls < deps.cap,
    onFailedCall: () => {
      failedCalls += 1;
    },
  });
  const { rows } = await db.query(
    `INSERT INTO gold_real_intake (content, source_url, fetched_on, source_kind, model, model_name, prompt_version, called, cost_usd)
     VALUES ($1, $2, $3::date, $4, $5::jsonb, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
    [input.content, input.sourceUrl, input.fetchedOn, input.kind, JSON.stringify(made.draft), made.model, made.promptVersion, made.called, made.costUsd],
  );
  return { intake: toIntake(rows[0] as IntakeRow), resumed: false };
}

// ── 확정 ───────────────────────────────────────────────────

export interface ConfirmInput {
  intakeId: string;
  type: string;
  subtype: string | null;
  /** 확정한 종류의 칸 전부: 칸 이름 → 표준 값(없음은 null). 빠진 칸은 없음으로 친다. */
  fields: Record<string, unknown>;
  seconds?: number | null;
}

export interface ConfirmOutcome {
  docId: string;
  reviewId: string;
  verdict: 'ok' | 'fixed';
  /** 사람이 바꾼 것의 수: 바꾼 칸 + 종류나 갈래를 바꿨으면 1(origins.ts 의 changedCount) */
  changed: number;
  origin: DocOrigin;
}

/** 사람이 보낸 종류·갈래·칸 값을 정답 꼴로 만든다. 꼴이 다르면 GoldError. 실제 자료와 손글이 함께 쓴다. */
export function buildTruth(type: string, subtype: string | null, raw: Record<string, unknown>): GoldTruth {
  if (!(DOC_TYPES as readonly string[]).includes(type)) throw new GoldError('INVALID', '종류를 골라야 한다');
  const docType = type as DocType;
  const sub = docType === 'not_product' ? null : subtype;
  if (!isSubtypeOf(docType, sub)) throw new GoldError('INVALID', '갈래가 그 종류의 목록에 없다');
  const allowed = FIELDS_BY_TYPE[docType] as readonly string[];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new GoldError('INVALID', `그 종류에 없는 칸: ${key}`);
  const fields: GoldTruth['fields'] = {};
  for (const key of FIELDS_BY_TYPE[docType]) {
    const parsed = parseFieldValue(key as FieldKey, raw[key]);
    if (!parsed.ok) throw new GoldError('INVALID', `값의 꼴이 다르다: ${key}`);
    const v = parsed.value;
    const empty = v === null || (Array.isArray(v) && v.length === 0) || (typeof v === 'string' && v.trim() === '');
    fields[key] = empty ? null : typeof v === 'string' ? v.trim() : v;
  }
  return { type: docType, subtype: sub, fields };
}

const secondsOf = (s: unknown) => (typeof s === 'number' && Number.isFinite(s) ? Math.max(0, Math.round(s)) : null);

/** 번호를 정하는 동안 다른 저장이 끼어들지 않게 한다. 트랜잭션이 끝나면 풀린다. */
const lockIds = (db: Db) => db.query("SELECT pg_advisory_xact_lock(hashtext('chaeum_gold_next_id'))");

async function idsOf(db: Db, split: 'real' | 'hand'): Promise<string[]> {
  const { rows } = await db.query('SELECT id FROM gold_docs WHERE split = $1', [split]);
  return (rows as { id: string }[]).map((r) => r.id);
}

/**
 * 초안을 사람이 확정한 값으로 정답 문서(split real)로 만든다. 확인 기록도 한 줄 적는다(바꾼 것이 있으면 fixed).
 * 트랜잭션 안에서 부른다. 파일 쓰기(writeRealFile)는 커밋한 뒤에 한다.
 */
export async function confirmIntake(db: Db, input: ConfirmInput): Promise<ConfirmOutcome> {
  if (!/^\d+$/.test(input.intakeId)) throw new GoldError('NOT_FOUND', '없는 초안');
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM gold_real_intake WHERE id = $1::bigint FOR UPDATE`, [input.intakeId]);
  if (!rows[0]) throw new GoldError('NOT_FOUND', '없는 초안');
  const intake = toIntake(rows[0] as IntakeRow);
  if (intake.status !== 'open') throw new GoldError('CONFLICT', '이미 끝난 건이다. 되돌린 뒤에 다시 확정한다.');

  const truth = buildTruth(input.type, input.subtype, input.fields);
  await lockIds(db);
  const doc = makeGoldDoc({ id: nextDocId('real', await idsOf(db, 'real')), split: 'real', content: intake.content, truth });
  if (!GoldDocSchema.safeParse(doc).success) throw new GoldError('INVALID', '정답의 꼴이 약속과 다르다');

  const origin = docOrigin(intake.model, doc.truth);
  const changed = changedCount(origin);
  const verdict = changed > 0 ? 'fixed' : 'ok';

  await loadDocs(db, [doc]);
  const review = await db.query(
    'INSERT INTO gold_reviews (gold_doc_id, pass, verdict, fixed_fields, seconds) VALUES ($1, 1, $2, $3, $4) RETURNING id::text AS id',
    [doc.id, verdict, changed, secondsOf(input.seconds)],
  );
  await db.query("UPDATE gold_real_intake SET status = 'saved', gold_doc_id = $2, skip_note = NULL WHERE id = $1::bigint", [intake.id, doc.id]);
  return { docId: doc.id, reviewId: (review.rows[0] as { id: string }).id, verdict, changed, origin };
}

/** 우리 양식에 없는 상품이라 넘긴다. 정답 문서를 만들지 않는다. 출처 목록에는 "넘김"으로 남는다. */
export async function skipIntake(db: Db, intakeId: string, note: string | null): Promise<void> {
  if (!/^\d+$/.test(intakeId)) throw new GoldError('NOT_FOUND', '없는 초안');
  const done = await db.query("UPDATE gold_real_intake SET status = 'skipped', skip_note = $2 WHERE id = $1::bigint AND status = 'open'", [
    intakeId,
    note?.trim().slice(0, 200) || '우리 양식에 없는 상품',
  ]);
  if (done.rowCount !== 1) throw new GoldError('CONFLICT', '없거나 이미 끝난 건이다');
}

/**
 * 방금 한 일을 되돌린다. 초안은 "아직"으로 돌아간다(모델을 다시 부르지 않는다).
 * - 확정을 되돌림: 그 정답 문서의 가장 최근 확인 기록이 방금 그 확정(reviewId)일 때만. 정답 문서와 확인 기록을 지운다.
 * - 넘김을 되돌림: reviewId 없이 부른다.
 * 지운 정답 문서의 번호를 돌려준다(없으면 null). 트랜잭션 안에서 부른다.
 */
export async function undoIntake(db: Db, intakeId: string, reviewId: string | null): Promise<{ removedDocId: string | null }> {
  if (!/^\d+$/.test(intakeId)) throw new GoldError('NOT_FOUND', '없는 초안');
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM gold_real_intake WHERE id = $1::bigint FOR UPDATE`, [intakeId]);
  if (!rows[0]) throw new GoldError('NOT_FOUND', '없는 초안');
  const intake = toIntake(rows[0] as IntakeRow);
  if (intake.status === 'open') throw new GoldError('CONFLICT', '되돌릴 것이 없다');

  let removedDocId: string | null = null;
  if (intake.status === 'saved') {
    const docId = intake.goldDocId as string;
    const latest = await db.query('SELECT id::text AS review_id FROM gold_reviews WHERE gold_doc_id = $1 ORDER BY id DESC LIMIT 1', [docId]);
    const last = latest.rows[0] as { review_id: string } | undefined;
    if (!reviewId || !last || last.review_id !== reviewId) throw new GoldError('CONFLICT', '그 문서의 가장 최근 확인 기록이 방금 그 확정이 아니다. 되돌리지 않았다.');
    await db.query('DELETE FROM gold_docs WHERE id = $1 AND split = $2', [docId, 'real']);
    removedDocId = docId;
  }
  await db.query("UPDATE gold_real_intake SET status = 'open', gold_doc_id = NULL, skip_note = NULL WHERE id = $1::bigint", [intakeId]);
  return { removedDocId };
}

// ── 저장소 밖의 파일 ───────────────────────────────────────

/**
 * 파일에만 있는 실제 자료 문서를 DB 에 싣는다(DB 를 새로 만든 뒤 화면을 바로 열었을 때).
 * 이것을 건너뛰고 파일을 다시 쓰면 파일에만 있던 문서가 사라진다.
 */
export async function ensureRealLoaded(db: Db, file: string, removed: readonly string[] = []): Promise<number> {
  const fileDocs = (await readJsonlFile(file)) ?? [];
  const have = new Set(await idsOf(db, 'real'));
  const missing = fileDocs.filter((d) => d.split === 'real' && !have.has(d.id) && !removed.includes(d.id));
  if (missing.length > 0) await loadDocs(db, missing);
  return missing.length;
}

/** DB 의 실제 자료 문서를 저장소 밖의 파일로 쓴다. removed 는 방금 되돌려 지운 문서(파일에서도 빠진다). */
export async function writeRealFile(db: Db, file: string, removed: readonly string[] = []): Promise<number> {
  await ensureRealLoaded(db, file, removed);
  const docs = await listDocs(db, 'real');
  await writeJsonlFile(file, docs);
  return docs.length;
}

// ── 진행과 셈 ──────────────────────────────────────────────

export interface RealProgress {
  target: number;
  saved: number;
  skipped: number;
  open: number;
  /** 초안을 채우느라 실제로 부른 횟수와 그 상한 */
  calls: number;
  cap: number;
  costUsd: number;
  tally: OriginTally;
}

interface PairRow {
  intake_id: string;
  gold_doc_id: string;
  model: ModelDraft;
  truth: GoldTruth;
}

/** 정답 문서가 된 건마다: 모델 초안과 지금의 정답. 정답을 나중에 다시 고쳤어도 지금 값으로 견준다. */
export async function listOrigins(db: Db): Promise<{ intakeId: string; docId: string; origin: DocOrigin }[]> {
  const { rows } = await db.query(
    `SELECT i.id::text AS intake_id, i.gold_doc_id, i.model, d.truth
       FROM gold_real_intake i JOIN gold_docs d ON d.id = i.gold_doc_id
      WHERE i.status = 'saved' ORDER BY i.gold_doc_id`,
  );
  return (rows as PairRow[]).map((r) => ({ intakeId: r.intake_id, docId: r.gold_doc_id, origin: docOrigin(r.model, r.truth) }));
}

export async function realProgress(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<RealProgress> {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'saved')::int AS saved,
            count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
            count(*) FILTER (WHERE status = 'open')::int AS open,
            count(*) FILTER (WHERE called)::int AS calls,
            coalesce(sum(cost_usd), 0)::text AS cost
       FROM gold_real_intake`,
  );
  const r = rows[0] as { saved: number; skipped: number; open: number; calls: number; cost: string };
  const origins = await listOrigins(db);
  return { target: REAL_TARGET, saved: r.saved, skipped: r.skipped, open: r.open, calls: r.calls, cap: realCallCap(env), costUsd: Number(r.cost), tally: tallyOrigins(origins.map((o) => o.origin)) };
}

// ── 내보내기와 다시 싣기 ───────────────────────────────────

/** 저장소에 남기는 출처 목록. 원문도 값도 없다. 정답 문서가 된 건과 넘긴 건만 싣는다(초안만 있는 건은 아직 고른 것이 아니다). */
export async function realSources(db: Db): Promise<RealSourceEntry[]> {
  return (await listIntakes(db))
    .filter((i) => i.status !== 'open')
    .map((i) => ({
      id: i.goldDocId,
      sourceUrl: i.sourceUrl,
      fetchedOn: i.fetchedOn,
      kind: i.kind,
      status: i.status as 'saved' | 'skipped',
      ...(i.status === 'skipped' && i.skipNote ? { note: i.skipNote } : {}),
    }));
}

/** 저장소에 남기는 "사람이 무엇을 바꿨는가". 칸 이름과 한 일만 있고 값은 없다. */
export interface RealEditsFile {
  note: string;
  tally: OriginTally;
  /** seconds: 그 문서를 확정할 때 화면에서 본 초(가장 최근 첫 확인 기록). 너무 빨리 넘긴 건을 가려 보라고 싣는다. 기록이 없으면 null */
  docs: { id: string; typeChanged: boolean; subtypeChanged: boolean; untouched: boolean; seconds: number | null; fields: Record<string, string>; flagged: string[] }[];
}

export const REAL_EDITS_NOTE =
  '실제 자료 묶음의 정답은 얼린 파이프라인이 채운 초안을 사람이 고쳐서 만들었다. 사람이 놓친 틀림은 맞은 것으로 세어지므로 이 묶음의 정확도는 모델에 유리하게 기운다. ' +
  '여기에는 칸마다 사람이 한 일만 적는다(kept 그대로, fixed 고침, removed 지움, added 넣음, kept_none 없음 그대로). 값은 원문에서 온 것이라 싣지 않는다. ' +
  '사람이 종류를 바꾼 문서에서는 새 종류에 없는 칸이 removed 로 세어진다(모델이 지어낸 값이 아니라 종류가 달라 빠진 칸이다). seconds 는 그 문서를 확정할 때 화면에서 본 초다.';

export async function realEdits(db: Db): Promise<RealEditsFile> {
  const origins = await listOrigins(db);
  const looked = await db.query(
    `SELECT DISTINCT ON (r.gold_doc_id) r.gold_doc_id, r.seconds
       FROM gold_reviews r JOIN gold_docs d ON d.id = r.gold_doc_id
      WHERE d.split = 'real' AND r.pass = 1 ORDER BY r.gold_doc_id, r.id DESC`,
  );
  const secondsOf = new Map((looked.rows as { gold_doc_id: string; seconds: number | null }[]).map((r) => [r.gold_doc_id, r.seconds]));
  return {
    note: REAL_EDITS_NOTE,
    tally: tallyOrigins(origins.map((o) => o.origin)),
    docs: origins.map(({ docId, origin }) => ({
      id: docId,
      typeChanged: origin.typeChanged,
      subtypeChanged: origin.subtypeChanged,
      untouched: origin.untouched,
      seconds: secondsOf.get(docId) ?? null,
      fields: Object.fromEntries(origin.fields.map((f) => [f.field, f.action])),
      flagged: origin.fields.filter((f) => f.flagged).map((f) => f.field),
    })),
  };
}

/**
 * 저장소 밖에 두는 줄(jsonl 한 줄 = 넣은 글 한 건). 모델 초안과 칸별 "모델이 낸 값 / 사람이 확정한 값 / 한 일"이 값째로 들어 있다.
 * 정답 문서가 된 건의 원문은 real.jsonl 에 있으므로 여기에는 싣지 않는다. 넘긴 건과 초안만 있는 건은 원문을 여기에 둔다.
 */
export interface IntakeDumpLine {
  intakeId: string;
  sourceUrl: string;
  fetchedOn: string;
  kind: RealSourceKind;
  status: IntakeStatus;
  skipNote: string | null;
  goldDocId: string | null;
  content: string | null;
  model: ModelDraft;
  modelName: string;
  promptVersion: string;
  called: boolean;
  costUsd: number;
  createdAt: string;
  /** 정답 문서가 된 건에만: 칸별 견줌 */
  origin: DocOrigin | null;
  /**
   * 그 초안을 만든 호출의 장부 줄(모델의 날 답). 장부를 넘겨 준 때에만, 그리고 장부에 있을 때에만 싣는다.
   * DB 를 새로 만든 뒤 이것을 장부에 다시 심어야 real 평가가 "사람이 본 바로 그 답"을 다시 쓴다(안 심으면 모델을 다시 부른다).
   */
  call?: LlmCallRecord | null;
}

/** 넣은 글의 초안을 만든 호출의 장부 키. 초안을 채울 때(frozenDraft)와 같은 식이다. */
const callKeyOf = (content: string, modelName: string) => cacheKeyFor(buildExtractRequest(content) as LlmRequest<unknown>, modelName);

export async function dumpIntakes(db: Db, ledger?: LlmCallStore): Promise<IntakeDumpLine[]> {
  const origins = new Map((await listOrigins(db)).map((o) => [o.intakeId, o.origin]));
  const intakes = await listIntakes(db);
  const calls = new Map<string, LlmCallRecord | null>();
  if (ledger) for (const i of intakes) calls.set(i.id, await ledger.find(callKeyOf(i.content, i.modelName)));
  return intakes.map((i) => ({
    intakeId: i.id,
    sourceUrl: i.sourceUrl,
    fetchedOn: i.fetchedOn,
    kind: i.kind,
    status: i.status,
    skipNote: i.skipNote,
    goldDocId: i.goldDocId,
    content: i.status === 'saved' ? null : i.content,
    model: i.model,
    modelName: i.modelName,
    promptVersion: i.promptVersion,
    called: i.called,
    costUsd: i.costUsd,
    createdAt: i.createdAt,
    origin: origins.get(i.id) ?? null,
    ...(ledger ? { call: calls.get(i.id) ?? null } : {}),
  }));
}

/**
 * 저장소 밖의 줄에 실린 호출 답을 장부에 다시 심는다. 같은 키의 답이 이미 있으면 건드리지 않는다.
 * 심은 줄은 녹화본으로 표시한다(isRecorded). 실제 호출 수와 비용의 셈에 다시 들어가지 않게 하려는 것이다.
 */
export async function seedIntakeCalls(ledger: LlmCallStore, lines: readonly IntakeDumpLine[]): Promise<number> {
  let seeded = 0;
  for (const l of lines) {
    const c = l.call;
    if (!c || typeof c.cacheKey !== 'string' || c.response === undefined || c.response === null) continue;
    if ((await ledger.find(c.cacheKey)) !== null) continue;
    await ledger.save({ ...c, isRecorded: true });
    seeded += 1;
  }
  return seeded;
}

/** dumpIntakes 가 쓴 줄을 읽는다. 꼴이 다르면 오류. */
export function parseIntakeDump(text: string): IntakeDumpLine[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      const r = JSON.parse(line) as IntakeDumpLine;
      const ok = typeof r.intakeId === 'string' && /^\d+$/.test(r.intakeId) && typeof r.sourceUrl === 'string' && typeof r.model === 'object' && r.model !== null && ['open', 'saved', 'skipped'].includes(r.status);
      if (!ok) throw new Error(`넣은 글 기록 ${i + 1}번째 줄의 꼴이 다르다`);
      return r;
    });
}

/**
 * 저장소 밖의 줄을 DB 에 다시 싣는다(DB 를 새로 만들었을 때). 이미 있는 번호는 건너뛴다.
 * 정답 문서가 된 건은 그 문서가 DB 에 있어야 싣는다(먼저 real.jsonl 을 싣는다). 원문은 그 문서의 것을 쓴다.
 */
export async function loadIntakeDump(db: Db, lines: readonly IntakeDumpLine[]): Promise<number> {
  const docs = new Map((await listDocs(db, 'real')).map((d: GoldDoc) => [d.id, d]));
  let inserted = 0;
  for (const l of lines) {
    const content = l.status === 'saved' ? (l.goldDocId ? docs.get(l.goldDocId)?.content : undefined) : l.content;
    if (!content) continue;
    const made = await db.query(
      `INSERT INTO gold_real_intake (id, content, source_url, fetched_on, source_kind, model, model_name, prompt_version, called, cost_usd, status, skip_note, gold_doc_id, created_at)
       VALUES ($1::bigint, $2, $3, $4::date, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT DO NOTHING`,
      [l.intakeId, content, l.sourceUrl, l.fetchedOn, l.kind, JSON.stringify(l.model), l.modelName, l.promptVersion, l.called, l.costUsd, l.status, l.skipNote, l.goldDocId, l.createdAt],
    );
    inserted += made.rowCount ?? 0;
  }
  // 번호를 손으로 넣었으므로 다음 번호가 겹치지 않게 맞춘다.
  await db.query("SELECT setval(pg_get_serial_sequence('gold_real_intake', 'id'), GREATEST((SELECT coalesce(max(id), 0) FROM gold_real_intake), 1), (SELECT count(*) > 0 FROM gold_real_intake))");
  return inserted;
}
