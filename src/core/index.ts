// 판단 코드의 문. 꼴은 src/contract/core-api.ts 에 있다.
// 이 폴더는 순수 함수만 둔다. DB, 네트워크, 지금 시각, 난수를 쓰지 않는다.
import type { CoreApi } from '@/contract/core-api';
import { checkEvidence } from './checks/evidence';
import { checkMismatch } from './checks/mismatch';
import { checkRange } from './checks/range';
import { checkRequired } from './checks/required';
import { checkStructure } from './checks/structure';
import { checkContent } from './content-check';
import { evaluateDraft, recheckDraft } from './evaluate';
import { normalizeDays } from './normalize/days';
import { normalizeField } from './normalize/field';
import { normalizeFootfall } from './normalize/footfall';
import { normalizeHours } from './normalize/hours';
import { normalizeMoney } from './normalize/money';
import { normalizePeriodOptions } from './normalize/period';
import { normalizeSize } from './normalize/size';
import { routeDraft } from './route';
import { rulesExtract } from './rules-extract';

export {
  normalizeMoney, normalizeSize, normalizeHours, normalizeFootfall, normalizePeriodOptions, normalizeDays, normalizeField,
  checkEvidence, checkMismatch, checkRange, checkRequired, checkStructure,
  rulesExtract, routeDraft, checkContent, evaluateDraft, recheckDraft,
};

// 내보낸 것이 약속과 같은 꼴인지 타입 검사가 본다.
const api: CoreApi = {
  normalizeMoney, normalizeSize, normalizeHours, normalizeFootfall, normalizePeriodOptions, normalizeDays, normalizeField,
  checkEvidence, checkMismatch, checkRange, checkRequired, checkStructure,
  rulesExtract, routeDraft, checkContent, evaluateDraft, recheckDraft,
};
export default api;
