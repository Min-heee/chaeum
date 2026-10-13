// 실제 자료 묶음에서 "사람이 무엇을 바꿨는가"를 세는 일과 저장 꼴.
import { describe, expect, it } from 'vitest';
import { GoldDocSchema } from '@/contract/eval-types';
import { FIELDS_BY_TYPE } from '@/contract/fields';
import { selectDocs } from '../../eval/runner';
import { SEALED_FLAG, splitFile } from '../../eval/io';
import { docsToJsonl, parseJsonl } from './files';
import {
  actionOf,
  changedCount,
  docOrigin,
  draftFromEvaluation,
  emptyTruth,
  hintsFromDraft,
  isDate,
  isSourceUrl,
  makeGoldDoc,
  nextDocId,
  tallyLine,
  tallyOrigins,
  truthFromDraft,
  type ModelDraft,
} from './origins';

const f = (value: unknown, evidence: string | null = null, flagged = false) => ({ value: value as never, raw: evidence, evidence, flagged });

const content = '가나다 전광판 안내\n위치 강남역, 1주 150만원(VAT 별도)\n운영 05시~25시, 월 유동인구 300만 명';
const draft: ModelDraft = {
  type: 'ad',
  subtype: '전광판',
  docFlagged: true,
  fields: {
    name: f('가나다 전광판', '가나다 전광판 안내'),
    price_krw: f(1_500_000, '1주 150만원'),
    vat_included: f(false, 'VAT 별도'),
    region: f('강남', '위치 강남역'),
    hours: f({ open: '05:00', close: '01:00', nextDay: true }, '운영 05시~25시'),
    footfall_per_day: f(3_000_000, '원문에 없는 구절', true),
    spot_seconds: f(15, null),
    period_options: f(null),
  },
};

describe('사람이 바꾼 칸 세기', () => {
  it('칸 하나에서 한 일을 가른다(열쇠 순서가 달라도 같은 값이다)', () => {
    expect(actionOf(null, null)).toBe('kept_none');
    expect(actionOf(undefined, 5)).toBe('added');
    expect(actionOf(5, null)).toBe('removed');
    expect(actionOf(5, 5)).toBe('kept');
    expect(actionOf(5, 6)).toBe('fixed');
    expect(actionOf({ width: 8, height: 4.5 }, { height: 4.5, width: 8 })).toBe('kept');
    expect(actionOf(['jpg'], ['jpg', 'mp4'])).toBe('fixed');
  });

  it('빈 목록·빈 글은 양쪽 모두 없음이다: 모델이 [] 를 냈고 사람이 그대로 두면 "없음 그대로"이고 분모에 들지 않는다', () => {
    expect(actionOf([], null)).toBe('kept_none');
    expect(actionOf([], [])).toBe('kept_none');
    expect(actionOf('  ', null)).toBe('kept_none');
    expect(actionOf([], [{ qty: 100, price_krw: 800_000 }])).toBe('added');
    expect(actionOf([{ qty: 100, price_krw: 800_000 }], [])).toBe('removed');
    expect(actionOf(0, null)).toBe('removed'); // 0 과 false 는 값이다
    expect(actionOf(false, false)).toBe('kept');

    // 이미 남아 있는 초안에 빈 목록이 있어도 같은 셈이 나온다.
    const withEmpty: ModelDraft = { ...draft, fields: { ...draft.fields, period_options: f([], null, true), name_note: f('  ') } as ModelDraft['fields'] };
    const start = truthFromDraft(withEmpty);
    expect(start.fields.period_options).toBeNull();
    const origin = docOrigin(withEmpty, start);
    const act = Object.fromEntries(origin.fields.map((x) => [x.field, x.action]));
    expect(act).toMatchObject({ period_options: 'kept_none' });
    expect(origin.fields.find((x) => x.field === 'period_options')?.modelValue).toBeNull();
    expect(origin.untouched).toBe(true);
    expect(changedCount(origin)).toBe(0);
    expect(tallyOrigins([origin])).toMatchObject({ modelFilled: 7, removed: 0, untouchedDocs: 1 });
    // 종류를 바꿨을 때도 빈 목록은 "지운 칸"으로 따라오지 않는다.
    expect(docOrigin(withEmpty, emptyTruth('not_product', null)).fields).toHaveLength(7);

    // 초안으로 남길 때부터 없음으로 적는다.
    const made = draftFromEvaluation({
      type: 'catering',
      subtype: '커피차',
      draftReasons: [],
      fields: [
        { field: 'quantity_options', raw: null, evidence: null, finalValue: [], reasons: [] },
        { field: 'name', raw: '가나다 커피차', evidence: '가나다 커피차', finalValue: '가나다 커피차', reasons: [] },
      ],
    } as never);
    expect(made.fields.quantity_options?.value).toBeNull();
    expect(made.fields.name?.value).toBe('가나다 커피차');
  });

  it('문서 하나: 고침·지움·넣음·그대로를 칸마다 남긴다', () => {
    const truth = truthFromDraft(draft);
    expect(Object.keys(truth.fields)).toEqual([...FIELDS_BY_TYPE.ad]);
    expect(docOrigin(draft, truth).untouched).toBe(true);

    truth.fields.region = '강남역'; // 고침
    truth.fields.footfall_per_day = 100_000; // 고침(표시가 붙어 있던 칸)
    truth.fields.spot_seconds = null; // 지움(지어낸 값)
    truth.fields.period_options = [{ days: 7, price_krw: 1_500_000 }]; // 넣음(놓친 값)
    const origin = docOrigin(draft, truth);
    const act = Object.fromEntries(origin.fields.map((x) => [x.field, x.action]));
    expect(act).toMatchObject({ name: 'kept', region: 'fixed', footfall_per_day: 'fixed', spot_seconds: 'removed', period_options: 'added', size_m: 'kept_none' });
    expect(origin.fields.find((x) => x.field === 'region')).toMatchObject({ modelValue: '강남', humanValue: '강남역' });
    expect(origin.untouched).toBe(false);

    const t = tallyOrigins([origin, docOrigin(draft, truthFromDraft(draft))]);
    // 모델이 값을 낸 칸은 문서마다 7개(이름, 판매가, 부가세, 위치, 운영 시간, 유동인구, 한 번 길이).
    expect(t).toMatchObject({ docs: 2, modelFilled: 14, kept: 11, fixed: 2, removed: 1, added: 1, untouchedDocs: 1, typeChanged: 0, changedFlagged: 1 });
    expect(tallyLine(t)).toBe('모델이 채운 칸 가운데 사람이 고친 칸 2/14 · 사람이 새로 넣은 칸 1 · 사람이 지운(지어낸) 칸 1 · 고친 것이 하나도 없는 문서 1/2');
    expect(tallyLine(t)).not.toContain('정확도');
  });

  it('사람이 종류를 바꾸면: 새 종류에도 있는 칸은 값을 견주고, 없는 칸만 지운 것으로, 새 칸은 넣은 것으로 센다', () => {
    const truth = emptyTruth('goods', '인쇄물');
    truth.fields.name = '가나다 전광판';
    truth.fields.size_mm = { width: 55, height: 85 };
    const origin = docOrigin(draft, truth);
    expect(origin.typeChanged).toBe(true);
    expect(origin.subtypeChanged).toBe(true);
    const act = Object.fromEntries(origin.fields.map((x) => [x.field, x.action]));
    expect(act).toMatchObject({ name: 'kept', size_mm: 'added', price_krw: 'removed', region: 'removed', hours: 'removed' });
    expect(act.period_options).toBeUndefined(); // 모델도 비웠고 새 종류에도 없는 칸은 세지 않는다
    expect(tallyOrigins([origin])).toMatchObject({ typeChanged: 1, subtypeChanged: 1, untouchedDocs: 0 });
    // 두 종류에 함께 있는 칸은 값이 다르면 "고침"이다.
    truth.fields.price_krw = 1_200_000;
    expect(Object.fromEntries(docOrigin(draft, truth).fields.map((x) => [x.field, x.action]))).toMatchObject({ name: 'kept', price_krw: 'fixed' });
    // 바꾼 것의 수: 종류를 바꿔 갈래가 따라 바뀐 것은 한 번만 센다(지운 5 + 넣은 1 + 종류 1).
    expect(changedCount(origin)).toBe(origin.fields.filter((x) => x.action !== 'kept' && x.action !== 'kept_none').length + 1);
    // 갈래만 바꿔도 1 이다.
    expect(changedCount(docOrigin(draft, { ...truthFromDraft(draft), subtype: '지하철' }))).toBe(1);

    const none = docOrigin(draft, emptyTruth('not_product', null));
    expect(none.fields.every((x) => x.action === 'removed')).toBe(true);
    expect(none.fields).toHaveLength(7);
  });

  it('강조할 구절은 모델의 근거다. 근거가 원문에 없으면 그대로 넘겨 화면이 알리게 한다', () => {
    const hints = hintsFromDraft(content, draft);
    const of = Object.fromEntries(hints.map((h) => [h.field, h.tokens]));
    expect(of.region).toEqual(['위치 강남역']);
    expect(of.footfall_per_day).toEqual(['원문에 없는 구절']);
    expect(of.spot_seconds).toBeUndefined();
    // 근거는 원문에 없고 원문 표현은 있으면 원문 표현을 쓴다.
    const other: ModelDraft = { ...draft, fields: { name: { value: '가나다', raw: '가나다 전광판', evidence: '가나다  전광판', flagged: false } } };
    expect(hintsFromDraft(content, other)).toEqual([{ field: 'name', tokens: ['가나다 전광판'] }]);
  });
});

describe('저장 꼴', () => {
  it('번호는 묶음 안에서 가장 큰 번호 다음이다', () => {
    expect(nextDocId('real', [])).toBe('real-001');
    expect(nextDocId('real', ['real-001', 'real-007', 'hand-900', 'dev-040'])).toBe('real-008');
    expect(nextDocId('hand', ['hand-009'])).toBe('hand-010');
    expect(() => nextDocId('hand', ['hand-999'])).toThrow();
  });

  it('정답 문서는 약속의 꼴이고, 파일을 다녀와도 같다', () => {
    const truth = truthFromDraft(draft);
    const real = makeGoldDoc({ id: 'real-001', split: 'real', content, truth });
    const hand = makeGoldDoc({ id: 'hand-001', split: 'hand', content: '잔금 안내드립니다.', truth: { type: 'not_product', subtype: '전광판', fields: {} }, traps: ['not_product'] });
    for (const doc of [real, hand]) expect(GoldDocSchema.safeParse(doc).success, doc.id).toBe(true);
    expect(real).toMatchObject({ author: 'human', goldVersion: 1, traps: [] });
    expect(hand.truth).toEqual({ type: 'not_product', subtype: null, fields: {} });
    expect(parseJsonl(docsToJsonl([real, hand]))).toEqual([hand, real]);
    // 그 종류에 없는 칸은 버린다.
    expect(Object.keys(makeGoldDoc({ id: 'real-002', split: 'real', content, truth: { ...truth, fields: { ...truth.fields, size_mm: { width: 1, height: 1 } } } }).truth.fields)).toEqual([...FIELDS_BY_TYPE.ad]);
  });

  it('출처 주소와 날짜의 꼴', () => {
    expect(isSourceUrl('https://example.com/a?b=1')).toBe(true);
    expect(isSourceUrl('example.com')).toBe(false);
    expect(isSourceUrl('javascript:alert(1)')).toBe(false);
    expect(isDate('2026-10-13')).toBe(true);
    expect(isDate('2026-13-40')).toBe(false);
    expect(isDate('10/13')).toBe(false);
  });
});

describe('평가기가 두 묶음을 읽는 길', () => {
  const source = { sealedPath: null, sealedFlag: false };
  it('실제 자료는 안 여는 세트처럼 긴 깃발과 --sealed 경로가 있어야 열린다. 손글은 저장소의 파일에서 읽는다', () => {
    expect(() => splitFile('real', source)).toThrow(SEALED_FLAG);
    expect(() => splitFile('real', { sealedPath: null, sealedFlag: true })).toThrow('--sealed');
    expect(splitFile('real', { sealedPath: '/어딘가/real.jsonl', sealedFlag: true })).toBe('/어딘가/real.jsonl');
    expect(splitFile('hand', source)).toMatch(/data[/\\]gold[/\\]hand\.jsonl$/);
  });

  it('저장할 때 적는 확인 기록(ok·fixed)이 있어야 채점에 들어간다', () => {
    const doc = makeGoldDoc({ id: 'real-001', split: 'real', content, truth: truthFromDraft(draft) });
    expect(selectDocs([doc], []).docs).toEqual([]);
    expect(selectDocs([doc], [{ goldDocId: 'real-001', pass: 1, verdict: 'fixed' }]).docs).toEqual([doc]);
  });
});
