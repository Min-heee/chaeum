// 맞추기 시험. 못 읽는 표기는 틀린 값을 내지 않고 PARSE_FAILED 여야 한다.
import { describe, expect, it } from 'vitest';
import { normalizeDays, normalizeField, normalizeFootfall, normalizeHours, normalizeMoney, normalizePeriodOptions, normalizeSize } from '../index';

const FAILED = { value: null, reasons: ['PARSE_FAILED'] };
const CONVERTED = ['UNIT_CONVERTED'];

describe('금액', () => {
  it('함정: "150" 처럼 만원을 생략하면 150만원으로 읽고 단위 바꿈을 붙인다', () => {
    expect(normalizeMoney('150')).toEqual({ value: 1_500_000, reasons: CONVERTED });
    expect(normalizeMoney('가격 150 부가세 별도')).toEqual({ value: 1_500_000, reasons: CONVERTED });
  });

  it('경계: 단위 없는 숫자는 9,999까지 만원, 10,000부터 원이다', () => {
    expect(normalizeMoney('9999')).toEqual({ value: 99_990_000, reasons: CONVERTED });
    expect(normalizeMoney('10000')).toEqual({ value: 10_000, reasons: [] });
    expect(normalizeMoney('1500000')).toEqual({ value: 1_500_000, reasons: [] });
  });

  it.each([
    ['1,500,000원', 1_500_000],
    ['150만', 1_500_000],
    ['150만원', 1_500_000],
    ['150만 원', 1_500_000],
    ['1.5천만', 15_000_000],
    ['1천5백만원', 15_000_000],
    ['1억 2천만원', 120_000_000],
    ['1억 천만원', 110_000_000],
    ['2만 5000원', 25_000],
    ['3,500원', 3_500],
    ['₩1,500,000', 1_500_000],
    ['약 150만원부터', 1_500_000],
    ['150万韩元', 1_500_000],
    ['KRW 1.5 million', 1_500_000],
    ['１５０만원', 1_500_000],
  ])('%s → %d원', (raw, won) => {
    expect(normalizeMoney(raw)).toEqual({ value: won, reasons: [] });
  });

  it('함정: 부가세 별도·포함 표시가 붙어도 적힌 금액 그대로다(더하거나 빼지 않는다)', () => {
    expect(normalizeMoney('150만원(부가세 별도)')).toEqual({ value: 1_500_000, reasons: [] });
    expect(normalizeMoney('150만원 (VAT 포함)')).toEqual({ value: 1_500_000, reasons: [] });
    expect(normalizeMoney('150만원, 부가세 10% 별도')).toEqual({ value: 1_500_000, reasons: [] });
  });

  it('경계: 0원은 0으로 읽는다(말이 안 되는 값인지는 범위 검사가 본다)', () => {
    expect(normalizeMoney('0원')).toEqual({ value: 0, reasons: [] });
  });

  it.each(['8,000위안', '8000元', '¥8000', '$1,200', 'USD 1200', '1200달러', '1200불', '9800엔'])(
    '원이 아닌 돈 %s 은 바꾸지 않고 PARSE_FAILED',
    (raw) => expect(normalizeMoney(raw)).toEqual(FAILED),
  );

  it.each([
    ['150~200만원', '범위'],
    ['정가 200만원, 할인가 150만원', '금액이 둘'],
    ['200만 150만', '단위 순서가 이상함'],
    ['150 280', '단위 없는 숫자가 둘'],
    ['10만명', '돈이 아닌 수'],
    ['추후 안내', '숫자 없음'],
    ['', '빈 글'],
    ['12.5원', '원 아래 소수'],
  ])('%s (%s) 는 PARSE_FAILED', (raw) => {
    expect(normalizeMoney(raw)).toEqual(FAILED);
  });

  it('옆에 붙은 기간·횟수는 금액으로 세지 않는다', () => {
    expect(normalizeMoney('150만원 (1주 기준, 1일 100회)')).toEqual({ value: 1_500_000, reasons: [] });
  });
});

describe('부가세 포함 여부', () => {
  it.each([
    ['부가세 별도', false],
    ['VAT 별도', false],
    ['부가세 미포함', false],
    ['+VAT', false],
    ['不含税', false],
    ['부가세 포함', true],
    ['vat included', true],
  ])('%s → %s', (raw, value) => {
    expect(normalizeField('vat_included', raw)).toEqual({ value, reasons: [] });
  });

  it('표시가 없거나 둘 다 적혔으면 PARSE_FAILED', () => {
    expect(normalizeField('vat_included', '세금')).toEqual(FAILED);
    expect(normalizeField('vat_included', '부가세 포함 또는 별도')).toEqual(FAILED);
  });
});

describe('크기', () => {
  it.each(['7*12(m)', '7m x 12m', '7m×12m', '7mx12m', '７ｍ×１２ｍ', '가로 7m 세로 12m', 'W 7m × H 12m', '7 x 12 미터'])(
    '%s → 가로 7m, 세로 12m',
    (raw) => expect(normalizeSize(raw, 'm')).toEqual({ value: { width: 7, height: 12 }, reasons: [] }),
  );

  it('함정: m·mm 혼용 — mm 로 적힌 것을 m 칸에 넣으면 바꾸고 단위 바꿈을 붙인다', () => {
    expect(normalizeSize('7000x12000mm', 'm')).toEqual({ value: { width: 7, height: 12 }, reasons: CONVERTED });
    expect(normalizeSize('700×1200mm', 'm')).toEqual({ value: { width: 0.7, height: 1.2 }, reasons: CONVERTED });
    expect(normalizeSize('7m x 12m', 'mm')).toEqual({ value: { width: 7000, height: 12000 }, reasons: CONVERTED });
    expect(normalizeSize('5.5cm x 8.5cm', 'mm')).toEqual({ value: { width: 55, height: 85 }, reasons: CONVERTED });
  });

  it('같은 단위면 사유가 없다', () => {
    expect(normalizeSize('700×1200mm', 'mm')).toEqual({ value: { width: 700, height: 1200 }, reasons: [] });
    expect(normalizeSize('크기(mm): 90x130', 'mm')).toEqual({ value: { width: 90, height: 130 }, reasons: [] });
  });

  it('세로를 먼저 적어도 가로·세로 자리를 맞춘다', () => {
    expect(normalizeSize('세로 12m, 가로 7m', 'm').value).toEqual({ width: 7, height: 12 });
    expect(normalizeSize('12m(세로) x 7m(가로)', 'm').value).toEqual({ width: 7, height: 12 });
    expect(normalizeSize('H 12m × W 7m', 'm').value).toEqual({ width: 7, height: 12 });
    expect(normalizeSize('12m x 7m(가로)', 'm').value).toEqual({ width: 7, height: 12 });
  });

  it('m 는 소수 둘째 자리까지, mm 는 정수로 낸다', () => {
    expect(normalizeSize('7.126m x 12.004m', 'm').value).toEqual({ width: 7.13, height: 12 });
    expect(normalizeSize('8.56cm x 5.4cm', 'mm').value).toEqual({ width: 86, height: 54 });
  });

  it('종이 이름만 있으면 치수를 찾아 넣고 단위 바꿈을 붙인다. 치수가 함께 있으면 그것을 읽는다', () => {
    expect(normalizeSize('A4', 'mm')).toEqual({ value: { width: 210, height: 297 }, reasons: CONVERTED });
    expect(normalizeSize('A4 (210×297mm)', 'mm')).toEqual({ value: { width: 210, height: 297 }, reasons: [] });
  });

  it.each([
    ['7x12', '단위가 없음'],
    ['100x200x30mm', '두께까지 셋'],
    ['지름 58mm', '수가 하나'],
    ['1920x1080px', '픽셀'],
    ['55인치', '인치'],
    ['7m 12m', '곱하기 표시도 가로·세로 말도 없음'],
    ['가로 7m 가로 12m', '가로가 둘'],
  ])('%s (%s) 는 PARSE_FAILED', (raw) => {
    expect(normalizeSize(raw, 'm')).toEqual(FAILED);
    expect(normalizeSize(raw, 'mm')).toEqual(FAILED);
  });

  it('해상도는 쌍이 하나일 때만 읽는다', () => {
    expect(normalizeField('resolution_px', '1920 × 1080px')).toEqual({ value: { width: 1920, height: 1080 }, reasons: [] });
    expect(normalizeField('resolution_px', '4K (3840x2160)')).toEqual({ value: { width: 3840, height: 2160 }, reasons: [] });
    expect(normalizeField('resolution_px', 'FHD')).toEqual(FAILED);
    expect(normalizeField('resolution_px', '1920x1080 또는 1080x1920')).toEqual(FAILED);
  });
});

describe('운영 시간', () => {
  const hours = (open: string, close: string, nextDay: boolean) => ({ value: { open, close, nextDay }, reasons: [] });

  it('함정: "05시~25시" → 05:00 ~ 다음 날 01:00', () => {
    expect(normalizeHours('05시~25시')).toEqual(hours('05:00', '01:00', true));
  });

  it('경계: 자정과 24시는 00:00 + 다음 날이다', () => {
    expect(normalizeHours('오전 6시-자정')).toEqual(hours('06:00', '00:00', true));
    expect(normalizeHours('06:00~24:00')).toEqual(hours('06:00', '00:00', true));
    expect(normalizeHours('오전 6시 ~ 밤 12시')).toEqual(hours('06:00', '00:00', true));
    expect(normalizeHours('6am-12am')).toEqual(hours('06:00', '00:00', true));
  });

  it('경계: 23시 59분에 끝나면 같은 날이고, 24시 30분에 끝나면 다음 날이다', () => {
    expect(normalizeHours('06:00~23:59')).toEqual(hours('06:00', '23:59', false));
    expect(normalizeHours('05:30~24:30')).toEqual(hours('05:30', '00:30', true));
  });

  it.each(['24시간', '24시간 운영', '연중무휴 24시간', '00:00~24:00', '종일'])('%s → 00:00 ~ 00:00 다음 날', (raw) => {
    expect(normalizeHours(raw)).toEqual(hours('00:00', '00:00', true));
  });

  it('끝이 시작보다 이르면 다음 날이다', () => {
    expect(normalizeHours('22시~2시')).toEqual(hours('22:00', '02:00', true));
    expect(normalizeHours('06:00 - 익일 02:00')).toEqual(hours('06:00', '02:00', true));
    expect(normalizeHours('새벽 5시부터 다음날 새벽 1시까지')).toEqual(hours('05:00', '01:00', true));
    expect(normalizeHours('오후 10시~2시')).toEqual(hours('22:00', '02:00', true));
  });

  it('오전·오후와 분을 읽는다', () => {
    expect(normalizeHours('오전 10시 ~ 오후 6시')).toEqual(hours('10:00', '18:00', false));
    expect(normalizeHours('10~18시')).toEqual(hours('10:00', '18:00', false));
    expect(normalizeHours('10시 30분 ~ 18시반')).toEqual(hours('10:30', '18:30', false));
    expect(normalizeHours('오후 2시~6시')).toEqual(hours('14:00', '18:00', false));
    expect(normalizeHours('오후 6시~12시')).toEqual(hours('18:00', '00:00', true));
    expect(normalizeHours('운영시간: 06:00~24:00 (연중무휴)')).toEqual(hours('06:00', '00:00', true));
  });

  it('경계: 시작과 끝이 같은 시각이면 24시간이다. 오후 12시는 낮 12시다', () => {
    expect(normalizeHours('06:00~06:00')).toEqual(hours('06:00', '06:00', true));
    expect(normalizeHours('오후 12시~오후 6시')).toEqual(hours('12:00', '18:00', false));
    expect(normalizeHours('오전 12시~오전 6시')).toEqual(hours('00:00', '06:00', false));
  });

  it('24시를 넘겨 30시까지 적힌 것은 그대로 읽는다(24시간 초과는 범위 검사가 잡는다)', () => {
    expect(normalizeHours('05시~30시')).toEqual(hours('05:00', '06:00', true));
  });

  it.each([
    ['9시~6시', '오후 6시인지 다음 날 6시인지 모름'],
    ['오전 10시~6시', '위와 같음'],
    ['10-18', '시각이라는 표시가 없음'],
    ['평일 10~18시, 주말 10~17시', '시간대가 둘'],
    ['첫차~막차', '숫자 없음'],
    ['05시~50시', '48시를 넘음'],
    ['25시~30시', '시작이 24시를 넘음'],
    ['10시 70분~18시', '분이 60 이상'],
    ['오전 14시~18시', '오전 14시'],
    ['24시간 (단, 01시~05시 점검)', '24시간과 다른 시간대가 함께'],
    ['2시간', '시각이 아니라 길이'],
  ])('%s (%s) 는 PARSE_FAILED', (raw) => {
    expect(normalizeHours(raw)).toEqual(FAILED);
  });
});

describe('유동인구', () => {
  it('함정: 월 유동인구 → 30으로 나눠 하루로 바꾸고 단위 바꿈을 붙인다', () => {
    expect(normalizeFootfall('월 300만명')).toEqual({ value: 100_000, reasons: CONVERTED });
    expect(normalizeFootfall('월 유동인구 300만명')).toEqual({ value: 100_000, reasons: CONVERTED });
    expect(normalizeFootfall('유동인구(월): 300만')).toEqual({ value: 100_000, reasons: CONVERTED });
  });

  it('주는 7로, 연은 365로 나눈다. 소수는 반올림', () => {
    expect(normalizeFootfall('주 70만명')).toEqual({ value: 100_000, reasons: CONVERTED });
    expect(normalizeFootfall('연간 3,650만명')).toEqual({ value: 100_000, reasons: CONVERTED });
    expect(normalizeFootfall('월 100만명')).toEqual({ value: 33_333, reasons: CONVERTED });
    expect(normalizeFootfall('월 50명')).toEqual({ value: 2, reasons: CONVERTED });
  });

  it('하루 기준이면 그대로이고 사유가 없다', () => {
    expect(normalizeFootfall('일 평균 10만명')).toEqual({ value: 100_000, reasons: [] });
    expect(normalizeFootfall('하루 12만 명')).toEqual({ value: 120_000, reasons: [] });
    expect(normalizeFootfall('일평균 유동인구 약 150,000명')).toEqual({ value: 150_000, reasons: [] });
  });

  it.each([
    ['유동인구 10만명', '기준(하루·월)이 없음'],
    ['10~12만명', '범위'],
    ['월 300만명 (일 10만명)', '기준이 둘'],
    ['매우 많음', '숫자 없음'],
    ['월 또는 주 70만명', '기준이 둘, 수는 하나'],
  ])('%s (%s) 는 PARSE_FAILED', (raw) => {
    expect(normalizeFootfall(raw)).toEqual(FAILED);
  });
});

describe('기간 옵션', () => {
  it('함정: 기간별 값표 "1주 150 2주 280" → (7일, 150만원), (14일, 280만원)', () => {
    expect(normalizePeriodOptions('1주 150 2주 280')).toEqual({
      value: [
        { days: 7, price_krw: 1_500_000 },
        { days: 14, price_krw: 2_800_000 },
      ],
      reasons: CONVERTED,
    });
  });

  it.each(['1주 150만원 / 2주 280만원', '1주: 150만원, 2주: 280만원', '1주\t150만원\n2주\t280만원', '150만원/1주, 280만원/2주', '7일 1,500,000원 / 14일 2,800,000원'])(
    '%j 를 같은 표로 읽는다',
    (raw) => {
      expect(normalizePeriodOptions(raw)).toEqual({
        value: [
          { days: 7, price_krw: 1_500_000 },
          { days: 14, price_krw: 2_800_000 },
        ],
        reasons: [],
      });
    },
  );

  it('일수가 작은 것부터 적는다', () => {
    expect(normalizePeriodOptions('4주 500만원, 1주 150만원').value).toEqual([
      { days: 7, price_krw: 1_500_000 },
      { days: 28, price_krw: 5_000_000 },
    ]);
  });

  it('1개월은 30일로 바꾸고 단위 바꿈을 붙인다. 같은 기간을 두 번 적은 것은 하나로 읽는다', () => {
    expect(normalizePeriodOptions('1개월 500만원')).toEqual({ value: [{ days: 30, price_krw: 5_000_000 }], reasons: CONVERTED });
    expect(normalizePeriodOptions('4주(28일) 500만원')).toEqual({ value: [{ days: 28, price_krw: 5_000_000 }], reasons: [] });
  });

  it.each([
    ['150만원', '기간이 없음'],
    ['1주 150만원 2주 문의', '금액 하나를 못 읽음'],
    ['1주 150만원, 1주 160만원', '같은 기간에 값이 둘'],
    ['4주(30일) 500만원', '기간 표기가 서로 다름'],
    ['1주 150만원 (정가 200만원)', '한 기간에 금액이 둘'],
  ])('%s (%s) 는 통째로 PARSE_FAILED', (raw) => {
    expect(normalizePeriodOptions(raw)).toEqual(FAILED);
  });

  it('수량 옵션도 같은 방식으로 읽는다', () => {
    expect(normalizeField('quantity_options', '200잔 150만원 / 100잔 기준 80만원')).toEqual({
      value: [
        { qty: 100, price_krw: 800_000 },
        { qty: 200, price_krw: 1_500_000 },
      ],
      reasons: [],
    });
    expect(normalizeField('quantity_options', '80만원')).toEqual(FAILED);
  });
});

describe('날짜 수', () => {
  it.each([
    ['2주 전까지', 14],
    ['최소 2주 전', 14],
    ['10일', 10],
    ['게재 7일 전', 7],
    ['일주일 전', 7],
    ['D-7', 7],
    ['3영업일', 3],
    ['2 weeks', 14],
  ])('%s → %d일', (raw, days) => {
    expect(normalizeDays(raw)).toEqual({ value: days, reasons: [] });
  });

  it('1개월은 30일, 48시간은 2일로 바꾸고 단위 바꿈을 붙인다', () => {
    expect(normalizeDays('1개월 전')).toEqual({ value: 30, reasons: CONVERTED });
    expect(normalizeDays('48시간 전')).toEqual({ value: 2, reasons: CONVERTED });
  });

  it.each([
    ['7~10일', '범위'],
    ['10월 10일까지', '날짜'],
    ['36시간', '하루 단위로 안 떨어짐'],
    ['당일', '숫자 없음'],
    ['1주 또는 10일', '기간이 둘'],
    ['일주일 또는 보름', '기간이 둘(숫자 없이)'],
  ])('%s (%s) 는 PARSE_FAILED', (raw) => {
    expect(normalizeDays(raw)).toEqual(FAILED);
  });
});

describe('그 밖의 칸', () => {
  it('글자 칸은 앞뒤 공백만 뗀다', () => {
    expect(normalizeField('name', '  강남역 대형 전광판 ')).toEqual({ value: '강남역 대형 전광판', reasons: [] });
    expect(normalizeField('name', '   ')).toEqual(FAILED);
  });

  it('한 번 길이: 초는 그대로, 분은 초로 바꾼다', () => {
    expect(normalizeField('spot_seconds', '15초')).toEqual({ value: 15, reasons: [] });
    expect(normalizeField('spot_seconds', '1분 30초')).toEqual({ value: 90, reasons: CONVERTED });
    expect(normalizeField('spot_seconds', '15~30초')).toEqual(FAILED);
  });

  it('하루 송출 횟수: 시간당·월 기준은 하루로 바꿀 근거가 없어 PARSE_FAILED', () => {
    expect(normalizeField('plays_per_day', '하루 100회 이상')).toEqual({ value: 100, reasons: [] });
    expect(normalizeField('plays_per_day', '1일 1,200회')).toEqual({ value: 1200, reasons: [] });
    expect(normalizeField('plays_per_day', '시간당 6회')).toEqual(FAILED);
    expect(normalizeField('plays_per_day', '월 3,000회')).toEqual(FAILED);
  });

  it('최소 주문 수량', () => {
    expect(normalizeField('min_order_qty', '최소 50개')).toEqual({ value: 50, reasons: [] });
    expect(normalizeField('min_order_qty', '1천개')).toEqual({ value: 1000, reasons: [] });
    expect(normalizeField('min_order_qty', '50~100개')).toEqual(FAILED);
    expect(normalizeField('min_order_qty', '50개 또는 100개')).toEqual(FAILED);
  });

  it('파일 형식은 아는 확장자만 소문자로, 순서대로', () => {
    expect(normalizeField('file_format', 'PNG, JPG / .mp4')).toEqual({ value: ['jpg', 'mp4', 'png'], reasons: [] });
    expect(normalizeField('file_format', 'MP4 (H.264)')).toEqual({ value: ['mp4'], reasons: [] });
    expect(normalizeField('file_format', '담당자와 협의')).toEqual(FAILED);
  });
});
