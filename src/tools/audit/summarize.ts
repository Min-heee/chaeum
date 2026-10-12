// 상품별 문제 목록을 응답의 합계·사유별 묶음·상품 목록으로 묶는다.
import {
  AUDIT_CODE_DEFS,
  AUDIT_CODES,
  AUDIT_CSV_COLUMNS,
  AUDIT_SEVERITIES,
  type AuditItem,
  type AuditResponse,
  type AuditSeverity,
} from '@/contract/tools/audit';

/**
 * - 합계: 살핀 수, 문제가 있는 상품 수, 문제 수, 심각도별 문제 수.
 * - 사유별 묶음: 문제가 0 인 코드는 뺀다. 값 문제가 먼저, 그 안에서는 문제가 많은 것부터(같으면 코드 목록 순서).
 * - 상품 목록: 문제가 있는 것이 먼저, 그 안에서는 들어온 순서.
 */
export function summarize(items: readonly AuditItem[]): Pick<AuditResponse, 'totals' | 'byCode' | 'items'> {
  const bySeverity: Record<AuditSeverity, number> = { error: 0, warning: 0 };
  const byCode = AUDIT_CODES.map((code) => ({
    code,
    label: AUDIT_CODE_DEFS[code].label,
    severity: AUDIT_CODE_DEFS[code].severity,
    findings: 0,
    items: 0,
  }));
  let findings = 0;
  for (const item of items) {
    const seen = new Set<string>();
    for (const f of item.findings) {
      const row = byCode[AUDIT_CODES.indexOf(f.code)];
      if (!row) continue;
      row.findings += 1;
      if (!seen.has(f.code)) row.items += 1;
      seen.add(f.code);
      bySeverity[f.severity] += 1;
      findings += 1;
    }
  }
  const rank = (s: AuditSeverity) => AUDIT_SEVERITIES.indexOf(s);
  return {
    totals: { items: items.length, itemsWithFindings: items.filter((i) => i.findings.length > 0).length, findings, bySeverity },
    byCode: byCode.filter((row) => row.findings > 0).sort((a, b) => rank(a.severity) - rank(b.severity) || b.findings - a.findings),
    items: [...items.filter((i) => i.findings.length > 0), ...items.filter((i) => i.findings.length === 0)],
  };
}

/** format=csv 의 줄들. 문제 하나가 한 줄이고, 문제 없는 상품은 줄이 없다. 열은 AUDIT_CSV_COLUMNS 순서다. */
export function auditCsvRows(items: readonly AuditItem[]): (string | number)[][] {
  return items.flatMap((item) =>
    item.findings.map((f) => {
      const row: Record<(typeof AUDIT_CSV_COLUMNS)[number], string | number> = {
        key: item.key,
        product_id: item.productId ?? '',
        row: item.rowNumber ?? '',
        name: item.name ?? '',
        type: item.type ?? '',
        severity: f.severity,
        code: f.code,
        label: AUDIT_CODE_DEFS[f.code].label,
        field: f.field ?? '',
        message: f.message,
      };
      return AUDIT_CSV_COLUMNS.map((column) => row[column]);
    }),
  );
}
