// 손글 묶음(hand)을 만드는 길: 사람이 원문을 직접 쓰고 정답 칸도 직접 채운다. 모델의 초안을 보여 주지 않는다.
// 서버에서만 돈다. 화면은 로컬 전용이다(LABEL_ENABLED=1).
// 원문과 정답이 모두 저장소에 들어간다(data/gold/hand.jsonl, gold:export 가 쓴다). 커밋 시각이 "얼린 뒤에 썼다"의 증거다.
import { LIMITS } from '@/contract/api';
import { GOLD_TRAPS, GoldDocSchema, SPLIT_SIZES, type GoldDoc, type GoldTruth } from '@/contract/eval-types';
import { charCount, cleanText } from '@/server/limits';
import { trapsFromTips } from './entry';
import { canon } from './canon';
import { makeGoldDoc, nextDocId } from './origins';
import { buildTruth } from './real';
import { GoldError, getDoc, loadDocs, type Db } from './store';

export const HAND_TARGET = SPLIT_SIZES.hand;

export interface HandInput {
  /** 이미 쓴 문서를 고칠 때만 준다. 없으면 새 번호로 만든다. */
  id?: string | null;
  content: string;
  type: string;
  subtype: string | null;
  /** 칸 이름 → 표준 값(없음은 null) */
  fields: Record<string, unknown>;
  /** 고른 함정 귀띔의 번호 */
  tipIds?: readonly string[];
  seconds?: number | null;
}

export interface HandOutcome {
  docId: string;
  reviewId: string;
  created: boolean;
  /** 고쳐 썼을 때 정답에서 바뀐 것의 수(새로 쓴 것은 0) */
  changed: number;
}

/**
 * 고쳐 쓰면서 정답에서 바뀐 것의 수: 값이 달라진 칸(두 정답의 칸을 모두 본다) + 종류나 갈래를 바꿨으면 1.
 * 원문만 고치고 정답을 그대로 두면 0 이다.
 */
export function truthChanges(before: GoldTruth, after: GoldTruth): number {
  const same = (a: unknown, b: unknown) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));
  const keys = new Set([...Object.keys(before.fields), ...Object.keys(after.fields)]) as Set<keyof GoldTruth['fields']>;
  let n = before.type !== after.type || (before.subtype ?? null) !== (after.subtype ?? null) ? 1 : 0;
  for (const k of keys) if (!same(before.fields[k], after.fields[k])) n += 1;
  return n;
}

/** 손으로 쓴 원문을 다듬는다. 줄바꿈만 맞추고 앞뒤 빈 줄을 뗀다(공백과 전각 글자는 쓴 그대로 둔다. 그것도 시험의 한 부분이다). */
export function tidyHandContent(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '');
}

/**
 * 손글 한 건을 저장한다. 새로 쓰면 다음 번호(hand-NNN)로 만들고, id 를 주면 그 문서를 고친다.
 * 확인 기록도 한 줄 적는다(새로 쓴 것은 ok, 고쳐 쓴 것은 fixed 와 정답에서 바뀐 것의 수). 트랜잭션 안에서 부른다.
 * 이 기록은 쓴 사람이 저장하면서 저절로 남는 것이다. 다른 눈으로 다시 본 기록이 아니다(평가기가 "확인 기록이 있는 문서"만 채점해서 남긴다).
 */
export async function saveHand(db: Db, input: HandInput): Promise<HandOutcome> {
  if (typeof input.content !== 'string') throw new GoldError('INVALID', '원문이 없다');
  const content = tidyHandContent(input.content);
  const clean = cleanText(content);
  if (clean === '') throw new GoldError('INVALID', '원문이 비었다');
  if (charCount(clean) > LIMITS.textMaxChars) throw new GoldError('INVALID', `원문은 ${LIMITS.textMaxChars.toLocaleString('ko-KR')}자까지다(앱의 접수 상한과 같다).`);

  const truth = buildTruth(input.type, input.subtype, input.fields);
  const traps = trapsFromTips(input.tipIds ?? [], GOLD_TRAPS);
  const seconds = typeof input.seconds === 'number' && Number.isFinite(input.seconds) ? Math.max(0, Math.round(input.seconds)) : null;

  let doc: GoldDoc;
  let created = true;
  let changed = 0;
  if (input.id) {
    const { rows } = await db.query('SELECT id FROM gold_docs WHERE id = $1 AND split = $2 FOR UPDATE', [input.id, 'hand']);
    const old = rows[0] ? await getDoc(db, input.id) : null;
    if (!old) throw new GoldError('NOT_FOUND', `없는 손글 문서: ${input.id}`);
    doc = makeGoldDoc({ id: old.id, split: 'hand', content, truth, traps, goldVersion: old.goldVersion });
    created = false;
    changed = truthChanges(old.truth, doc.truth);
  } else {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('chaeum_gold_next_id'))");
    const ids = await db.query('SELECT id FROM gold_docs WHERE split = $1', ['hand']);
    doc = makeGoldDoc({ id: nextDocId('hand', (ids.rows as { id: string }[]).map((r) => r.id)), split: 'hand', content, truth, traps });
  }
  const parsed = GoldDocSchema.safeParse(doc);
  if (!parsed.success) throw new GoldError('INVALID', `정답의 꼴이 약속과 다르다: ${parsed.error.issues[0]?.path.join('.')}`);

  // 고칠 때는 버전이 같아도 덮어쓴다(버전은 내보낼 때 파일과 견줘 올린다).
  await loadDocs(db, [doc], { force: true });
  const review = await db.query(
    'INSERT INTO gold_reviews (gold_doc_id, pass, verdict, fixed_fields, seconds) VALUES ($1, 1, $2, $3, $4) RETURNING id::text AS id',
    [doc.id, created ? 'ok' : 'fixed', changed, seconds],
  );
  return { docId: doc.id, reviewId: (review.rows[0] as { id: string }).id, created, changed };
}

/**
 * 방금 새로 쓴 손글 한 건을 지운다. 그 문서의 확인 기록이 방금 그 한 줄(reviewId)뿐일 때만 지운다.
 * 고쳐 쓴 것은 되돌리지 않는다(다시 열어 고친다). 트랜잭션 안에서 부른다.
 */
export async function undoHand(db: Db, docId: string, reviewId: string): Promise<void> {
  const { rows } = await db.query('SELECT id FROM gold_docs WHERE id = $1 AND split = $2 FOR UPDATE', [docId, 'hand']);
  if (!rows[0]) throw new GoldError('NOT_FOUND', `없는 손글 문서: ${docId}`);
  const reviews = await db.query('SELECT id::text AS review_id FROM gold_reviews WHERE gold_doc_id = $1 ORDER BY id', [docId]);
  const list = reviews.rows as { review_id: string }[];
  if (list.length !== 1 || list[0]?.review_id !== reviewId) throw new GoldError('CONFLICT', '방금 새로 쓴 문서가 아니다. 지우지 않았다. 목록에서 열어 고친다.');
  await db.query('DELETE FROM gold_docs WHERE id = $1 AND split = $2', [docId, 'hand']);
}

export async function listHand(db: Db): Promise<{ id: string; type: string; chars: number; traps: string[] }[]> {
  const { rows } = await db.query("SELECT id, truth->>'type' AS type, length(content)::int AS chars, traps FROM gold_docs WHERE split = 'hand' ORDER BY id");
  return rows as { id: string; type: string; chars: number; traps: string[] }[];
}
