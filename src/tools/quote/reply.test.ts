import { describe, expect, it } from 'vitest';
import type { GlossaryEntry } from '@/contract/content';
import type { QuoteCandidate, QuoteReplyInput } from '@/contract/tools/quote';
import {
  askReply,
  checkReply,
  fillReply,
  formatDate,
  formatTotal,
  hasLeftoverPlaceholder,
  localText,
  placeholdersOf,
  replyInputOf,
  replyRetryHint,
  replyValues,
  templateReply,
  vatNote,
} from './reply';

const GLOSSARY: GlossaryEntry[] = [
  { ko: '전광판', en: 'digital billboard', 'zh-Hans': '电子屏' },
  { ko: '합정역', en: 'Hapjeong Station', 'zh-Hans': '合井站' },
  { ko: '커피차', en: 'coffee truck', 'zh-Hans': '咖啡车' },
];

const BILLBOARD: QuoteCandidate = {
  productId: 1, name: '합정역 전광판', type: 'ad', subtype: '전광판', region: '합정역 7번출구', matched: ['type'],
  pricing: { basis: 'period_option', days: 14, qty: null, unitKrw: 2_800_000, totalKrw: 2_800_000, exact: true, vatIncluded: false },
  schedule: {
    startDate: '2027-05-01',
    deadlines: [
      { kind: 'material', field: 'material_deadline_days', days: 14, date: '2027-04-17', daysLeft: 187, status: 'open' },
      { kind: 'booking', field: 'booking_deadline_days', days: 7, date: '2027-04-24', daysLeft: 194, status: 'open' },
    ],
  },
};
const TRUCK: QuoteCandidate = {
  productId: 3, name: '달보드레 커피차', type: 'catering', subtype: '커피차', region: '서울, 경기 남부', matched: [],
  pricing: { basis: 'quantity_option', days: null, qty: 200, unitKrw: 1_500_000, totalKrw: 1_500_000, exact: true, vatIncluded: true },
  schedule: { startDate: null, deadlines: [] },
};

const input = (lang: QuoteReplyInput['lang'], candidate: QuoteCandidate | null, count = 1): QuoteReplyInput =>
  replyInputOf({ lang, inquiry: '문의', candidate, candidateCount: count, glossary: GLOSSARY });

describe('자리표시에 넣을 값', () => {
  it('센 것만 들어간다', () => {
    expect(replyValues(BILLBOARD)).toEqual({
      total: 2_800_000, days: 14, start_date: '2027-05-01', booking_deadline: '2027-04-24', material_deadline: '2027-04-17',
    });
    expect(replyValues(TRUCK)).toEqual({ total: 1_500_000, qty: 200 });
    expect(replyValues(null)).toEqual({});
  });
  it('써도 되는 자리표시는 값이 있는 것만, 약속한 순서로', () => {
    expect(placeholdersOf(replyValues(BILLBOARD))).toEqual(['total', 'days', 'start_date', 'booking_deadline', 'material_deadline']);
    expect(placeholdersOf({})).toEqual([]);
  });
});

describe('서식', () => {
  it('금액과 날짜는 언어마다 다르다', () => {
    expect([formatTotal(3_000_000, 'ko'), formatTotal(3_000_000, 'en'), formatTotal(3_000_000, 'zh-Hans')]).toEqual(['3,000,000원', 'KRW 3,000,000', '3,000,000韩元']);
    expect([formatDate('2027-05-01', 'ko'), formatDate('2027-05-01', 'en'), formatDate('2027-05-01', 'zh-Hans')]).toEqual(['2027년 5월 1일', 'May 1, 2027', '2027年5月1日']);
    expect(formatDate('내일', 'ko')).toBe('내일');
  });
  it('부가세는 더하지 않고 표시만 한다. 모르면 아무것도 붙이지 않는다', () => {
    expect(vatNote(false, 'ko')).toBe(' (부가세 별도)');
    expect(vatNote(true, 'en')).toBe(' (VAT included)');
    expect(vatNote(null, 'ko')).toBe('');
    expect(fillReply('총액은 {total}입니다.', { total: 1_500_000 }, 'ko', { vatIncluded: false })).toBe('총액은 1,500,000원 (부가세 별도)입니다.');
    expect(fillReply('Total: {total}.', { total: 1_500_000 }, 'en', { vatIncluded: null })).toBe('Total: KRW 1,500,000.');
    expect(fillReply('总价为{total}。', { total: 1_500_000 }, 'zh-Hans', { vatIncluded: false })).toBe('总价为1,500,000韩元（不含增值税）。');
  });
  it('총액이 두 번 나와도 부가세 표시는 한 번만', () => {
    expect(fillReply('{total} / {total}', { total: 900 }, 'ko', { vatIncluded: true })).toBe('900원 (부가세 포함) / 900원');
  });
  it('모든 자리표시를 넣는다', () => {
    const text = fillReply('{total}, {days} days from {start_date}. Book by {booking_deadline}, files by {material_deadline}.', replyValues(BILLBOARD), 'en');
    expect(text).toBe('KRW 2,800,000, 14 days from May 1, 2027. Book by April 24, 2027, files by April 17, 2027.');
    expect(hasLeftoverPlaceholder(text)).toBe(false);
  });
  it('값이 없는 자리표시와 모르는 자리표시는 그대로 둔다. 숫자를 지어내지 않는다', () => {
    const text = fillReply('{total} {qty} {design_deadline} {price}', { total: 0, qty: 1.5 }, 'ko');
    expect(text).toBe('{total} {qty} {design_deadline} {price}');
    expect(hasLeftoverPlaceholder(text)).toBe(true);
    expect(hasLeftoverPlaceholder('｛total｝')).toBe(true);
  });
  it('모델이 총액 앞뒤에 통화 표시를 또 적었으면 겹치지 않게 뺀다', () => {
    expect(fillReply('₩{total} 입니다', { total: 5000 }, 'ko')).toBe('5,000원 입니다');
    expect(fillReply('{total}원입니다', { total: 5000 }, 'ko')).toBe('5,000원입니다');
    expect(fillReply('KRW {total} in total', { total: 5000 }, 'en')).toBe('KRW 5,000 in total');
    expect(fillReply('{total} won.', { total: 5000 }, 'en')).toBe('KRW 5,000.');
  });
  it('"원"으로 시작하는 낱말은 깨지 않는다. 조사 꼴만 뗀다', () => {
    expect(fillReply('총액은 {total} 원래 가격 그대로입니다.', { total: 900_000 }, 'ko', { vatIncluded: false })).toBe('총액은 900,000원 (부가세 별도) 원래 가격 그대로입니다.');
    expect(fillReply('{total}원에 드립니다', { total: 5000 }, 'ko')).toBe('5,000원에 드립니다');
    expect(fillReply('{total} 원으로 안내드립니다', { total: 5000 }, 'ko')).toBe('5,000원으로 안내드립니다');
  });
  it('중국어의 "元"도 떼고, 통화 낱말이 겹쳐 있으면 모두 뗀다', () => {
    expect(fillReply('总价：{total}元', { total: 900_000 }, 'zh-Hans')).toBe('总价：900,000韩元');
    expect(fillReply('总价：{total} 韩元。', { total: 900_000 }, 'zh-Hans')).toBe('总价：900,000韩元。');
    expect(fillReply('The price is ₩{total} KRW won.', { total: 900_000 }, 'en')).toBe('The price is KRW 900,000.');
    expect(fillReply('KRW ₩{total}', { total: 900_000 }, 'en')).toBe('KRW 900,000');
  });
});

describe('틀 문장', () => {
  it('한국어: 써도 되는 자리표시만 쓰고, 글 검사를 통과한다', () => {
    const facts = input('ko', BILLBOARD, 2);
    const text = templateReply(facts);
    expect(text).toContain('상품: 합정역 전광판 (합정역 7번출구)');
    expect(text).toContain('총액: {total}, 기간 {days}일');
    expect(text).toContain('예약 마감: {booking_deadline}');
    expect(text).toContain('소재 마감: {material_deadline}');
    expect(text).toContain('다른 상품도 있습니다');
    expect(text).not.toContain('{qty}');
    expect(checkReply(text, facts)).toEqual([]);
    expect(hasLeftoverPlaceholder(fillReply(text, replyValues(BILLBOARD), 'ko', { vatIncluded: false }))).toBe(false);
  });
  it('날짜 조건이 없던 케이터링: 수량만 쓰고 날짜 줄은 없다', () => {
    const facts = input('ko', TRUCK);
    const text = templateReply(facts);
    expect(text).toContain('총액: {total}, 수량 {qty}');
    expect(text).not.toMatch(/start_date|deadline|다른 상품/);
    expect(checkReply(text, facts)).toEqual([]);
  });
  it('영어·중국어: 이름과 지역의 용어집 낱말은 그 표기로 바꾼다. 용어집에 없는 한글이 남으면 검사가 알린다', () => {
    const en = input('en', BILLBOARD);
    expect(templateReply(en)).toContain('Product: Hapjeong Station digital billboard (Hapjeong Station 7번출구)');
    expect(checkReply(templateReply(en), en)).toEqual(['HANGUL_IN_TEXT']);
    const zh = input('zh-Hans', { ...BILLBOARD, region: '합정역' });
    expect(templateReply(zh)).toContain('产品：合井站电子屏（合井站）');
    expect(checkReply(templateReply(zh), zh)).toEqual([]);
  });
  it('맞는 상품이 없으면 찾지 못했다는 글이고 자리표시가 없다', () => {
    for (const lang of ['ko', 'en', 'zh-Hans'] as const) {
      const facts = input(lang, null);
      const text = templateReply(facts);
      expect(facts).toMatchObject({ product: null, placeholders: [], hasAlternatives: false });
      expect(hasLeftoverPlaceholder(text)).toBe(false);
      expect(checkReply(text, facts)).toEqual([]);
    }
    expect(templateReply(input('ko', null))).toContain('찾지 못했습니다');
  });
  it('되묻는 글: 세 언어 모두 자리표시가 없고 글 검사를 통과한다', () => {
    for (const lang of ['ko', 'en', 'zh-Hans'] as const) {
      const text = askReply(lang);
      expect(hasLeftoverPlaceholder(text)).toBe(false);
      expect(checkReply(text, input(lang, null))).toEqual([]);
    }
    expect(askReply('ko')).toContain('어떤 상품을 찾으시는지');
  });
  it('한국어 답장의 입력에는 용어집을 넣지 않는다', () => {
    expect(input('ko', BILLBOARD).glossary).toEqual([]);
    expect(input('en', BILLBOARD).glossary).toEqual(GLOSSARY);
  });
  it('용어집 낱말 바꾸기: 긴 낱말부터, 한국어는 그대로', () => {
    expect(localText('합정역 전광판', GLOSSARY, 'ko')).toBe('합정역 전광판');
    expect(localText('합정역 전광판', GLOSSARY, 'en')).toBe('Hapjeong Station digital billboard');
    expect(localText('달보드레 커피차', GLOSSARY, 'zh-Hans')).toBe('달보드레 咖啡车');
  });
});

describe('답장의 글 검사', () => {
  const en = input('en', BILLBOARD);
  const good = 'Thank you for reaching out. We suggest the Hapjeong Station digital billboard at Hapjeong Station Exit 7. The total comes to {total} for {days} days, starting {start_date}. Please book by {booking_deadline} and send your files by {material_deadline}.';
  it('통과하는 글', () => {
    expect(checkReply(good, en)).toEqual([]);
  });
  it('총액 자리표시가 빠졌으면 걸린다', () => {
    expect(checkReply(good.replace('{total}', 'a fair price'), en)).toEqual(['PLACEHOLDER_LOST']);
  });
  it('써도 되는 목록에 없는 자리표시·본체의 자리표시·깨진 중괄호는 걸린다', () => {
    expect(checkReply(`${good} Quantity {qty}.`, en)).toEqual(['PLACEHOLDER_LOST']);
    expect(checkReply(`${good} From {price}.`, en)).toEqual(['PLACEHOLDER_LOST']);
    expect(checkReply(`${good} {total`, en)).toEqual(['PLACEHOLDER_LOST']);
  });
  it('자리표시 밖의 숫자는 걸린다. 이름·지역에 원래 있는 숫자는 봐준다', () => {
    expect(checkReply(`${good} That is within your 3,000,000 budget.`, en)).toEqual(['STRAY_NUMBER']);
    expect(checkReply(good.replace('{start_date}', 'May 1'), en)).toEqual(['STRAY_NUMBER']);
    expect(checkReply(good, en)).not.toContain('STRAY_NUMBER'); // "Exit 7" 의 7 은 지역에 있다
  });
  it('말로 쓴 숫자도 걸린다: 영어 낱말, 한자 숫자, 한글 숫자, 로마 숫자, 아라비아 문자 숫자', () => {
    const zh = input('zh-Hans', { ...BILLBOARD, region: '합정역' });
    const ko = input('ko', BILLBOARD);
    expect(checkReply(`${good} That is about three million won for fourteen days, starting on the first of December.`, en)).toEqual(['STRAY_NUMBER']);
    expect(checkReply(`${good} It runs for fourteen days.`, en)).toEqual(['STRAY_NUMBER']);
    expect(checkReply(`${good} It starts on December first.`, en)).toEqual(['STRAY_NUMBER']);
    expect(checkReply('合井站电子屏，总价：{total}，约二百六十万韩元，共十四天。', zh)).toEqual(['STRAY_NUMBER']);
    expect(checkReply('合井站电子屏，总价：{total}，三月开始。', zh)).toEqual(['STRAY_NUMBER']);
    expect(checkReply('총액 {total}입니다. 삼백만 원 정도입니다.', ko)).toEqual(['STRAY_NUMBER']);
    expect(checkReply('총액 {total}입니다. 기간은 열흘입니다.', ko)).toEqual(['STRAY_NUMBER']);
    expect(checkReply(`${good} Ⅻ payments.`, en)).toEqual(['STRAY_NUMBER']);
    expect(checkReply(`${good} ٣ days.`, en)).toEqual(['STRAY_NUMBER']);
    expect(checkReply(`${good} XIV days.`, en)).toEqual(['STRAY_NUMBER']);
  });
  it('수 낱말처럼 보여도 값이 아닌 말은 걸리지 않는다', () => {
    expect(checkReply(`${good} This one is the first option we would suggest, and you may first want to check the size.`, en)).toEqual([]);
    expect(checkReply('문의 감사합니다. 총액은 {total}입니다. 만일 일정이 바뀌면 이 상품 대신 다른 상품을 안내드리겠습니다.', input('ko', BILLBOARD))).toEqual([]);
    expect(checkReply('合井站电子屏，总价：{total}。请确认一下，我们十分感谢。', input('zh-Hans', { ...BILLBOARD, region: '합정역' }))).toEqual([]);
  });
  it('이름·지역의 숫자를 다른 뜻으로 쓰면 걸린다. 이름·지역 표기 안에서와, 단위 없이 쓴 자리에서만 봐준다', () => {
    // 지역 "합정역 7번출구"의 7 을 기간으로 썼다.
    expect(checkReply(good.replace('{days} days', '7 days'), en)).toEqual(['STRAY_NUMBER']);
    expect(checkReply(`${good} That is KRW 7 per view.`, en)).toEqual(['STRAY_NUMBER']);
    expect(checkReply('합정역 전광판 (합정역 7번출구) 총액 {total}, 기간 7일입니다.', input('ko', BILLBOARD))).toEqual(['STRAY_NUMBER']);
    // 지역의 숫자를 그 언어로 옮겨 적은 것("7번출구" → "7号出口", "Exit 7")은 값이 아니다. 날짜로 쓴 "7号"는 값이다.
    const zh = input('zh-Hans', BILLBOARD);
    expect(checkReply('合井站电子屏，位于合井站7号出口附近，总价为{total}。', zh)).toEqual([]);
    expect(checkReply('合井站电子屏，总价为{total}，7号开始。', zh)).toEqual(['STRAY_NUMBER']);
    // 표기가 글자 그대로 들어간 자리의 숫자는 본다("7번출구"). 틀 문장이 그렇게 쓴다.
    expect(checkReply('합정역 전광판 (합정역 7번출구) 총액 {total}, 기간 {days}일입니다.', input('ko', BILLBOARD))).toEqual([]);
  });
  it('영어·중국어 답장의 한글은 걸리고, 한국어 답장의 한글은 걸리지 않는다', () => {
    expect(checkReply(`${good} 감사합니다.`, en)).toEqual(['HANGUL_IN_TEXT']);
    expect(checkReply('문의 감사합니다. 총액은 {total}입니다.', input('ko', BILLBOARD))).toEqual([]);
  });
  it('용어집 표기가 빠지면 걸린다(영어·중국어만)', () => {
    expect(checkReply(good.replace('digital billboard', 'LED screen'), en)).toEqual(['GLOSSARY_MISS']);
    expect(checkReply('총액은 {total}입니다.', input('ko', BILLBOARD))).toEqual([]);
  });
  it('혼잣말 규칙은 본체의 것 그대로라 "Let me know" 도 걸린다', () => {
    expect(checkReply(`${good} Let me know if this works.`, en)).toEqual(['MONOLOGUE']);
    expect(checkReply(`- ${good}`, en)).toEqual(['MONOLOGUE']);
  });
  it('빈 글', () => {
    expect(checkReply('  …  ', en)).toEqual(['EMPTY_TEXT']);
    expect(checkReply('{total}', en)).toEqual(['EMPTY_TEXT']);
  });
  it('맞는 상품이 없는 답장에 자리표시를 쓰면 걸린다', () => {
    expect(checkReply('찾지 못했습니다. 총액은 {total}입니다.', input('ko', null))).toEqual(['PLACEHOLDER_LOST']);
  });
  it('다시 쓰라고 할 때 붙이는 말에는 숫자 값이 없다', () => {
    const hint = replyRetryHint(['PLACEHOLDER_LOST', 'STRAY_NUMBER', 'GLOSSARY_MISS'], en);
    expect(hint).toContain('{total}, {days}, {start_date}, {booking_deadline}, {material_deadline}');
    expect(hint).toContain('"Hapjeong Station", "digital billboard"');
    expect(hint).not.toMatch(/2,?800,?000|2027/);
  });
});
