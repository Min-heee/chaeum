// 실제 자료 넣기와 손글 쓰기 화면이 한 건을 어떻게 그리는지 본다(서버에서 한 번 그려 글자를 본다). 누르는 동작은 여기서 보지 않는다.
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoldDoc } from '@/contract/eval-types';
import { FIELDS_BY_TYPE, fieldDef } from '@/contract/fields';
import HandPage from '../../app/label/hand/page';
import { HandForm, collectFields, formFromDoc } from '../../app/label/hand/HandClient';
import RealPage from '../../app/label/real/page';
import { HonestNote, RealReview, type ScreenIntake } from '../../app/label/real/RealClient';
import { hintsFromDraft, makeGoldDoc, type ModelDraft } from './origins';

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

const content = '가나다 전광판 안내\n위치 강남역, 1주 150만원\n운영 05시~25시';
const model: ModelDraft = {
  type: 'ad',
  subtype: '전광판',
  docFlagged: true,
  fields: {
    name: { value: '가나다 전광판', raw: '가나다 전광판', evidence: '가나다 전광판 안내', flagged: false },
    price_krw: { value: 1_500_000, raw: '150만원', evidence: '1주 150만원', flagged: false },
    hours: { value: { open: '05:00', close: '01:00', nextDay: true }, raw: '05시~25시', evidence: '운영 05시~25시', flagged: true },
    spot_seconds: { value: 15, raw: null, evidence: null, flagged: false },
  },
};
const intake: ScreenIntake = { id: '7', content, sourceUrl: 'https://example.com/a', fetchedOn: '2026-10-13', kind: 'page', model, hints: hintsFromDraft(content, model), called: true, status: 'open', goldDocId: null };

describe('실제 자료 넣기 화면', () => {
  const html = renderToStaticMarkup(createElement(RealReview, { intake, busyRef: createRef<boolean>() as never, onConfirmed: () => undefined, onSkipped: () => undefined }));
  const shown = text(html);

  it('원문은 글자 하나 다르지 않고, 강조는 모델이 준 근거 구절이다', () => {
    const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? '';
    // 꼬리표(칸 이름)를 뺀 글자가 원문과 같다.
    const body = text(pre.replace(/<span class="[^"]*tag[^"]*">[^<]*<\/span>/g, ''));
    expect(body).toBe(content);
    expect(html).toContain('1주 150만원</span>');
    expect(shown).toContain('밑줄 = 모델이 준 근거 구절');
    expect(shown).toContain('모델의 근거 “운영 05시~25시”');
  });

  it('모델이 채운 칸에는 맞음·고침·없음으로, 비운 칸에는 없음 맞음·값 넣기가 붙는다', () => {
    expect(shown).toContain('1,500,000원');
    expect(shown).toContain('05:00 ~ 01:00 (끝이 다음 날)');
    expect(shown).toContain('맞음 (o)');
    expect(shown).toContain('고침 (e)');
    expect(shown).toContain('없음으로 (n)');
    expect(shown).toContain('없음 맞음 (o)');
    expect(shown).toContain('값 넣기 (e)');
    expect(shown).toContain(`모델이 비운 칸 ${FIELDS_BY_TYPE.ad.length - 4}개`);
    // 값이 있는 칸이 위, 비운 칸이 아래.
    expect(shown.indexOf('한 번 길이(초)')).toBeLessThan(shown.indexOf('모델이 비운 칸'));
    expect(shown.indexOf('크기(m)')).toBeGreaterThan(shown.indexOf('모델이 비운 칸'));
  });

  it('근거가 없는 칸과 표시가 붙은 칸을 알리고, 넘김과 등록 대상 아님의 길을 보인다', () => {
    expect(shown).toContain('모델이 근거를 주지 않은 칸');
    expect(shown).toContain('모델 쪽 표시');
    expect(shown).toContain('정답으로 확정 (Enter)');
    expect(shown).toContain('우리 양식에 없는 상품 — 넘김 (x)');
    expect(shown).toContain('등록 대상 아님');
    // 규칙 한 줄은 값이 있는 칸에 붙는다.
    expect(shown).toContain('대표 판매가');
  });

  it('화면 머리에 이 묶음의 숫자가 무엇인지 적는다', () => {
    const note = text(renderToStaticMarkup(createElement(HonestNote)));
    expect(note).toContain('모델이 채운 초안을 사람이 고쳐서');
    expect(note).toContain('모델에 유리하게');
    expect(note).toContain('정확도가 아니라');
  });
});

describe('손글 쓰기 화면', () => {
  const empty = { id: null, type: null, subtype: null, content: '', texts: {}, tipIds: [] };
  const draw = (form: Parameters<typeof HandForm>[0]['form']) => text(renderToStaticMarkup(createElement(HandForm, { form, onChange: () => undefined })));

  it('종류를 고르기 전에는 칸이 없고, 고르면 그 종류의 칸만 나온다', () => {
    const none = draw(empty);
    expect(none).toContain('먼저 종류를 고릅니다');
    expect(none).not.toContain('최소 주문 수량');
    const goods = draw({ ...empty, type: 'goods', subtype: '잡화' });
    for (const k of FIELDS_BY_TYPE.goods) expect(goods, k).toContain(fieldDef(k).label);
    expect(goods).not.toContain('하루 유동인구');
    expect(draw({ ...empty, type: 'not_product' })).toContain('채울 칸이 없습니다');
  });

  it('칸마다 값의 꼴 안내와, 적은 글을 어떻게 읽었는지가 보인다', () => {
    const ad = draw({ ...empty, type: 'ad', subtype: '전광판', texts: { hours: '05:00~25:00', price_krw: '150만', size_m: '8000mm x 4500mm' } });
    expect(ad).toContain('→ 05:00 ~ 01:00 (끝이 다음 날)');
    expect(ad).toContain('→ 1,500,000원');
    expect(ad).toContain('이 칸의 단위로 적어 주세요');
    expect(ad).toContain('→ 없음');
  });

  it('함정 귀띔은 고르는 것이고, 모델에 대한 말은 "부르지 않는다"뿐이다', () => {
    const page = draw(empty);
    for (const label of ['단위 없는 금액', '월 유동인구', 'mm·cm·m 크기', '값이 없는 칸', '지시문 섞기']) expect(page).toContain(label);
    expect(page).toContain('고르는 것이지 꼭 넣는 것이 아닙니다');
    expect(page).not.toContain('모델의 근거');
    expect(page).not.toContain('초안');
  });

  it('입력한 것을 저장할 꼴로 모은다. 저장한 문서를 다시 놓으면 같은 값이 나온다', () => {
    const bad = collectFields({ ...empty, type: 'goods', subtype: '잡화', texts: { size_mm: '오십' } });
    expect(bad).toEqual({ ok: false, bad: ['크기(mm)'] });
    const doc: GoldDoc = makeGoldDoc({
      id: 'hand-001',
      split: 'hand',
      content: '아크릴 키링 50mm x 50mm',
      truth: { type: 'goods', subtype: '잡화', fields: { name: '아크릴 키링', size_mm: { width: 50, height: 50 }, min_order_qty: 30 } },
      traps: ['unit'],
    });
    const form = formFromDoc(doc);
    expect(form).toMatchObject({ id: 'hand-001', type: 'goods', subtype: '잡화', tipIds: ['bare_amount'] });
    const back = collectFields(form);
    expect(back).toMatchObject({ ok: true, filled: 3 });
    expect(back.ok && back.fields).toEqual(doc.truth.fields);
  });
});

describe('로컬 전용', () => {
  const before = process.env.LABEL_ENABLED;
  afterEach(() => {
    if (before === undefined) delete process.env.LABEL_ENABLED;
    else process.env.LABEL_ENABLED = before;
  });

  it('LABEL_ENABLED 가 1 이 아니면 두 화면 모두 404 다(DB 를 읽기 전에)', async () => {
    for (const value of [undefined, '0', 'true']) {
      if (value === undefined) delete process.env.LABEL_ENABLED;
      else process.env.LABEL_ENABLED = value;
      for (const page of [RealPage, HandPage]) {
        const err = await page({ searchParams: Promise.resolve({}) }).then(
          () => null,
          (e: unknown) => e as { digest?: string },
        );
        expect(err?.digest).toContain('404');
      }
    }
  });
});
