// 파일의 정답을 DB 에 맞춰 싣는다. 확인 화면이 열릴 때와 gold:load 가 함께 쓴다.
import { readFile } from 'node:fs/promises';
import { REVIEW_VERDICTS } from '@/contract/eval-types';
import { readJsonlFile } from './files';
import { loadDocs, loadReviews, type Db, type LoadResult, type ReviewRow } from './store';

export interface SyncReport {
  files: { file: string; found: boolean; docs: number; result: LoadResult | null }[];
  reviews: number;
}

/** 확인 기록 파일(jsonl)을 읽는다. 없으면 빈 목록. */
export async function readReviewsFile(file: string): Promise<ReviewRow[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      const r = JSON.parse(line) as ReviewRow;
      const ok = typeof r.goldDocId === 'string' && (r.pass === 1 || r.pass === 2) && REVIEW_VERDICTS.includes(r.verdict) && typeof r.reviewedAt === 'string';
      if (!ok) throw new Error(`확인 기록 ${i + 1}번째 줄의 꼴이 다르다`);
      return r;
    });
}

/**
 * 정답 파일들을 DB 에 싣는다. 없는 파일은 건너뛴다.
 * 이미 DB 에 있는 문서는 파일의 버전이 더 높을 때만 바뀐다(force 면 언제나).
 */
export async function syncFiles(db: Db, files: readonly string[], reviewsFile: string | null, opts: { force?: boolean } = {}): Promise<SyncReport> {
  const report: SyncReport = { files: [], reviews: 0 };
  for (const file of files) {
    const docs = await readJsonlFile(file);
    if (!docs) {
      report.files.push({ file, found: false, docs: 0, result: null });
      continue;
    }
    report.files.push({ file, found: true, docs: docs.length, result: await loadDocs(db, docs, opts) });
  }
  if (reviewsFile) report.reviews = await loadReviews(db, await readReviewsFile(reviewsFile));
  return report;
}
