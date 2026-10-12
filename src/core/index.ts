// 판단 코드의 문. 지금은 껍데기다. 꼴은 src/contract/core-api.ts 에 있다.
// 이 폴더는 순수 함수만 둔다. DB, 네트워크, 지금 시각, 난수를 쓰지 않는다.
import type { CoreApi } from '@/contract/core-api';

function notBuilt(name: string): never {
  throw new Error(`아직 안 만듦: core.${name}`);
}

export const normalizeMoney: CoreApi['normalizeMoney'] = () => notBuilt('normalizeMoney');
export const normalizeSize: CoreApi['normalizeSize'] = () => notBuilt('normalizeSize');
export const normalizeHours: CoreApi['normalizeHours'] = () => notBuilt('normalizeHours');
export const normalizeFootfall: CoreApi['normalizeFootfall'] = () => notBuilt('normalizeFootfall');
export const normalizePeriodOptions: CoreApi['normalizePeriodOptions'] = () => notBuilt('normalizePeriodOptions');
export const normalizeDays: CoreApi['normalizeDays'] = () => notBuilt('normalizeDays');
export const normalizeField: CoreApi['normalizeField'] = () => notBuilt('normalizeField');

export const checkEvidence: CoreApi['checkEvidence'] = () => notBuilt('checkEvidence');
export const checkMismatch: CoreApi['checkMismatch'] = () => notBuilt('checkMismatch');
export const checkRange: CoreApi['checkRange'] = () => notBuilt('checkRange');
export const checkRequired: CoreApi['checkRequired'] = () => notBuilt('checkRequired');
export const checkStructure: CoreApi['checkStructure'] = () => notBuilt('checkStructure');

export const rulesExtract: CoreApi['rulesExtract'] = () => notBuilt('rulesExtract');
export const routeDraft: CoreApi['routeDraft'] = () => notBuilt('routeDraft');
export const checkContent: CoreApi['checkContent'] = () => notBuilt('checkContent');

export const evaluateDraft: CoreApi['evaluateDraft'] = () => notBuilt('evaluateDraft');
export const recheckDraft: CoreApi['recheckDraft'] = () => notBuilt('recheckDraft');

// 내보낸 것이 약속과 같은 꼴인지 타입 검사가 본다.
const api: CoreApi = {
  normalizeMoney, normalizeSize, normalizeHours, normalizeFootfall, normalizePeriodOptions, normalizeDays, normalizeField,
  checkEvidence, checkMismatch, checkRange, checkRequired, checkStructure,
  rulesExtract, routeDraft, checkContent, evaluateDraft, recheckDraft,
};
export default api;
