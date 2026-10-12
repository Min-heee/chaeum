// 약속 파일끼리 어긋나지 않는지 본다.
import { describe, expect, it } from 'vitest';
import { API_ERRORS, kstDay, PUBLIC_WORKSPACE_ID } from './api';
import { GoldDocSchema, SPLIT_SIZES, VERDICTS } from './eval-types';
import {
  COMMON_FIELD_KEYS,
  ExtractionSchema,
  FIELD_DEFS,
  FIELD_KEYS,
  FIELD_SCHEMAS,
  FIELDS_BY_TYPE,
  isSubtypeOf,
  parseFieldValue,
  REQUIRED_BY_TYPE,
  REQUIRED_OPTION_FIELDS,
  DOC_TYPES,
} from './fields';
import { isLlmUnavailable, llmKindFromEnv, LlmUnavailable } from './llm-types';
import { CONTENT_FAIL_CODES, CONTENT_FAILS, hasBlocking, REASON_CODES, REASONS } from './reasons';
import { canTransition, DRAFT_STATUSES, TRANSITIONS } from './transitions';

describe('칸 정의', () => {
  it('공통 6(종류·갈래 + 값 칸 4) + 광고 12 + 케이터링 4 + 굿즈 4', () => {
    const count = (group: string) => FIELD_DEFS.filter((d) => d.group === group).length;
    expect(COMMON_FIELD_KEYS).toHaveLength(4);
    expect(count('ad')).toBe(12);
    expect(count('catering')).toBe(4);
    expect(count('goods')).toBe(4);
    expect(FIELD_KEYS).toHaveLength(24);
  });

  it('칸 정의와 값 스키마의 칸 이름이 같다', () => {
    expect([...FIELD_KEYS].sort()).toEqual(Object.keys(FIELD_SCHEMAS).sort());
    expect(new Set(FIELD_KEYS).size).toBe(FIELD_KEYS.length);
  });

  it('필수 칸과 필수 옵션 칸은 그 종류의 칸 안에 있다', () => {
    for (const type of DOC_TYPES) {
      for (const key of REQUIRED_BY_TYPE[type]) expect(FIELDS_BY_TYPE[type]).toContain(key);
      for (const key of REQUIRED_OPTION_FIELDS[type]) expect(REQUIRED_BY_TYPE[type]).toContain(key);
    }
    expect(FIELDS_BY_TYPE.not_product).toEqual([]);
  });

  it('갈래는 종류별 닫힌 목록이다', () => {
    expect(isSubtypeOf('ad', '전광판')).toBe(true);
    expect(isSubtypeOf('ad', '커피차')).toBe(false);
    expect(isSubtypeOf('goods', null)).toBe(false);
    expect(isSubtypeOf('not_product', null)).toBe(true);
    expect(isSubtypeOf('not_product', '전광판')).toBe(false);
  });

  it('값의 꼴: 없음은 통과, 꼴이 다르면 실패', () => {
    expect(parseFieldValue('price_krw', null)).toEqual({ ok: true, value: null });
    expect(parseFieldValue('price_krw', 1500000).ok).toBe(true);
    expect(parseFieldValue('price_krw', '150만원').ok).toBe(false);
    expect(parseFieldValue('price_krw', 1500000.5).ok).toBe(false);
    expect(parseFieldValue('hours', { open: '05:00', close: '01:00', nextDay: true }).ok).toBe(true);
    expect(parseFieldValue('hours', { open: '05:00', close: '25:00', nextDay: false }).ok).toBe(false);
    expect(parseFieldValue('period_options', [{ days: 7, price_krw: 1500000 }]).ok).toBe(true);
  });
});

describe('뽑기 결과 스키마', () => {
  const base = { type: 'ad', subtype: '전광판' };

  it('바른 결과는 통과한다', () => {
    const parsed = ExtractionSchema.parse({
      ...base,
      fields: [
        { field: 'hours', raw: '05시~25시', value: { open: '05:00', close: '01:00', nextDay: true }, evidence: '05시~25시' },
        { field: 'footfall_per_day', raw: null, value: null, evidence: null },
      ],
    });
    expect(parsed.fields).toHaveLength(2);
    expect(parsed.fields[1]?.value).toBeNull();
  });

  it('모르는 칸, 같은 칸 두 번, 꼴이 다른 값은 실패한다', () => {
    const one = (field: string, value: unknown) => ({ field, raw: 'x', value, evidence: 'x' });
    expect(ExtractionSchema.safeParse({ ...base, fields: [one('artist', '가수')] }).success).toBe(false);
    expect(ExtractionSchema.safeParse({ ...base, fields: [one('name', '가'), one('name', '나')] }).success).toBe(false);
    expect(ExtractionSchema.safeParse({ ...base, fields: [one('price_krw', '150')] }).success).toBe(false);
  });

  it('목록에 없는 갈래는 여기서 막지 않는다(사유로 보인다)', () => {
    expect(ExtractionSchema.safeParse({ type: 'ad', subtype: '커피차', fields: [] }).success).toBe(true);
  });
});

describe('사유 코드', () => {
  it('사유 12개, 글 검사 실패 코드 6개가 모두 설명을 가진다', () => {
    expect(REASON_CODES).toHaveLength(12);
    expect(Object.keys(REASONS).sort()).toEqual([...REASON_CODES].sort());
    expect(CONTENT_FAIL_CODES).toHaveLength(6);
    expect(new Set(CONTENT_FAIL_CODES.map((c) => CONTENT_FAILS[c].check)).size).toBe(5);
    for (const code of REASON_CODES) expect(REASONS[code].description.length).toBeGreaterThan(0);
  });

  it('막는 사유가 하나라도 있으면 표시다', () => {
    expect(hasBlocking([])).toBe(false);
    expect(hasBlocking(['REQUIRED_MISSING'])).toBe(true);
  });
});

describe('상태 이동 표', () => {
  // 표 전체(6×6)를 돌며, 적어 둔 이동만 되는지 본다.
  const allowed = new Set([
    'PROCESSING>NEEDS_REVIEW', 'PROCESSING>READY', 'PROCESSING>FAILED',
    'NEEDS_REVIEW>READY', 'NEEDS_REVIEW>APPROVED', 'NEEDS_REVIEW>REJECTED',
    'READY>NEEDS_REVIEW', 'READY>APPROVED', 'READY>REJECTED',
    'FAILED>PROCESSING', 'REJECTED>PROCESSING',
  ]);

  it('36칸 가운데 11칸만 갈 수 있다', () => {
    let yes = 0;
    for (const from of DRAFT_STATUSES) {
      for (const to of DRAFT_STATUSES) {
        const can = canTransition(from, to);
        expect(can, `${from} → ${to}`).toBe(allowed.has(`${from}>${to}`));
        if (can) yes += 1;
      }
    }
    expect(yes).toBe(11);
  });

  it('승인된 초안은 어디로도 가지 않고, 같은 상태로의 이동은 없다', () => {
    expect(TRANSITIONS.APPROVED).toEqual([]);
    for (const s of DRAFT_STATUSES) expect(canTransition(s, s)).toBe(false);
  });
});

describe('LLM 자리', () => {
  it('잠깐의 오류만 다시 해 볼 만하다', () => {
    expect(new LlmUnavailable('TRANSIENT').retryable).toBe(true);
    expect(new LlmUnavailable('CACHE_MISS').retryable).toBe(false);
    expect(isLlmUnavailable(new LlmUnavailable('NO_KEY'))).toBe(true);
    expect(isLlmUnavailable(new Error('다른 오류'))).toBe(false);
  });

  it('방식: 정한 것이 있으면 그것, 없으면 키가 있을 때만 실제 호출', () => {
    expect(llmKindFromEnv({})).toBe('replay');
    expect(llmKindFromEnv({ ANTHROPIC_API_KEY: 'x' })).toBe('anthropic');
    expect(llmKindFromEnv({ LLM_PROVIDER: 'fake', ANTHROPIC_API_KEY: 'x' })).toBe('fake');
    expect(() => llmKindFromEnv({ LLM_PROVIDER: 'other' })).toThrow();
  });
});

describe('평가와 API 의 약속', () => {
  const doc = {
    id: 'dev-001',
    split: 'dev',
    goldVersion: 1,
    content: '합정역 인근 커피차 출장 안내',
    author: 'ai',
    traps: ['missing_field'],
    truth: {
      type: 'goods',
      subtype: '인쇄물',
      fields: {
        name: '응원 슬로건', price_krw: 3000, list_price_krw: null, vat_included: null,
        size_mm: { width: 600, height: 200 }, material: null, lead_time_days: 7, min_order_qty: null,
      },
    },
  };

  it('정답 문서: 그 종류의 칸이 전부 있어야 하고 남는 칸이 없어야 한다', () => {
    expect(GoldDocSchema.safeParse(doc).success).toBe(true);

    const missing: Record<string, unknown> = { ...doc.truth.fields };
    delete missing.material;
    expect(GoldDocSchema.safeParse({ ...doc, truth: { ...doc.truth, fields: missing } }).success).toBe(false);
    const extra = { ...doc.truth.fields, region: '합정역' };
    expect(GoldDocSchema.safeParse({ ...doc, truth: { ...doc.truth, fields: extra } }).success).toBe(false);
    expect(GoldDocSchema.safeParse({ ...doc, id: 'test-001' }).success).toBe(false);
    expect(GoldDocSchema.safeParse({ ...doc, truth: { ...doc.truth, subtype: '커피차' } }).success).toBe(false);
  });

  it('등록 대상이 아닌 글의 정답은 칸이 없다', () => {
    const notProduct = { ...doc, truth: { type: 'not_product', subtype: null, fields: {} } };
    expect(GoldDocSchema.safeParse(notProduct).success).toBe(true);
  });

  it('묶음은 넷(40 / 60 / 20 / 10), 판정은 다섯', () => {
    expect(SPLIT_SIZES).toEqual({ dev: 40, test: 60, real: 20, hand: 10 });
    expect(GoldDocSchema.safeParse({ ...doc, id: 'real-001', split: 'real' }).success).toBe(true);
    expect(VERDICTS).toHaveLength(5);
  });

  it('하루의 경계는 한국 시각이다', () => {
    expect(kstDay(new Date('2026-01-01T14:59:59Z'))).toBe('2026-01-01');
    expect(kstDay(new Date('2026-01-01T15:00:00Z'))).toBe('2026-01-02');
  });

  it('오류 규칙: 낡은 version 409, 표에 없는 이동 422, 상한 429', () => {
    expect(API_ERRORS.VERSION_CONFLICT).toBe(409);
    expect(API_ERRORS.BAD_TRANSITION).toBe(422);
    expect(API_ERRORS.LIMIT_EXCEEDED).toBe(429);
    expect(PUBLIC_WORKSPACE_ID).toMatch(/^[0-9a-f-]{36}$/);
  });
});
