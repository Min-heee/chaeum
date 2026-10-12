// 첫 화면 = 작업 화면. 보기 글을 서버에서 읽어 넘기므로 열자마자 왼쪽에 글이 들어 있다.
import type { SampleListResponse } from '@/contract/api';
import { sampleList } from '@/server/service';
import { Workbench } from '../components/Workbench';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let samples: SampleListResponse['items'] = [];
  let failed = false;
  try {
    samples = (await sampleList()).items;
  } catch (err) {
    // 연결 주소 같은 값이 새지 않게 오류의 이름만 남긴다.
    console.error('[page] 보기 글을 읽지 못했다:', err instanceof Error ? err.name : 'unknown');
    failed = true;
  }
  return <Workbench samples={samples} samplesError={failed} />;
}
