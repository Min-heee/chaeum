// 점검의 판단 코드(순수 함수). 약속은 src/contract/tools/audit.ts 에 있다.
// 새 규칙을 만들지 않는다. 본체의 구조 규칙(src/core)과 끝 글 검사(src/content)를 그대로 부른다.
// 시계·난수·DB·네트워크를 쓰지 않는다(린트가 본다). 시험은 같은 폴더의 *.test.ts.
import type { AuditApi } from '@/contract/tools/audit';
import { auditSubject } from './subject';
import { summarize } from './summarize';

export { auditSubject, regionOfSubject, TEXT_SLOTS, type AuditOptions, type TextSlot } from './subject';
export { auditCsvRows, summarize } from './summarize';
export { parseCsv } from './csv-read';
export { readTable, type Cell, type ReadTableInput, type ReadTableResult } from './read-table';

// 내보낸 것이 약속과 같은 꼴인지 타입 검사가 본다.
const api: AuditApi = { auditSubject, summarize };
export default api;
