// 모으기의 판단: 받은 줄의 꼴 다시 보기, 갈래 맞추기, 줄 → 원문 글 → 본체의 맞추기·따지기.
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@/contract/api';
import type { CollectedItem } from '@/contract/tools/collect';
import { evaluateDraft } from '@/core';
import { adSubtypeOf, checkImportRow, itemToExtraction, itemToSourceText } from './index';

const ROW = {
  line: 3, kind: '전광판', name: '홍대입구역 9번 출구 전광판', region: '서울 마포구', address: '서울 마포구 양화로 160',
  subway_line: '2호선', station: '홍대입구역', media_type: 'LED 전광판', width_m: 7, height_m: 12, quantity: 1,
  lat: 37.557, lng: 126.924, operator: '가상 운영 기관', raw: { 명칭: '홍대입구역 9번 출구 전광판', 규격: '7m x 12m' }, flags: ['unit_assumed'],
};

const item = (over: Partial<CollectedItem> = {}): CollectedItem => ({
  id: 101, batchId: 12, sourceId: 'sample-outdoor-2026', sourceName: '가상 기관 옥외광고 현황', line: 3,
  kind: '전광판', name: '홍대입구역 9번 출구 전광판', region: '서울 마포구', address: '서울 마포구 양화로 160',
  subwayLine: '2호선', station: '홍대입구역', mediaType: 'LED 전광판', widthM: 7, heightM: 12, quantity: 1,
  lat: 37.557, lng: 126.924, operator: '가상 운영 기관', raw: { 명칭: '홍대입구역 9번 출구 전광판', 규격: '7m x 12m' },
  flags: ['unit_assumed'], draftId: null, createdAt: '2026-10-12T03:00:05.000Z', ...over,
});

const message = (input: unknown): string => {
  const got = checkImportRow(input);
  return got.ok ? '(받음)' : got.message;
};

describe('받은 줄 다시 보기', () => {
  it('문서의 보기 줄을 받는다. 열쇠와 표시는 약속의 식 그대로다', () => {
    const got = checkImportRow(ROW);
    expect(got).toMatchObject({ ok: true, dedupeKey: '서울마포구양화로160|2호선|홍대입구역|led전광판|7|12|', flags: ['unit_assumed'] });
  });

  it('없는 값은 null 로 맞춘다. 칸을 뺀 것과 null 로 준 것이 같다', () => {
    const got = checkImportRow({ line: 1, name: '가 전광판', station: null, raw: {} });
    expect(got).toMatchObject({
      ok: true, dedupeKey: '||||||가전광판', flags: ['no_location', 'no_size'],
      row: { name: '가 전광판', station: null, address: null, width_m: null, quantity: null, lat: null },
    });
  });

  it('수집기의 표시는 겹쳐 와도 한 번, 약속의 순서로 적는다', () => {
    const got = checkImportRow({ ...ROW, name: null, width_m: 120, flags: ['unit_assumed', 'encoding_guessed'] });
    expect(got).toMatchObject({ ok: true, flags: ['encoding_guessed', 'unit_assumed', 'no_name', 'odd_size'] });
    expect(message({ ...ROW, flags: ['unit_assumed', 'unit_assumed', 'unit_assumed'] })).toContain('표시(flags)');
  });

  it('글자로 온 수, 빈 글자, 범위 밖의 수는 받지 않는다. 어느 칸인지 말해 준다', () => {
    expect(message({ ...ROW, width_m: '7' })).toBe('가로(width_m) 칸의 꼴이 틀렸습니다. 0보다 큰 수(m 단위)여야 합니다.');
    expect(message({ ...ROW, height_m: 0 })).toContain('세로(height_m)');
    expect(message({ ...ROW, name: '' })).toContain('이름(name)');
    expect(message({ ...ROW, name: 'ㄱ'.repeat(201) })).toContain('이름(name)');
    expect(message({ ...ROW, quantity: 1.5 })).toContain('수량(quantity)');
    expect(message({ ...ROW, quantity: -1 })).toContain('수량(quantity)');
    expect(message({ ...ROW, lat: 91 })).toContain('위도(lat)');
    expect(message({ ...ROW, line: 0 })).toContain('줄 번호(line)');
    expect(message({ ...ROW, raw: undefined })).toContain('원래 줄(raw)');
    expect(message({ ...ROW, raw: { 칸: { 속: 1 } } })).toContain('원래 줄(raw)');
  });

  it('수량 0 은 받는다(약속의 꼴이 0 이상이다)', () => {
    expect(checkImportRow({ ...ROW, quantity: 0 })).toMatchObject({ ok: true, row: { quantity: 0 } });
  });

  it('표에 없는 칸 이름이 있으면 받지 않는다. 값은 오류 글에 싣지 않는다', () => {
    const text = message({ ...ROW, price: '비밀 값', memo: 'x' });
    expect(text).toBe('표에 없는 칸 이름이 있습니다: price, memo.');
    expect(text).not.toContain('비밀 값');
  });

  it('묶음이 아닌 줄, 가를 값이 하나도 없는 줄, 너무 긴 원래 줄은 받지 않는다', () => {
    expect(message('글자')).toBe('줄이 칸 이름과 값의 묶음이 아닙니다.');
    expect(message(null)).toBe('줄이 칸 이름과 값의 묶음이 아닙니다.');
    expect(message([ROW])).toBe('줄이 칸 이름과 값의 묶음이 아닙니다.');
    expect(message({ line: 1, quantity: 3, operator: '가상 운영 기관', raw: {} })).toContain('가를 값');
    expect(message({ ...ROW, raw: { 긴칸: 'ㄱ'.repeat(4000) } })).toContain('너무 깁니다');
  });

  it('DB 가 못 받는 글자와 제어 글자를 정리한다. 정리하고 비면 없는 값이다', () => {
    const got = checkImportRow({ ...ROW, name: '가\u0000나\t\n 다', operator: '\u0001', raw: { '칸\u0000': '값\u0000\ud800' } });
    expect(got).toMatchObject({ ok: true, row: { name: '가 나 다', operator: null, raw: { 칸: '값�' } } });
  });
});

describe('갈래 맞추기', () => {
  it('매체 종류의 말로 광고 갈래 셋 가운데 하나를 고른다. 매체 종류에 없으면 종류를 본다', () => {
    expect(adSubtypeOf('LED 전광판', null)).toBe('전광판');
    expect(adSubtypeOf('스크린도어', '지하철 광고')).toBe('지하철');
    expect(adSubtypeOf('버스 쉘터 광고', null)).toBe('버스');
    expect(adSubtypeOf('조명광고', '지하철 광고')).toBe('지하철');
    expect(adSubtypeOf(null, '전광판')).toBe('전광판');
  });

  it('두 갈래의 말이 함께 있거나 하나도 없으면 자료의 말을 그대로 둔다. 없거나 너무 길면 null', () => {
    expect(adSubtypeOf('지하철 역사 전광판', '버스')).toBe('지하철 역사 전광판');
    expect(adSubtypeOf('현수막 게시대', '옥외광고')).toBe('현수막 게시대');
    expect(adSubtypeOf(null, null)).toBeNull();
    expect(adSubtypeOf('ㄱ'.repeat(61), null)).toBeNull();
  });
});

describe('줄 → 원문 글 → 초안의 칸', () => {
  it('값이 있는 칸을 이름표와 함께 한 줄씩 적는다. 첫 줄에 번호 셋이 있다', () => {
    const lines = itemToSourceText(item()).split('\n');
    expect(lines[0]).toBe('[모은 줄 #101] 출처 sample-outdoor-2026 · 3번째 줄');
    expect(lines).toContain('이름: 홍대입구역 9번 출구 전광판');
    expect(lines).toContain('역: 홍대입구역');
    expect(lines).toContain('크기: 7x12m');
    expect(lines).toContain('좌표: 37.557, 126.924');
    expect(lines).toContain('원래 칸 규격: 7m x 12m');
    expect(itemToSourceText(item({ id: 102 }))).not.toBe(itemToSourceText(item()));
  });

  it('없는 값은 줄을 만들지 않는다. 크기는 가로·세로가 다 있을 때만 적는다', () => {
    const text = itemToSourceText(item({ station: null, widthM: 7, heightM: null, quantity: null, lat: null, operator: null }));
    expect(text).not.toMatch(/^역: /m);
    expect(text).not.toMatch(/^크기: /m);
    expect(text).not.toMatch(/^수량: /m);
    expect(text).not.toMatch(/^좌표: /m);
    expect(text).not.toMatch(/^운영 기관: /m);
  });

  it('값 안의 줄바꿈은 빈칸이 된다(값이 이름표 줄을 흉내 내지 못한다)', () => {
    const text = itemToSourceText(item({ kind: '전광판\n이름: 가짜 이름', raw: {} }));
    expect(text.split('\n').filter((l) => l.startsWith('이름: '))).toEqual(['이름: 홍대입구역 9번 출구 전광판']);
  });

  it('원래 줄이 길어도 본체의 글 길이 상한을 넘지 않는다. 줄였다고 적는다', () => {
    const raw = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`칸${i}`, 'ㄱ'.repeat(330)]));
    const text = itemToSourceText(item({ raw }));
    expect([...text].length).toBeLessThanOrEqual(LIMITS.textMaxChars);
    expect(text).toContain('글이 길어 줄였습니다');
  });

  it('본체의 맞추기·따지기를 거치면 이름·위치·크기가 읽히고, 값이 없는 필수 칸은 "필수 칸 빔"이다', () => {
    const text = itemToSourceText(item());
    const extraction = itemToExtraction(item(), text);
    expect(extraction).toMatchObject({ type: 'ad', subtype: '전광판' });
    expect(extraction.fields).toEqual([
      { field: 'name', raw: '홍대입구역 9번 출구 전광판', value: null, evidence: '이름: 홍대입구역 9번 출구 전광판' },
      { field: 'region', raw: '홍대입구역', value: null, evidence: '역: 홍대입구역' },
      { field: 'size_m', raw: '7x12m', value: null, evidence: '크기: 7x12m' },
    ]);

    const evaluation = evaluateDraft({ sourceText: text, extraction, extractedBy: 'import' });
    const of = (key: string) => evaluation.fields.find((f) => f.field === key);
    expect(of('name')).toMatchObject({ finalValue: '홍대입구역 9번 출구 전광판', modelValue: null, reasons: [] });
    expect(of('region')).toMatchObject({ finalValue: '홍대입구역', reasons: [] });
    expect(of('size_m')).toMatchObject({ finalValue: { width: 7, height: 12 }, reasons: [] });
    for (const key of ['price_krw', 'hours', 'footfall_per_day', 'period_options']) expect(of(key)).toMatchObject({ finalValue: null, reasons: ['REQUIRED_MISSING'] });
    expect(evaluation.draftReasons).toEqual([]);
    expect(evaluation.route).toBe('NEEDS_REVIEW');
  });

  it('역이 없으면 지역을, 지역도 없으면 주소를 위치로 쓴다. 소수 크기도 읽힌다', () => {
    const noStation = item({ station: null, widthM: 7.5, heightM: 3.25 });
    const text = itemToSourceText(noStation);
    const extraction = itemToExtraction(noStation, text);
    expect(extraction.fields.find((f) => f.field === 'region')).toMatchObject({ raw: '서울 마포구', evidence: '지역: 서울 마포구' });
    const evaluation = evaluateDraft({ sourceText: text, extraction, extractedBy: 'import' });
    expect(evaluation.fields.find((f) => f.field === 'size_m')).toMatchObject({ finalValue: { width: 7.5, height: 3.25 }, reasons: [] });

    const onlyAddress = item({ station: null, region: null });
    expect(itemToExtraction(onlyAddress, itemToSourceText(onlyAddress)).fields.find((f) => f.field === 'region')?.raw).toBe('서울 마포구 양화로 160');
  });

  it('갈래를 못 맞추면 "종류·갈래 불일치"가 붙고, 없는 칸은 뽑은 칸에서 빠진다', () => {
    const bare = item({ name: null, station: null, region: null, address: null, widthM: null, heightM: null, kind: '옥외광고', mediaType: '현수막 게시대' });
    const text = itemToSourceText(bare);
    const extraction = itemToExtraction(bare, text);
    expect(extraction).toMatchObject({ subtype: '현수막 게시대', fields: [] });
    const evaluation = evaluateDraft({ sourceText: text, extraction, extractedBy: 'import' });
    expect(evaluation.draftReasons).toEqual(['TYPE_SUBTYPE_MISMATCH']);
    expect(evaluation.fields.find((f) => f.field === 'name')?.reasons).toEqual(['REQUIRED_MISSING']);
  });
});
