// 시안 검사의 판단 코드. 약속은 src/contract/tools/creative.ts 에 있다.
//   read.ts     파일 바이트 → 형식·가로·세로·길이·용량(image.ts 가 그림, mp4.ts 가 영상의 머리를 읽는다)
//   check.ts    읽은 사실 ↔ 상품의 규격 칸 → 항목별 결과와 고칠 점
//   respond.ts  응답 짓기, 읽지 못한 까닭의 말과 오류 코드
// 모두 순수 함수다. 시계·난수·DB·네트워크를 쓰지 않고, Node 전용 기능도 쓰지 않아 브라우저에서도 같은 코드가 돈다.
// LLM 을 쓰지 않는다. 파일을 저장하지 않는다. 내용 심사(문구, 초상)는 하지 않는다.
import type { CreativeApi } from '@/contract/tools/creative';
import { checkCreative } from './check';
import { readCreative } from './read';

export { checkCreative, ratioMatch, ratioText, verdictOf, type CreativeAbout } from './check';
export {
  RANGE_READ_LIMITS,
  readCreative,
  readCreativeFile,
  readMp4ByRange,
  sniffCreativeFormat,
  type CreativeFileRead,
  type CreativeRead,
  type ReadRange,
} from './read';
export {
  CREATIVE_PROBLEM_CODES,
  CREATIVE_PROBLEM_MESSAGES,
  creativeCheckResponse,
  readUploadedCreative,
  type CreativeCheckInput,
  type CreativeProblem,
  type CreativeProduct,
} from './respond';
export type { Rotation } from './mp4';

// 약속의 꼴(CreativeApi)을 채우는지 타입 검사가 본다.
export const creativeApi = { readCreative, checkCreative } satisfies CreativeApi;
