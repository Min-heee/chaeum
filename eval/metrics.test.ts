// 평가기 자체의 시험. 답을 아는 가짜 결과를 넣어 지표가 손으로 센 값과 같은지 본다.
import { describe, expect, it } from 'vitest';
import type { EvalCell, GoldDoc, Verdict } from '@/contract/eval-types';
import type { FieldKey } from '@/contract/fields';
import { cleanName, computeMetrics, formatRatio, gradeDoc, isNone, judgeField, percentile, valuesMatch, wrongDocs, type CallStat } from './metrics';

const cell = (goldDocId: string, field: EvalCell['field'], verdict: Verdict, flagged = false): EvalCell => ({
  goldDocId,
  field,
  expected: null,
  actual: null,
  verdict,
  flagged,
});

describe('일치 규칙의 경계', () => {
  it('금액은 원 단위 정수가 같아야 한다. 허용 오차 없음', () => {
    expect(valuesMatch('price_krw', 1500000, 1500000)).toBe(true);
    expect(valuesMatch('price_krw', 1500000, 1500001)).toBe(false);
    expect(valuesMatch('price_krw', 1500000, 15000000)).toBe(false);
  });

  it('금액 칸에 글자가 오면 "없음"이 아니라 다른 값이다', () => {
    expect(judgeField('price_krw', 1500000, '150만원')).toBe('wrong');
    expect(judgeField('price_krw', null, '150만원')).toBe('fabricated');
  });

  it('크기: 정확히 1% 는 맞음', () => {
    expect(valuesMatch('size_m', { width: 10, height: 5 }, { width: 10.1, height: 5.05 })).toBe(true);
    expect(valuesMatch('size_m', { width: 7, height: 4 }, { width: 7.07, height: 3.96 })).toBe(true);
    expect(valuesMatch('size_mm', { width: 100, height: 200 }, { width: 101, height: 198 })).toBe(true);
  });

  it('크기: 1% 를 조금 넘기면 틀림', () => {
    expect(valuesMatch('size_m', { width: 10, height: 5 }, { width: 10.11, height: 5 })).toBe(false);
    expect(valuesMatch('size_mm', { width: 100, height: 200 }, { width: 100, height: 203 })).toBe(false);
  });

  it('크기: 가로·세로가 뒤바뀌면 틀림', () => {
    expect(valuesMatch('size_m', { width: 7, height: 12 }, { width: 12, height: 7 })).toBe(false);
  });

  it('해상도는 가로와 세로가 각각 같아야 한다', () => {
    expect(valuesMatch('resolution_px', { width: 1920, height: 1080 }, { width: 1920, height: 1080 })).toBe(true);
    expect(valuesMatch('resolution_px', { width: 1920, height: 1080 }, { width: 1921, height: 1080 })).toBe(false);
  });

  it('유동인구: 정확히 5% 는 맞고 조금 넘기면 틀림', () => {
    expect(valuesMatch('footfall_per_day', 100000, 105000)).toBe(true);
    expect(valuesMatch('footfall_per_day', 100000, 95000)).toBe(true);
    expect(valuesMatch('footfall_per_day', 100000, 105001)).toBe(false);
    expect(valuesMatch('footfall_per_day', 100000, 94999)).toBe(false);
  });

  it('시간: 시작·끝·다음 날 여부가 모두 같아야 한다', () => {
    const want = { open: '05:00', close: '01:00', nextDay: true };
    expect(valuesMatch('hours', want, { close: '01:00', nextDay: true, open: '05:00' })).toBe(true);
    expect(valuesMatch('hours', want, { ...want, nextDay: false })).toBe(false);
    expect(valuesMatch('service_hours', want, { ...want, close: '01:30' })).toBe(false);
  });

  it('이름: 정리한 뒤 완전히 같아야 한다(공백·괄호·대소문자·글자 꼴은 봐준다)', () => {
    expect(cleanName(' 하늘빛 [LED] 전광판 ')).toBe('하늘빛led전광판');
    expect(valuesMatch('name', '하늘빛 전광판 (A면)', '하늘빛전광판 A면')).toBe(true);
    expect(valuesMatch('name', 'ＡＢＣ 미디어월', 'abc 미디어월')).toBe(true);
  });

  it('이름: 포함 관계는 틀림', () => {
    expect(valuesMatch('name', '하늘빛 전광판', '하늘빛 전광판 A면')).toBe(false);
    expect(valuesMatch('region', '강남역 11번 출구', '강남역')).toBe(false);
  });

  it('목록: 순서를 보지 않고 같은 쌍은 한 번으로 친다', () => {
    const want = [{ days: 7, price_krw: 100 }, { days: 14, price_krw: 180 }];
    expect(valuesMatch('period_options', want, [{ days: 14, price_krw: 180 }, { days: 7, price_krw: 100 }])).toBe(true);
    expect(valuesMatch('period_options', want, [...want, { days: 7, price_krw: 100 }])).toBe(true);
  });

  it('목록에 하나 더 있거나 덜 있으면 틀림. 쌍 안의 금액에는 허용 오차가 없다', () => {
    const want = [{ days: 7, price_krw: 100 }, { days: 14, price_krw: 180 }];
    expect(valuesMatch('period_options', want, [...want, { days: 30, price_krw: 300 }])).toBe(false);
    expect(valuesMatch('period_options', want, [want[0]])).toBe(false);
    expect(valuesMatch('period_options', want, [want[0], { days: 14, price_krw: 181 }])).toBe(false);
    expect(valuesMatch('quantity_options', [{ qty: 100, price_krw: 800000 }], [{ qty: 100, price_krw: 800000 }])).toBe(true);
    expect(valuesMatch('quantity_options', [{ qty: 100, price_krw: 800000 }], [{ qty: 200, price_krw: 800000 }])).toBe(false);
  });

  it('빈 목록은 "없음"이다', () => {
    expect(isNone([])).toBe(true);
    expect(judgeField('period_options', [{ days: 7, price_krw: 100 }], [])).toBe('missed');
    expect(judgeField('period_options', null, [])).toBe('true_none');
  });

  it('파일 형식: 소문자로, 앞의 점을 떼고, 같은 형식의 다른 이름을 합쳐 집합으로 견준다', () => {
    expect(valuesMatch('file_format', ['jpg', 'mp4'], ['.MP4', 'JPEG'])).toBe(true);
    expect(valuesMatch('file_format', ['tif'], ['tiff'])).toBe(true);
    expect(valuesMatch('file_format', ['jpg', 'mp4'], ['jpg'])).toBe(false);
  });

  it('참·거짓과 정수 칸은 같아야 한다', () => {
    expect(valuesMatch('vat_included', false, false)).toBe(true);
    expect(valuesMatch('vat_included', false, true)).toBe(false);
    expect(valuesMatch('refund_full_days', 7, 7)).toBe(true);
    expect(valuesMatch('spot_seconds', 15, 16)).toBe(false);
  });
});

describe('"없음" 처리', () => {
  it('정답도 낸 값도 없으면 true_none', () => {
    expect(judgeField('list_price_krw', null, null)).toBe('true_none');
    expect(judgeField('list_price_krw', null, undefined)).toBe('true_none');
    expect(judgeField('material', null, '  ')).toBe('true_none');
    expect(judgeField('material', null, '()')).toBe('true_none');
  });

  it('정답이 없는데 값을 내면 fabricated', () => {
    expect(judgeField('list_price_krw', null, 30000)).toBe('fabricated');
    expect(judgeField('vat_included', null, false)).toBe('fabricated');
  });

  it('정답이 있는데 못 내면 missed, 다른 값을 내면 wrong', () => {
    expect(judgeField('price_krw', 25000, null)).toBe('missed');
    expect(judgeField('price_krw', 25000, 30000)).toBe('wrong');
    expect(judgeField('price_krw', 25000, 25000)).toBe('correct');
  });

  it('거짓(false)과 0 은 "없음"이 아니다', () => {
    expect(isNone(false)).toBe(false);
    expect(isNone(0)).toBe(false);
    expect(judgeField('vat_included', false, null)).toBe('missed');
  });
});

describe('문서 하나 채점', () => {
  const goods: Pick<GoldDoc, 'id' | 'truth'> = {
    id: 'dev-901',
    truth: {
      type: 'goods',
      subtype: '인쇄물',
      fields: {
        name: '별무리 엽서 세트',
        price_krw: 25000,
        list_price_krw: 30000,
        vat_included: null,
        size_mm: { width: 100, height: 148 },
        material: '스노우지',
        lead_time_days: 5,
        min_order_qty: null,
      },
    },
  };

  it('정답 종류의 칸만 채점하고, 낸 결과에 없는 칸은 "없음"으로 친다', () => {
    const cells = gradeDoc(goods, {
      type: 'goods',
      subtype: '인쇄물',
      values: { name: '별무리 엽서세트', price_krw: 25000, min_order_qty: 50, region: '합정역' },
      fieldFlags: { price_krw: true },
      docFlagged: true,
    });
    const verdictOf = (f: string) => cells.find((c) => c.field === f)?.verdict;
    expect(cells.map((c) => c.field)).toEqual(['type', 'subtype', 'name', 'price_krw', 'list_price_krw', 'vat_included', 'size_mm', 'material', 'lead_time_days', 'min_order_qty']);
    expect(verdictOf('type')).toBe('correct');
    expect(verdictOf('name')).toBe('correct');
    expect(verdictOf('list_price_krw')).toBe('missed');
    expect(verdictOf('vat_included')).toBe('true_none');
    expect(verdictOf('min_order_qty')).toBe('fabricated');
    expect(cells.find((c) => c.field === 'type')?.flagged).toBe(true);
    expect(cells.find((c) => c.field === 'price_krw')?.flagged).toBe(true);
    expect(cells.find((c) => c.field === 'name')?.flagged).toBe(false);
  });

  it('종류가 틀리면 type 줄이 wrong 이고, 공통 칸은 낸 값으로 채점한다', () => {
    const cells = gradeDoc(goods, { type: 'ad', subtype: '전광판', values: { price_krw: 25000 }, fieldFlags: {}, docFlagged: false });
    expect(cells.find((c) => c.field === 'type')?.verdict).toBe('wrong');
    expect(cells.find((c) => c.field === 'subtype')?.verdict).toBe('wrong');
    expect(cells.find((c) => c.field === 'price_krw')?.verdict).toBe('correct');
    expect(cells.find((c) => c.field === 'size_mm')?.verdict).toBe('missed');
  });

  it('정답이 "등록 대상 아님"이면 type 줄만 있다', () => {
    const doc: Pick<GoldDoc, 'id' | 'truth'> = { id: 'dev-902', truth: { type: 'not_product', subtype: null, fields: {} } };
    expect(gradeDoc(doc, { type: 'not_product', subtype: null, values: {}, fieldFlags: {}, docFlagged: true })).toHaveLength(1);
    const wrong = gradeDoc(doc, { type: 'goods', subtype: '잡화', values: { price_krw: 1 }, fieldFlags: {}, docFlagged: false });
    expect(wrong).toHaveLength(1);
    expect(wrong[0]?.verdict).toBe('wrong');
  });
});

describe('지표 여섯 — 손으로 센 값', () => {
  // 문서 넷. 줄마다 판정과 표시를 손으로 정했다.
  const cells: EvalCell[] = [
    // A: 표시 없는 문서인데 틀린 칸이 있다
    cell('A', 'type', 'correct', false),
    cell('A', 'subtype', 'correct'),
    cell('A', 'name', 'correct'),
    cell('A', 'price_krw', 'wrong', true),
    cell('A', 'list_price_krw', 'true_none'),
    cell('A', 'region', 'missed', true),
    cell('A', 'vat_included', 'fabricated'),
    // B: 표시가 붙은 문서. 칸은 다 맞았지만 갈래가 틀렸다
    cell('B', 'type', 'correct', true),
    cell('B', 'subtype', 'wrong'),
    cell('B', 'name', 'correct', true),
    cell('B', 'price_krw', 'correct'),
    cell('B', 'list_price_krw', 'true_none', true),
    // C: 등록 대상 아님. 종류만 맞히면 전부 맞은 문서다
    cell('C', 'type', 'correct', false),
    // D: 종류부터 틀렸다
    cell('D', 'type', 'wrong', false),
    cell('D', 'subtype', 'wrong'),
    cell('D', 'name', 'missed'),
    cell('D', 'price_krw', 'missed'),
  ];
  const calls: CallStat[] = [
    { goldDocId: 'A', costUsd: 0.001, latencyMs: 400, recorded: false },
    { goldDocId: 'B', costUsd: 0.001, latencyMs: 100, recorded: false },
    { goldDocId: 'C', costUsd: 0.001, latencyMs: 300, recorded: false },
    { goldDocId: 'D', costUsd: 0.001, latencyMs: 200, recorded: false },
  ];
  const m = computeMetrics(cells, { hasFlags: true, calls });

  it('문서 수', () => expect(m.docs).toBe(4));

  it('1. 칸 정확도: 3/7, 칸별로도 분자·분모가 남는다', () => {
    expect(m.fieldAccuracy.overall).toEqual({ num: 3, den: 7 });
    expect(m.fieldAccuracy.byField.name).toEqual({ num: 2, den: 3 });
    expect(m.fieldAccuracy.byField.price_krw).toEqual({ num: 1, den: 3 });
    expect(m.fieldAccuracy.byField.region).toEqual({ num: 0, den: 1 });
    expect(m.fieldAccuracy.byField.list_price_krw).toEqual({ num: 0, den: 0 });
  });

  it('2. 지어낸 값: 1/3', () => {
    expect(m.fabricated.overall).toEqual({ num: 1, den: 3 });
    expect(m.fabricated.byField.vat_included).toEqual({ num: 1, den: 1 });
    expect(m.fabricated.byField.list_price_krw).toEqual({ num: 0, den: 2 });
  });

  it('3. 전부 맞은 문서: 1/4 (갈래만 틀린 문서도 전부 맞은 것이 아니다)', () => {
    expect(m.docsAllCorrect).toEqual({ num: 1, den: 4 });
  });

  it('4. 바로 승인 줄 3/4, 그 안의 틀린 것 2/3', () => {
    expect(m.autoApprove).toEqual({ ready: { num: 3, den: 4 }, readyWithError: { num: 2, den: 3 } });
  });

  it('5. 검사기 포착 2/5, 헛경보 1/3, 표시가 붙은 "없음" 칸 1/2', () => {
    expect(m.checker).toEqual({ caught: { num: 2, den: 5 }, falseAlarm: { num: 1, den: 3 }, flaggedTrueNone: { num: 1, den: 2 } });
  });

  it('6. 건당 비용과 시간(가장 가까운 순위 방식)', () => {
    expect(m.costTime).toEqual({ costUsdTotal: 0.004, costUsdPerDoc: 0.001, latencyMsP50: 200, latencyMsP95: 400, fromRecording: false });
  });

  it('따로 싣는 것: 종류 3/4, 갈래 1/3, 놓친 값 3/7', () => {
    expect(m.typeAccuracy).toEqual({ num: 3, den: 4 });
    expect(m.subtypeAccuracy).toEqual({ num: 1, den: 3 });
    expect(m.missed).toEqual({ num: 3, den: 7 });
  });

  it('표시가 없는 방식은 4번·5번을, 호출이 없는 방식은 6번을 내지 않는다', () => {
    const llmOnly = computeMetrics(cells, { hasFlags: false, calls });
    expect(llmOnly.autoApprove).toBeNull();
    expect(llmOnly.checker).toBeNull();
    expect(llmOnly.docsAllCorrect).toEqual({ num: 1, den: 4 });
    expect(computeMetrics(cells, { hasFlags: true }).costTime).toBeNull();
  });

  it('녹화본에서 읽은 값이 섞이면 그렇게 적는다', () => {
    const mixed = computeMetrics(cells, { hasFlags: true, calls: [{ ...calls[0]!, recorded: true }, ...calls.slice(1)] });
    expect(mixed.costTime?.fromRecording).toBe(true);
  });

  it('틀린 건 목록에는 전부 맞지 않은 문서만 나온다', () => {
    const wrong = wrongDocs(cells);
    expect(wrong.map((d) => d.goldDocId)).toEqual(['A', 'B', 'D']);
    expect(wrong[0]?.errors.map((c) => c.field)).toEqual(['price_krw', 'region', 'vat_included']);
  });

  it('문서가 없으면 분모가 0 이고, 비율을 적지 않는다', () => {
    const empty = computeMetrics([], { hasFlags: true });
    expect(empty.docsAllCorrect).toEqual({ num: 0, den: 0 });
    expect(formatRatio(empty.docsAllCorrect)).toBe('해당 없음(0건)');
    // 분자가 0 이면 비율을 붙이지 않는다.
    expect(formatRatio({ num: 0, den: 3 })).toBe('0/3');
    expect(formatRatio({ num: 1, den: 3 })).toBe('1/3 (33.3%)');
  });
});

describe('백분위', () => {
  it('⌈n × p⌉번째 값', () => {
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([42], 0.95)).toBe(42);
    expect(percentile([], 0.5)).toBe(0);
  });
});

// 칸 이름을 잘못 적으면 여기서 타입 오류가 난다.
const _fieldCheck: FieldKey[] = ['name', 'price_krw', 'list_price_krw', 'region', 'vat_included'];
void _fieldCheck;
