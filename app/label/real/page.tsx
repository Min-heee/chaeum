// 실제 자료 넣기. 로컬 전용(LABEL_ENABLED=1 이 아니면 404).
import { notFound } from 'next/navigation';
import { labelEnabled } from '@/gold/label';
import { hintsFromDraft } from '@/gold/origins';
import { MISSING_TABLE_NOTE, getIntake, isMissingTable, listIntakes, realProgress, type RealProgress } from '@/gold/real';
import { getPool } from '@/server/db';
import styles from '../label.module.css';
import RealClient from './RealClient';

export const dynamic = 'force-dynamic';

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** 오늘(한국 날짜). 받은 날짜 칸의 기본값이다. */
const todayKst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

export default async function LabelReal({ searchParams }: { searchParams: Promise<Params> }) {
  if (!labelEnabled()) notFound();
  const q = await searchParams;
  const pool = getPool();
  // 넣은 글의 표(이행 0006)가 아직 없으면 오류 대신 안내를 보인다. /label 첫 화면과 같은 말이다.
  let progress: RealProgress;
  try {
    progress = await realProgress(pool);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    return (
      <main className={styles.home}>
        <h1>실제 자료 넣기</h1>
        <p className={styles.muted}>{MISSING_TABLE_NOTE}</p>
        <p>
          <a href="/label">← 정답 확인 첫 화면</a>
        </p>
      </main>
    );
  }
  const open = (await listIntakes(pool)).filter((i) => i.status === 'open').map((i) => ({ id: i.id, sourceUrl: i.sourceUrl }));
  const id = one(q.id);
  const found = id ? await getIntake(pool, id) : null;
  const start = found && found.status === 'open' ? { ...found, hints: hintsFromDraft(found.content, found.model) } : null;
  return <RealClient progress={progress} open={open} start={start} today={todayKst()} />;
}
