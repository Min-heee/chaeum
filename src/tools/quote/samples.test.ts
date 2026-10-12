import { describe, expect, it } from 'vitest';
import { isSubtypeOf } from '@/contract/fields';
import { QuoteConditionsSchema, type QuoteConditions } from '@/contract/tools/quote';
import { quoteSamples, SAMPLE_FIELDS, SAMPLE_TODAY, scoreSample } from './samples';

const conditionsOf = (sample: ReturnType<typeof quoteSamples>[number]): QuoteConditions => ({
  lang: sample.lang,
  budgetKrw: sample.expected.budgetKrw,
  budgetBy: sample.expected.budgetKrw === null ? null : 'code',
  region: sample.expected.region,
  dateFrom: sample.expected.dateFrom,
  dateTo: sample.expected.dateTo,
  dateProblem: false,
  type: sample.expected.type,
  subtype: sample.expected.subtype,
  qty: sample.expected.qty,
  days: sample.expected.days,
});

describe('보기 문의', () => {
  const samples = quoteSamples();
  it('20건이고 한국어 8, 영어 6, 중국어 6이다. 번호가 겹치지 않는다', () => {
    expect(samples).toHaveLength(20);
    const byLang = (lang: string) => samples.filter((s) => s.lang === lang).length;
    expect([byLang('ko'), byLang('en'), byLang('zh-Hans')]).toEqual([8, 6, 6]);
    expect(new Set(samples.map((s) => s.id)).size).toBe(20);
  });
  it('정답이 조건의 꼴에 맞다: 갈래는 그 종류의 것이고, 날짜는 오늘(정답을 정한 날) 뒤이며 첫날이 끝날보다 앞이다', () => {
    for (const s of samples) {
      const c = conditionsOf(s);
      expect(QuoteConditionsSchema.safeParse(c).success, s.id).toBe(true);
      if (c.subtype !== null) expect(c.type !== null && isSubtypeOf(c.type, c.subtype), s.id).toBe(true);
      expect((c.dateFrom === null) === (c.dateTo === null), s.id).toBe(true);
      if (c.dateFrom !== null && c.dateTo !== null) {
        expect(c.dateFrom >= SAMPLE_TODAY, s.id).toBe(true);
        expect(c.dateFrom <= c.dateTo, s.id).toBe(true);
      }
    }
  });
  it('정답과 같은 조건은 여덟 칸이 모두 맞다', () => {
    for (const s of samples) expect(Object.values(scoreSample(s, conditionsOf(s))).every(Boolean), s.id).toBe(true);
  });
  it('칸 하나가 다르면 그 칸만 틀린다. 지역은 "근처"를 떼고 견준다', () => {
    const s = samples.find((x) => x.id === 'q-ko-01')!;
    const base = conditionsOf(s);
    const wrongOf = (got: QuoteConditions) => SAMPLE_FIELDS.filter((f) => !scoreSample(s, got)[f]);
    expect(wrongOf({ ...base, region: '홍대 근처' })).toEqual([]);
    expect(wrongOf({ ...base, region: '합정' })).toEqual(['region']);
    expect(wrongOf({ ...base, budgetKrw: 300 })).toEqual(['budget']);
    expect(wrongOf({ ...base, dateTo: '2027-05-08' })).toEqual(['date']);
    expect(wrongOf({ ...base, lang: 'en', subtype: '전광판', days: 7 })).toEqual(['lang', 'subtype', 'days']);
  });
});
