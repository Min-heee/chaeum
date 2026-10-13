// 정답 확인 화면의 첫 장: 진행 상황과 시작 버튼. 로컬 전용(LABEL_ENABLED=1 이 아니면 404).
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SPLIT_LABELS, type GoldSplit } from '@/contract/eval-types';
import { TYPE_LABELS, type DocType } from '@/contract/fields';
import { HAND_TARGET, listHand } from '@/gold/hand';
import { readHintFile } from '@/gold/hints';
import { LABEL_BATCH, RECHECK_COUNT, labelEnabled, labelTarget, listStatus, syncForLabel } from '@/gold/label';
import { tallyLine } from '@/gold/origins';
import { realProgress, type RealProgress } from '@/gold/real';
import { summarize } from '@/gold/store';
import { getPool } from '@/server/db';
import styles from './label.module.css';

export const dynamic = 'force-dynamic';

const VERDICT_LABELS: Record<string, string> = { ok: '맞음', fixed: '고침', dropped: '버림' };

export default async function LabelHome() {
  if (!labelEnabled()) notFound();
  const pool = getPool();
  const sync = await syncForLabel(pool);
  const summary = await summarize(pool);
  const status = await listStatus(pool);
  const missing = sync.files.filter((f) => !f.found).length;

  // 묶음마다 이번에 확인하기로 고른 문서. 목표가 없는 묶음은 전부 본다(null).
  const hintFile = await readHintFile();
  const targets = new Map<string, Set<string> | null>();
  for (const s of summary.splits) {
    const ids = await labelTarget(pool, s.split, hintFile);
    targets.set(s.split, ids ? new Set(ids) : null);
  }
  const inTarget = (split: string, id: string) => targets.get(split)?.has(id) ?? true;
  /** 그 묶음의 목표 건수와 그 가운데 확인한 건수 */
  const progress = (split: string) => {
    const mine = status.filter((d) => d.split === split && inTarget(split, d.id));
    return { total: mine.length, done: mine.filter((d) => d.verdict !== null).length };
  };

  // 얼린 뒤에 만드는 두 묶음의 진행. 넣은 글의 표(이행 0006)가 아직 없으면 그렇다고 알린다.
  let real: RealProgress | null = null;
  try {
    real = await realProgress(pool);
  } catch (err) {
    if ((err as { code?: string }).code !== '42P01') throw err;
  }
  const handCount = (await listHand(pool)).length;

  return (
    <main className={styles.home}>
      <h1>정답 확인</h1>
      <p className={styles.muted}>
        원문과 정답을 나란히 놓고 칸마다 맞는지 본다. 한 번에 {LABEL_BATCH}건씩 보고 쉰다. 판정과 걸린 시간이 기록된다. 묶음마다 종류와 글 꼴이 고르게 섞이도록 고른 문서만
        확인한다(목표). 잘못 누른 판정은 확인 화면에서 u 로 바로 되돌린다.
        {missing > 0 ? ` (정답 파일 ${sync.files.length}개 가운데 ${missing}개는 아직 없다)` : ''}
      </p>

      <table className={styles.table}>
        <thead>
          <tr>
            <th>묶음</th>
            <th>확인 / 목표</th>
            <th>맞음</th>
            <th>고침</th>
            <th>버림</th>
            <th>고친 칸</th>
            <th>건당 걸린 초</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {summary.splits.map((s) => ({ s, p: progress(s.split) })).map(({ s, p }) => (
            <tr key={s.split}>
              <td>{SPLIT_LABELS[s.split as GoldSplit]}</td>
              <td>
                <strong>
                  {p.done} / {p.total}
                </strong>
                {p.total < s.total ? <span className={styles.muted}> (전체 {s.total}건 가운데 {p.total}건만 봄)</span> : null}
              </td>
              <td>{s.ok}</td>
              <td>{s.fixed}</td>
              <td>{s.dropped}</td>
              <td>{s.fixedFields}</td>
              <td>{s.reviewed > 0 ? Math.round(s.seconds / s.reviewed) : '-'}</td>
              <td>
                {p.done < p.total ? (
                  <Link className={styles.button} href={`/label/review?split=${s.split}`}>
                    이어서 확인
                  </Link>
                ) : (
                  '다 봄'
                )}
              </td>
            </tr>
          ))}
          {summary.splits.length === 0 ? (
            <tr>
              <td colSpan={8}>DB 에 정답 문서가 없다. 정답 파일을 만든 뒤 다시 연다.</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <h2>얼린 뒤에 만드는 묶음</h2>
      <p className={styles.muted}>파이프라인을 얼린 뒤에 사람이 만드는 두 묶음이다. 아래 표의 건수는 지금까지 만든 것 / 모으기로 한 것이다.</p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>묶음</th>
            <th>만든 것 / 목표</th>
            <th>어떻게 만드나</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{SPLIT_LABELS.real}</td>
            <td>
              <strong>{real ? `${real.saved} / ${real.target}` : '-'}</strong>
              {real ? <span className={styles.muted}> (넘김 {real.skipped} · 초안만 {real.open} · 실제 호출 {real.calls}번)</span> : null}
            </td>
            <td>
              공개된 글을 붙여 넣으면 얼린 파이프라인이 초안을 채우고, 사람이 칸마다 확정한다. 정답이 모델 쪽으로 기울 수 있어 정확도 대신 사람이 손댄 수를 센다.
              {real ? <div className={styles.muted}>{tallyLine(real.tally)}</div> : <div className={styles.error}>표가 아직 없다. npm run db:migrate 를 먼저 돌린다.</div>}
            </td>
            <td>
              {real ? (
                <Link className={styles.button} href="/label/real">
                  넣기
                </Link>
              ) : null}
            </td>
          </tr>
          <tr>
            <td>{SPLIT_LABELS.hand}</td>
            <td>
              <strong>
                {handCount} / {HAND_TARGET}
              </strong>
            </td>
            <td>원문도 정답도 사람이 직접 쓴다. 모델을 부르지 않는다.</td>
            <td>
              <Link className={styles.button} href="/label/hand">
                쓰기
              </Link>
            </td>
          </tr>
        </tbody>
      </table>

      <h2>하루 뒤 다시 보기</h2>
      <p className={styles.muted}>
        첫 확인에서 버리지 않은 문서 가운데 {RECHECK_COUNT}건을 씨앗으로 골라 다시 본다. 같은 씨앗이면 같은 문서가 나온다. 지금까지 다시 본 {summary.recheck.reviewed}건 가운데 그대로 둔
        것 {summary.recheck.same}건, 고친 것 {summary.recheck.fixed}건, 버린 것 {summary.recheck.dropped}건.
      </p>
      <form className={styles.inline} action="/label/review" method="get">
        <input type="hidden" name="pass" value="2" />
        <label>
          씨앗 <input name="seed" type="number" defaultValue={1} className={styles.seed} />
        </label>
        <button className={styles.button} type="submit">
          다시 보기 시작
        </button>
      </form>

      <h2>문서별 상태</h2>
      <p className={styles.muted}>
        판정을 잘못 눌렀으면 그 문서를 다시 확인한다. 가장 최근 판정이 쓰인다. 흐린 줄은 이번 목표에 들지 않은 문서다. 원하면 따로 열어 확인할 수 있고, 확인하면 목표에 들어온다.
      </p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>번호</th>
            <th>종류</th>
            <th>판정</th>
            <th>걸린 초</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {status.map((d) => {
            const skip = !inTarget(d.split, d.id);
            return (
              <tr key={d.id} className={skip ? styles.skip : undefined}>
                <td>{d.id}</td>
                <td>{TYPE_LABELS[d.type as DocType] ?? d.type}</td>
                <td>{d.verdict ? VERDICT_LABELS[d.verdict] : skip ? '이번에는 안 봄' : '아직'}</td>
                <td>{d.seconds ?? '-'}</td>
                <td>
                  <Link href={`/label/review?id=${d.id}`}>{d.verdict ? '다시 확인' : skip ? '따로 열기' : '확인'}</Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
