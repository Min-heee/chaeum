// 모델별 단가. 숫자를 고칠 때는 확인한 날짜와 주소도 함께 고친다.
import type { LlmUsage, ModelPrice } from '@/contract/llm-types';

const SOURCE_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
const CHECKED_ON = '2026-10-12';

interface PriceRow extends ModelPrice {
  /** 프롬프트가 이 토큰 수를 넘으면 값이 달라지는 모델만. */
  longPrompt?: { overInputTokens: number; inputPerMTok: number; outputPerMTok: number };
}

/** 100만 토큰당 달러. 묶음 처리 할인과 캐시 값은 쓰지 않아서 적지 않았다. */
const PRICES: readonly PriceRow[] = [
  {
    model: 'claude-haiku-5-5',
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    longPrompt: { overInputTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 },
    checkedOn: CHECKED_ON,
    sourceUrl: SOURCE_URL,
  },
  { model: 'claude-sonnet-5-5', inputPerMTok: 2, outputPerMTok: 10, checkedOn: CHECKED_ON, sourceUrl: SOURCE_URL },
  { model: 'claude-opus-5-5', inputPerMTok: 4, outputPerMTok: 20, checkedOn: CHECKED_ON, sourceUrl: SOURCE_URL },
];

function rowOf(model: string): PriceRow {
  const row = PRICES.find((p) => p.model === model);
  if (!row) throw new Error(`단가를 모르는 모델: ${model}. src/llm/pricing.ts 에 더한다.`);
  return row;
}

/** 기본 단가(짧은 프롬프트 기준)와 확인한 날짜·주소. 모르는 모델이면 오류. */
export function priceOf(model: string): ModelPrice {
  const row = rowOf(model);
  return {
    model: row.model,
    inputPerMTok: row.inputPerMTok,
    outputPerMTok: row.outputPerMTok,
    checkedOn: row.checkedOn,
    sourceUrl: row.sourceUrl,
  };
}

/** 비용(달러) = 토큰 × 단가. 생각 토큰은 출력 토큰에 들어 있다. */
export function costUsd(model: string, usage: LlmUsage): number {
  const row = rowOf(model);
  const long = row.longPrompt && usage.inputTokens > row.longPrompt.overInputTokens ? row.longPrompt : null;
  const inRate = long ? long.inputPerMTok : row.inputPerMTok;
  const outRate = long ? long.outputPerMTok : row.outputPerMTok;
  const usd = (usage.inputTokens * inRate + usage.outputTokens * outRate) / 1_000_000;
  // 소수 계산의 잔 오차를 턴다.
  return Math.round(usd * 1e9) / 1e9;
}
