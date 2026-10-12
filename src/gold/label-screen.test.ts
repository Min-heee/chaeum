// 확인 화면이 한 건을 어떻게 그리는지 본다(서버에서 한 번 그려 글자를 본다). 누르는 동작은 여기서 보지 않는다.
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GoldDoc } from '@/contract/eval-types';
import type { FieldHint } from './hints';
import { DocReview } from '../../app/label/ReviewClient';

const doc: GoldDoc = {
  id: 'hand-997',
  split: 'hand',
  goldVersion: 1,
  author: 'human',
  traps: [],
  content: '가나다 전광판 <b>안내</b>\n위치는 강남역, 값은 1주(150만원)입니다.\n유동인구는 월 300만 명, 운영은 05시~25시.',
  truth: {
    type: 'ad',
    subtype: '전광판',
    fields: {
      name: '가나다 전광판',
      price_krw: 1_500_000,
      list_price_krw: null,
      vat_included: null,
      region: '강남역',
      size_m: null,
      resolution_px: null,
      hours: { open: '05:00', close: '01:00', nextDay: true },
      spot_seconds: null,
      plays_per_day: null,
      footfall_per_day: 100_000,
      period_options: [{ days: 7, price_krw: 1_500_000 }],
      material_deadline_days: null,
      file_format: ['jpg'],
      refund_full_days: null,
      booking_deadline_days: null,
    },
  },
};
const hints: FieldHint[] = [
  { field: 'name', tokens: ['가나다 전광판'] },
  { field: 'price_krw', tokens: ['150만원'] },
  { field: 'region', tokens: ['강남역'] },
  { field: 'hours', tokens: ['05시~25시'] },
  { field: 'footfall_per_day', tokens: ['월 300만 명'] },
  { field: 'period_options', tokens: ['1주(150만원)'] },
  { field: 'file_format', tokens: ['JPEG'] },
];
const draw = (h: FieldHint[] | null) => renderToStaticMarkup(createElement(DocReview, { doc, pass: 1, hints: h, busyRef: createRef<boolean>() as never, onDone: () => undefined }));
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('확인 화면 한 건', () => {
  const html = draw(hints);

  it('원문은 글자로만 그린다(원문 안의 꺾쇠가 태그가 되지 않는다)', () => {
    expect(html).toContain('&lt;b&gt;안내&lt;/b&gt;');
    expect(html).not.toContain('<b>안내</b>');
  });

  it('처음 고른 칸(첫 칸)의 조각이 진하게, 다른 칸의 조각은 밑줄과 꼬리표로 보인다', () => {
    expect(html.match(/data-on="1"/g)).toHaveLength(1);
    expect(html).toMatch(/data-on="1"[^>]*>가나다 전광판<\/span>/);
    for (const tag of ['상품 이름', '판매가', '위치', '운영 시간', '하루 유동인구', '기간 옵션']) expect(text(html)).toContain(tag);
  });

  it('값이 있는 칸이 위, 없음인 칸은 아래 묶음에 모인다', () => {
    const t = text(html);
    expect(t).toContain('없음 9칸 — 원문에 이 정보가 없는지만 보면 됩니다');
    expect(t.indexOf('소재 파일 형식')).toBeLessThan(t.indexOf('없음 9칸'));
    expect(t.indexOf('없음 9칸')).toBeLessThan(t.lastIndexOf('정가(원)'));
    expect(t.match(/이 칸의 정보가 원문에 없어야 맞습니다/g)).toHaveLength(9);
  });

  it('환산 한 줄, 늘 보이는 규칙, 못 찾은 표기를 칸 아래에 적는다', () => {
    const t = text(html);
    expect(t).toContain('↳ 300만 = 3,000,000명, 월 3,000,000 ÷ 30 = 100,000명');
    expect(t).toContain('↳ 25시 = 다음 날 01:00');
    expect(t).toContain('↳ 1주 = 7일 · 150만 = 150 × 10,000 = 1,500,000원');
    expect(t).toContain('JPEG 과 jpg 는 같은 것으로 칩니다(소문자, jpeg → jpg)');
    expect(t).toContain('가장 짧은 기간(가장 적은 수량) 옵션의 값');
    // 파일 형식의 표기 "JPEG"는 이 원문에 없다.
    expect(t.match(/표기를 원문에서 못 찾음 — 직접 찾아 주세요/g)).toHaveLength(1);
  });

  it('표기 정보가 없으면 강조 없이 예전처럼 그린다', () => {
    const plain = draw(null);
    expect(plain).not.toContain('data-on');
    expect(text(plain)).toContain('이 문서는 표기 정보가 없어 강조 없이 보입니다');
    expect(text(plain)).not.toContain('못 찾음');
    expect(text(plain)).toContain(doc.content);
    expect(text(plain)).toContain('없음 9칸');
  });
});
