import { describe, expect, it } from 'vitest';
import { DEFAULT_LLM_MODEL } from '@/contract/llm-types';
import { costUsd, priceOf } from './pricing';

describe('단가', () => {
  it('기본 모델의 단가와 확인한 날짜·주소가 있다', () => {
    const p = priceOf(DEFAULT_LLM_MODEL);
    expect(p).toMatchObject({ inputPerMTok: 0.1, outputPerMTok: 0.5 });
    expect(p.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.sourceUrl).toMatch(/^https:\/\//);
  });
  it('모르는 모델이면 오류', () => {
    expect(() => priceOf('no-such-model')).toThrow();
    expect(() => costUsd('no-such-model', { inputTokens: 1, outputTokens: 1 })).toThrow();
  });
});

describe('비용', () => {
  it('토큰 × 단가: 입력 2,000 + 출력 600 → 0.0005달러', () => {
    expect(costUsd('claude-haiku-5-5', { inputTokens: 2000, outputTokens: 600 })).toBe(0.0005);
  });
  it('토큰이 0 이면 0', () => {
    expect(costUsd('claude-haiku-5-5', { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
  it('큰 모델은 같은 토큰에 20배', () => {
    expect(costUsd('claude-sonnet-5-5', { inputTokens: 2000, outputTokens: 600 })).toBe(0.01);
  });
  it('작은 모델은 프롬프트가 10만 토큰을 넘으면 비싼 단가다(딱 10만은 아니다)', () => {
    expect(costUsd('claude-haiku-5-5', { inputTokens: 100_000, outputTokens: 0 })).toBe(0.01);
    expect(costUsd('claude-haiku-5-5', { inputTokens: 100_001, outputTokens: 0 })).toBeCloseTo(0.0500005, 9);
    expect(costUsd('claude-haiku-5-5', { inputTokens: 200_000, outputTokens: 1000 })).toBe(0.1025);
  });
});
