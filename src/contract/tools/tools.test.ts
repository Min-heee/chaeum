// 딸린 도구의 약속이 본체의 약속과, 또 서로 어긋나지 않는지 본다.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { API_ERRORS, SOURCE_KINDS } from '../api';
import { EXTRACTED_BY, FIELD_KEYS, FIELDS_BY_TYPE, PRODUCT_TYPES } from '../fields';
import { LLM_TASKS } from '../llm-types';
import { CONTENT_FAIL_CODES, REASON_CODES } from '../reasons';
import { AUDIT_CODE_DEFS, AUDIT_CODES, AUDIT_CSV_COLUMNS, AUDIT_STRUCTURE_CODES, AuditRequestSchema, AuditResponseSchema } from './audit';
import { AnniversarySchema, CalendarQuerySchema, CalendarResponseSchema } from './calendar';
import {
  COLLECT_FLAGS,
  COLLECT_LIMITS,
  collectDedupeKey,
  ImportRequestSchema,
  ImportRowSchema,
  ImportItemSchema,
  serverFlagsOf,
  type ImportRow,
} from './collect';
import { CREATIVE_CHECKS, CREATIVE_FORMAT_ALIASES, CREATIVE_FORMATS, CREATIVE_LIMITS, CREATIVE_SPEC_FIELDS, CreativeCheckRequestSchema, CreativeFactsSchema } from './creative';
import { DEADLINE_FIELDS, DEADLINE_KINDS, DEADLINE_STATUS_LABELS, DEADLINE_STATUSES } from './dates';
import { effectiveGlossary, GlossaryCreateRequestSchema, GlossaryPatchRequestSchema, type GlossaryRow } from './glossary';
import { TOOL_KEYS, toolDef, TOOLS } from './index';
import {
  QUOTE_LIMITS,
  QUOTE_PLACEHOLDERS,
  QUOTE_PROMPT_VERSIONS,
  QUOTE_TASKS,
  QuoteConfirmRequestSchema,
  QuoteCreateRequestSchema,
  QuoteExtractionSchema,
  QuoteReplyDraftSchema,
} from './quote';
import { XLSX_OPTION_COLUMNS, XLSX_OPTION_SOURCES, XLSX_SHEETS, xlsxFileName, XlsxExportQuerySchema } from './xlsx';

describe('도구 묶음', () => {
  it('메뉴에는 도구 일곱이 정한 순서로 있다', () => {
    expect(TOOLS.map((t) => t.label)).toEqual(['점검', '모으기', '용어 사전', '견적', '시안 검사', '달력', '비교']);
    expect(TOOLS.map((t) => t.key)).toEqual([...TOOL_KEYS]);
    expect(new Set(TOOLS.map((t) => t.href)).size).toBe(7);
    for (const tool of TOOLS) expect(tool.href).toBe(`/${tool.key}`);
  });

  it('LLM 을 쓰는 도구는 견적 하나다', () => {
    expect(TOOLS.filter((t) => t.usesLlm).map((t) => t.key)).toEqual(['quote']);
    expect(toolDef('audit').usesLlm).toBe(false);
  });

  it('본체의 닫힌 목록에 더한 값: 가져온 줄, 견적의 LLM 일 둘, 이미 있음 409', () => {
    expect(SOURCE_KINDS).toContain('import');
    expect(EXTRACTED_BY).toEqual(['llm', 'rules', 'import']);
    for (const task of QUOTE_TASKS) expect(LLM_TASKS).toContain(task);
    expect(API_ERRORS.ALREADY_EXISTS).toBe(409);
  });
});

describe('점검', () => {
  it('문제 코드는 본체의 구조 사유 5 + 글 검사 6 + 저장된 글 상태 1 + 파일 1 이고 모두 설명이 있다', () => {
    expect(AUDIT_CODES).toHaveLength(13);
    expect(new Set(AUDIT_CODES).size).toBe(13);
    for (const code of AUDIT_STRUCTURE_CODES) expect(REASON_CODES).toContain(code);
    for (const code of CONTENT_FAIL_CODES) expect(AUDIT_CODES).toContain(code);
    for (const code of AUDIT_CODES) {
      expect(AUDIT_CODE_DEFS[code].label.length).toBeGreaterThan(0);
      expect(AUDIT_CODE_DEFS[code].description.length).toBeGreaterThan(0);
    }
  });

  it('값 문제는 error, 글 문제는 warning 이다', () => {
    expect(AUDIT_CODE_DEFS.EMPTY_REQUIRED_OPTIONS.severity).toBe('error');
    expect(AUDIT_CODE_DEFS.UNREADABLE_CELL.severity).toBe('error');
    expect(AUDIT_CODE_DEFS.HANGUL_IN_TEXT.severity).toBe('warning');
    expect(AUDIT_CODE_DEFS.GLOSSARY_MISS.group).toBe('content');
  });

  it('요청과 응답의 꼴', () => {
    expect(AuditRequestSchema.safeParse({ source: 'workspace' }).success).toBe(true);
    expect(AuditRequestSchema.safeParse({ source: 'file' }).success).toBe(false);
    expect(AuditRequestSchema.safeParse({ source: 'workspace', save: true }).success).toBe(false);
    const response = {
      source: 'workspace',
      file: null,
      totals: { items: 1, itemsWithFindings: 1, findings: 1, bySeverity: { error: 1, warning: 0 } },
      byCode: [{ code: 'EMPTY_REQUIRED_OPTIONS', label: '옵션 0개', severity: 'error', findings: 1, items: 1 }],
      items: [{
        key: 'product:1', productId: 1, rowNumber: null, name: '합정역 전광판', type: 'ad', subtype: '전광판',
        findings: [{ code: 'EMPTY_REQUIRED_OPTIONS', severity: 'error', field: 'period_options', message: '기간 옵션이 0개입니다.' }],
      }],
      truncated: false,
    };
    expect(AuditResponseSchema.safeParse(response).success).toBe(true);
    expect(AuditResponseSchema.safeParse({ ...response, totals: { ...response.totals, bySeverity: { error: 1 } } }).success).toBe(false);
    expect(AUDIT_CSV_COLUMNS).toContain('code');
  });
});

describe('용어 사전', () => {
  const row = (ko: string, en: string | null, zh: string | null, status: GlossaryRow['status'] = 'approved'): GlossaryRow => ({ ko, en, 'zh-Hans': zh, status });

  it('승인된 줄만 쓰이고, 같은 낱말이면 내 줄이 공용 줄을 이긴다', () => {
    const shared = [row('커피차', 'coffee truck', '咖啡车'), row('전광판', 'digital billboard', '电子屏')];
    const own = [row('커피차', 'coffee cart', '咖啡餐车'), row('포토존', 'photo zone', null, 'proposed')];
    expect(effectiveGlossary(own, shared)).toEqual([
      { ko: '전광판', en: 'digital billboard', 'zh-Hans': '电子屏' },
      { ko: '커피차', en: 'coffee cart', 'zh-Hans': '咖啡餐车' },
    ]);
  });

  it('제안 상태의 내 줄은 공용 줄을 가리지 않는다', () => {
    const got = effectiveGlossary([row('커피차', 'coffee cart', '咖啡餐车', 'proposed')], [row('커피차', 'coffee truck', '咖啡车')]);
    expect(got).toEqual([{ ko: '커피차', en: 'coffee truck', 'zh-Hans': '咖啡车' }]);
  });

  it('돌려주는 줄에는 세 칸만 있고 한국어 낱말 순서다(줄 순서가 달라도 같은 결과)', () => {
    const a = [row('버스', 'bus', '公交'), row('강남역', 'Gangnam Station', '江南站')];
    const got = effectiveGlossary([], a);
    expect(got.map((e) => e.ko)).toEqual(['강남역', '버스']);
    expect(Object.keys(got[0] ?? {}).sort()).toEqual(['en', 'ko', 'zh-Hans']);
    expect(effectiveGlossary([], [...a].reverse())).toEqual(got);
  });

  it('승인으로 넣으려면 두 표기가 다 있어야 한다. 고칠 것이 없는 고치기는 받지 않는다', () => {
    expect(GlossaryCreateRequestSchema.safeParse({ ko: '포토존' }).success).toBe(true);
    expect(GlossaryCreateRequestSchema.safeParse({ ko: '포토존', en: 'photo zone', status: 'approved' }).success).toBe(false);
    expect(GlossaryCreateRequestSchema.safeParse({ ko: '포토존', en: 'photo zone', 'zh-Hans': '拍照区', status: 'approved' }).success).toBe(true);
    expect(GlossaryCreateRequestSchema.safeParse({ ko: '  ' }).success).toBe(false);
    expect(GlossaryPatchRequestSchema.safeParse({}).success).toBe(false);
    expect(GlossaryPatchRequestSchema.safeParse({ status: 'approved' }).success).toBe(true);
    expect(GlossaryPatchRequestSchema.safeParse({ ko: '다른 낱말' }).success).toBe(false);
  });
});

describe('견적', () => {
  /** JSON 스키마에 쓰인 낱말을 모은다. 구조화 출력이 받는 낱말만 있어야 한다(src/llm/wire.ts 의 목록과 같다). */
  const SUPPORTED = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', '$ref', '$defs', 'description'];
  const wordsOf = (node: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(node)) node.forEach((n) => wordsOf(n, out));
    else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        out.add(key);
        if (key === 'properties' || key === '$defs') Object.values(value as object).forEach((v) => wordsOf(v, out));
        else if (key !== 'enum' && key !== 'required') wordsOf(value, out);
      }
    }
    return out;
  };

  it('모델에게 보내는 꼴에는 길이·범위 제약이 없다', () => {
    for (const schema of [QuoteExtractionSchema, QuoteReplyDraftSchema]) {
      const { $schema: _dropped, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
      void _dropped;
      expect([...wordsOf(json)].filter((w) => !SUPPORTED.includes(w))).toEqual([]);
    }
  });

  it('없는 조건은 null 이다. 칸을 빼면 받지 않는다', () => {
    const none = { lang: 'en', budget_raw: null, budget_krw: null, region: null, date_raw: null, date: null, type: null, subtype: null, qty: null, days: null };
    expect(QuoteExtractionSchema.safeParse(none).success).toBe(true);
    const { days: _days, ...missing } = none;
    void _days;
    expect(QuoteExtractionSchema.safeParse(missing).success).toBe(false);
    expect(QuoteExtractionSchema.safeParse({ ...none, lang: 'ja' }).success).toBe(false);
  });

  it('일 둘에 프롬프트 버전과 토큰 상한이 있다', () => {
    for (const task of QUOTE_TASKS) {
      expect(QUOTE_PROMPT_VERSIONS[task]).toMatch(/^quote-/);
      expect(QUOTE_LIMITS.maxTokens[task]).toBeGreaterThan(0);
    }
  });

  it('자리표시 이름은 본체의 꼴(소문자와 밑줄)이다', () => {
    for (const p of QUOTE_PLACEHOLDERS) expect(p).toMatch(/^[a-z_]+$/);
  });

  it('요청: 글이 있어야 하고, 오늘은 달력에 있는 날짜여야 한다. 확정에는 답장 글이 있어야 한다', () => {
    expect(QuoteCreateRequestSchema.safeParse({ text: '예산 300만 원, 홍대 근처' }).success).toBe(true);
    expect(QuoteCreateRequestSchema.safeParse({ text: 'x', today: '2027-02-29' }).success).toBe(false);
    expect(QuoteCreateRequestSchema.safeParse({ text: 'x', today: '2028-02-29', productId: 3 }).success).toBe(true);
    expect(QuoteConfirmRequestSchema.safeParse({ reply: '  ' }).success).toBe(false);
    expect(QuoteConfirmRequestSchema.safeParse({ reply: 'a'.repeat(QUOTE_LIMITS.replyMaxChars + 1) }).success).toBe(false);
  });
});

describe('시안 검사', () => {
  it('받는 형식은 넷이고, 견줄 규격 칸은 광고 지면의 칸이다', () => {
    expect(CREATIVE_FORMATS).toEqual(['jpg', 'png', 'webp', 'mp4']);
    expect(CREATIVE_FORMAT_ALIASES.jpeg).toBe('jpg');
    for (const check of CREATIVE_CHECKS) expect(FIELDS_BY_TYPE.ad).toContain(CREATIVE_SPEC_FIELDS[check]);
  });

  it('서버가 받는 파일은 호스팅의 요청 본문 한도(4.5MB) 안에 든다', () => {
    expect(CREATIVE_LIMITS.fileMaxBytes).toBeLessThan(CREATIVE_LIMITS.requestMaxBytes);
    expect(CREATIVE_LIMITS.requestMaxBytes).toBeLessThanOrEqual(4.5 * 1024 * 1024);
    expect(Number.isInteger(CREATIVE_LIMITS.requestMaxBytes)).toBe(true);
  });

  it('읽은 값의 꼴: 그림은 길이가 없고, 0 이하의 크기는 받지 않는다', () => {
    const image = { format: 'png', width: 1920, height: 1080, sizeBytes: 204800, durationSeconds: null };
    expect(CreativeFactsSchema.safeParse(image).success).toBe(true);
    expect(CreativeFactsSchema.safeParse({ ...image, width: 0 }).success).toBe(false);
    expect(CreativeFactsSchema.safeParse({ ...image, format: 'gif' }).success).toBe(false);
    expect(CreativeCheckRequestSchema.safeParse({ productId: 1, facts: { ...image, format: 'mp4', durationSeconds: 15.02 } }).success).toBe(true);
  });
});

describe('달력', () => {
  it('마감 상태는 셋이고 이름이 있다. 종류마다 어느 칸이 어느 마감인지 정해져 있다', () => {
    expect(DEADLINE_STATUSES.map((s) => DEADLINE_STATUS_LABELS[s])).toEqual(['아직 됨', '곧 마감', '이미 늦음']);
    for (const type of PRODUCT_TYPES) {
      expect(DEADLINE_FIELDS[type].length).toBeGreaterThan(0);
      for (const { kind, field } of DEADLINE_FIELDS[type]) {
        expect(DEADLINE_KINDS).toContain(kind);
        expect(FIELDS_BY_TYPE[type]).toContain(field);
        expect(FIELD_KEYS).toContain(field);
      }
    }
    expect(DEADLINE_FIELDS.ad.map((d) => d.field)).toEqual(['booking_deadline_days', 'material_deadline_days']);
  });

  it('주소 값: 날짜와 기념일은 하나만', () => {
    expect(CalendarQuerySchema.safeParse({}).success).toBe(true);
    expect(CalendarQuerySchema.safeParse({ date: '2027-03-09', today: '2026-10-12' }).success).toBe(true);
    expect(CalendarQuerySchema.safeParse({ date: '2027-03-09', anniversary: 'ann-01' }).success).toBe(false);
    expect(CalendarQuerySchema.safeParse({ date: '2027-3-9' }).success).toBe(false);
  });

  it('기념일은 달과 일만 적는다', () => {
    expect(AnniversarySchema.safeParse({ id: 'ann-01', artist: '가상 가수', kind: 'birthday', month: 2, day: 29 }).success).toBe(true);
    expect(AnniversarySchema.safeParse({ id: 'ann-01', artist: '가상 가수', kind: 'wedding', month: 2, day: 29 }).success).toBe(false);
    expect(AnniversarySchema.safeParse({ id: 'ann-01', artist: '가상 가수', kind: 'debut', month: 13, day: 1 }).success).toBe(false);
  });

  it('응답의 꼴: 상품의 상태에는 "마감 일수 없음"이 하나 더 있다', () => {
    const response = {
      today: '2026-10-12', eventDate: '2027-03-09', anniversary: null, anniversaries: [],
      items: [{ productId: 1, name: '합정역 전광판', type: 'ad', subtype: '전광판', deadlines: [], missing: ['booking', 'material'], status: 'unknown', daysLeft: null }],
      counts: { open: 0, closing: 0, late: 0, unknown: 1 },
    };
    expect(CalendarResponseSchema.safeParse(response).success).toBe(true);
  });
});

describe('모으기', () => {
  const row: ImportRow = {
    line: 3, kind: '전광판', name: '홍대입구역 9번 출구 전광판', region: '서울 마포구', address: '서울 마포구 양화로 160',
    subway_line: '2호선', station: '홍대입구역', media_type: 'LED 전광판', width_m: 7, height_m: 12, quantity: 1,
    lat: 37.557, lng: 126.924, operator: '가상 운영 기관', raw: { 명칭: '홍대입구역 9번 출구 전광판', 규격: '7m x 12m' },
  };

  it('줄의 꼴: 숫자는 숫자로, 모르는 칸은 받지 않는다', () => {
    expect(ImportRowSchema.safeParse(row).success).toBe(true);
    expect(ImportRowSchema.safeParse({ line: 1, raw: {} }).success).toBe(true);
    expect(ImportRowSchema.safeParse({ ...row, width_m: '7' }).success).toBe(false);
    expect(ImportRowSchema.safeParse({ ...row, price: 1500000 }).success).toBe(false);
    expect(ImportRowSchema.safeParse({ ...row, line: 0 }).success).toBe(false);
    expect(ImportRowSchema.safeParse({ ...row, lat: 137 }).success).toBe(false);
    expect(ImportRowSchema.safeParse({ ...row, flags: ['no_size'] }).success).toBe(false);
    expect(ImportRowSchema.safeParse({ ...row, flags: ['unit_assumed'] }).success).toBe(true);
  });

  it('요청: 출처가 꼭 있고 한 번에 500줄까지다. 줄 하나하나는 여기서 묻지 않는다', () => {
    const source = { id: 'sample-source', name: '가상 기관 옥외광고 현황', url: 'https://example.org/data.csv', license: '이용 조건 보기', fetchedAt: '2026-10-12T03:00:00Z' };
    expect(ImportRequestSchema.safeParse({ source, rows: [row, { line: 'x' }] }).success).toBe(true);
    expect(ImportRequestSchema.safeParse({ source, rows: [] }).success).toBe(false);
    expect(ImportRequestSchema.safeParse({ source, rows: new Array(COLLECT_LIMITS.rowsPerRequest + 1).fill(row) }).success).toBe(false);
    expect(ImportRequestSchema.safeParse({ source: { ...source, id: 'Bad Id' }, rows: [row] }).success).toBe(false);
    expect(ImportRequestSchema.safeParse({ source: { ...source, fetchedAt: '어제' }, rows: [row] }).success).toBe(false);
    expect(ImportRequestSchema.safeParse({ rows: [row] }).success).toBe(false);
  });

  it('중복 열쇠: 같은 위치·같은 규격이면 이름과 띄어쓰기가 달라도 같다', () => {
    const key = collectDedupeKey(row);
    expect(key).toBe('서울마포구양화로160|2호선|홍대입구역|led전광판|7|12|');
    expect(collectDedupeKey({ ...row, name: '홍대 9번출구 대형 전광판', address: ' 서울  마포구 양화로 160 ', media_type: 'ＬＥＤ 전광판' })).toBe(key);
    expect(collectDedupeKey({ ...row, width_m: 7.004 })).toBe(key);
  });

  it('중복 열쇠: 규격이나 위치가 다르면 다르다. 주소가 없으면 지역을 쓴다', () => {
    const key = collectDedupeKey(row);
    expect(collectDedupeKey({ ...row, height_m: 6 })).not.toBe(key);
    expect(collectDedupeKey({ ...row, station: '합정역' })).not.toBe(key);
    expect(collectDedupeKey({ ...row, address: null })).toBe('서울마포구|2호선|홍대입구역|led전광판|7|12|');
  });

  it('중복 열쇠: 위치와 역이 모두 없을 때만 이름으로 가른다', () => {
    const bare = { address: null, region: null, subway_line: null, station: null, media_type: null, width_m: null, height_m: null };
    expect(collectDedupeKey({ ...bare, name: '가 전광판' })).toBe('||||||가전광판');
    expect(collectDedupeKey({ ...bare, name: '나 전광판' })).not.toBe(collectDedupeKey({ ...bare, name: '가 전광판' }));
  });

  it('서버가 붙이는 표시', () => {
    expect(serverFlagsOf(row)).toEqual([]);
    expect(serverFlagsOf({ ...row, name: null, address: null, region: null, station: null, width_m: null })).toEqual(['no_name', 'no_location', 'no_size']);
    expect(serverFlagsOf({ ...row, width_m: 700 })).toEqual(['odd_size']);
    for (const flag of serverFlagsOf({ ...row, name: null })) expect(COLLECT_FLAGS).toContain(flag);
  });

  it('줄 하나의 결과는 셋 가운데 하나다', () => {
    expect(ImportItemSchema.safeParse({ index: 0, line: 3, result: 'new', itemId: 1 }).success).toBe(true);
    expect(ImportItemSchema.safeParse({ index: 1, line: 4, result: 'duplicate', itemId: 1 }).success).toBe(true);
    expect(ImportItemSchema.safeParse({ index: 2, result: 'error', code: 'BAD_ROW', message: '가로가 수가 아닙니다.' }).success).toBe(true);
    expect(ImportItemSchema.safeParse({ index: 2, result: 'error', code: 'OTHER', message: 'x' }).success).toBe(false);
  });
});

describe('XLSX 내려받기', () => {
  it('시트는 셋이고 옵션 시트의 열은 고정이다', () => {
    expect(Object.values(XLSX_SHEETS)).toEqual(['상품', '옵션', '안내']);
    expect(XLSX_OPTION_COLUMNS[0]).toBe('상품번호');
    expect(XLSX_OPTION_SOURCES).toEqual(['period_options', 'quantity_options']);
    expect(xlsxFileName('default')).toBe('chaeum-products-default.xlsx');
  });

  it('양식 이름에는 경로 글자가 들어갈 수 없다', () => {
    expect(XlsxExportQuerySchema.safeParse({}).success).toBe(true);
    expect(XlsxExportQuerySchema.safeParse({ template: 'ad-board' }).success).toBe(true);
    expect(XlsxExportQuerySchema.safeParse({ template: '../secret' }).success).toBe(false);
  });
});
