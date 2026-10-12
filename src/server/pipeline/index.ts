// 파이프라인 단계 셋의 문. 꼴은 src/contract/pipeline-api.ts 에 있다.
// 글 만들기 단계는 src/content 의 함수를 받아야 해서 만들어 쓰는 꼴이다(createPipeline).
import type { ContentApi } from '@/contract/content';
import type { PipelineApi } from '@/contract/pipeline-api';
import { createContentStep } from './content';
import { extract } from './extract';
import { transcribe } from './transcribe';

export { createContentStep, extract, transcribe };

export function createPipeline(content: Pick<ContentApi, 'generateContent'>): PipelineApi {
  return { transcribe, extract, content: createContentStep(content) };
}
