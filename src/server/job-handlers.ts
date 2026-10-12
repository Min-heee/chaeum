// 작업 종류별 처리기. 작업자(npm run worker)와 /jobs/drain 이 이 지도를 줄에 넘긴다.
//
// 지금은 비어 있다. 처리기가 없는 종류는 줄이 집지 않으므로 작업은 queued 로 기다린다.
// 다음 단계에서 붙인다:
//   extract: 뽑기 → 맞추기 → 따지기 → 갈래. 죽으면 failDraftIfProcessing 으로 초안을 FAILED 로.
//   content: 두 언어 글 만들기 → 글 검사 → product_texts.
import type { JobHandlers } from './queue';

export const jobHandlers: JobHandlers = {};
