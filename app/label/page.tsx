// 정답 확인 화면의 첫 장: 진행 상황과 시작 버튼. 로컬 전용(LABEL_ENABLED=1 이 아니면 404).
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SPLIT_LABELS, type GoldSplit } from '@/contract/eval-types';
import { TYPE_LABELS, type DocType } from '@/contract/fields';
import { LABEL_BATCH, RECHECK_COUNT, labelEnabled, listStatus, syncForLabel } from '@/gold/label';
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

  return (
    <main className={styles.home}>
      <h1>정답 확인</h1>
      <p className={styles.muted}>
        원문과 정답을 나란히 놓고 칸마다 맞는지 본다. 한 번에 {LABEL_BATCH}건씩. 판정과 걸린 시간이 기록된다.
        {missing > 0 ? ` (정답 파일 ${sync.files.length}개 가운데 ${missing}개는 아직 없다)` : ''}
      </p>

      <table className={styles.table}>
        <thead>
          <tr>
            <th>묶음</th>
            <th>확인 / 전체</th>
            <th>맞음</th>
            <th>고침</th>
            <th>버림</th>
            <th>고친 칸</th>
            <th>건당 걸린 초</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {summary.splits.map((s) => (
            <tr key={s.split}>
              <td>{SPLIT_LABELS[s.split as GoldSplit]}</td>
              <td>
                {s.reviewed} / {s.total}
              </td>
              <td>{s.ok}</td>
              <td>{s.fixed}</td>
              <td>{s.dropped}</td>
              <td>{s.fixedFields}</td>
              <td>{s.reviewed > 0 ? Math.round(s.seconds / s.reviewed) : '-'}</td>
              <td>
                {s.reviewed < s.total ? (
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
      <p className={styles.muted}>판정을 잘못 눌렀으면 그 문서를 다시 확인한다. 가장 최근 판정이 쓰인다.</p>
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
          {status.map((d) => (
            <tr key={d.id}>
              <td>{d.id}</td>
              <td>{TYPE_LABELS[d.type as DocType] ?? d.type}</td>
              <td>{d.verdict ? VERDICT_LABELS[d.verdict] : '아직'}</td>
              <td>{d.seconds ?? '-'}</td>
              <td>
                <Link href={`/label/review?id=${d.id}`}>{d.verdict ? '다시 확인' : '확인'}</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
