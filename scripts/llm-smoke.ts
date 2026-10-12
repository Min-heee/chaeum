// 실제 호출 확인. 직접 지은 짧은 글 3건을 뽑기 프롬프트로 한 번씩만 부르고 토큰·시간·비용을 표로 찍는다.
// 돈이 드는 호출이다. 실패해도 다시 부르지 않는다. 키 값은 찍지 않는다.
// 실행: npx tsx --env-file-if-exists=.env.local scripts/llm-smoke.ts
import type Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_LLM_MODEL, isLlmUnavailable } from '@/contract/llm-types';
import { buildExtractRequest, costUsd, priceOf } from '@/llm';
import { createAnthropicProvider, newAnthropicClient, type MessagesClient } from '@/llm/anthropic';

/** 세 건의 합이 이 값을 넘을 것 같으면 멈춘다(달러). */
const BUDGET_USD = 0.01;

// 업체·상품 이름은 전부 지어낸 것이다.
const DOCS: { id: string; text: string }[] = [
  {
    id: 'ad',
    text: [
      '[하늘빛미디어] 강남역 11번 출구 하늘빛 전광판 안내',
      '크기 가로 8m x 세로 4.5m, 해상도 1920x1080',
      '운영 05시~25시 / 1회 15초, 하루 100회 송출',
      '월 유동인구 약 90만명',
      '1주 150만원, 2주 280만원 (VAT 별도)',
      '소재는 게재 5일 전까지 JPG 또는 MP4 로 보내 주세요. 게재 7일 전까지 취소하시면 전액 환불됩니다.',
    ].join('\n'),
  },
  {
    id: 'catering',
    text: [
      '달보드레 커피차입니다 :)',
      '서울·경기 전 지역 출장 가능해요.',
      '100잔 80만원 / 200잔 150만원 (부가세 포함)',
      '운영 시간은 오전 9시부터 오후 6시까지이고, 현수막 시안은 행사 1주 전까지 보내 주셔야 합니다.',
    ].join('\n'),
  },
  {
    id: 'goods',
    text: [
      '별무리 엽서 세트 제작 안내 (온새미로 인쇄)',
      '사이즈 100x148mm, 스노우지 250g',
      '최소 50장부터 주문 가능, 50장 기준 25,000원 (정가 30,000원)',
      '제작 기간은 영업일 기준 5일입니다.',
    ].join('\n'),
  },
];

interface Row {
  id: string;
  inTok: number | string;
  outTok: number | string;
  thinkTok: number | string;
  ms: number | string;
  usd: string;
  stop: string;
  schema: string;
  fields: number | string;
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    console.log('ANTHROPIC_API_KEY 가 없다. 부르지 않고 끝낸다.');
    process.exitCode = 1;
    return;
  }
  const model = process.env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;
  const price = priceOf(model);
  console.log(`모델 ${model} · 단가 입력 ${price.inputPerMTok} / 출력 ${price.outputPerMTok} 달러(100만 토큰) · ${price.checkedOn} 확인`);

  // 진짜 클라이언트를 한 겹 싸서, 구현이 내보내지 않는 값(생각 토큰, 실패한 호출의 토큰)을 여기서만 본다.
  const real = newAnthropicClient(apiKey);
  let last: Anthropic.Message | null = null;
  const client: MessagesClient = {
    messages: {
      async create(params) {
        last = await real.messages.create(params);
        return last;
      },
    },
  };
  const llm = createAnthropicProvider({ model, client });

  const rows: Row[] = [];
  let total = 0;
  for (const doc of DOCS) {
    // 지금까지 가장 비쌌던 건만큼 한 번 더 써도 한도 안인지 본다.
    const worst = Math.max(0, ...rows.map((r) => Number(r.usd) || 0));
    if (total + worst > BUDGET_USD) {
      console.log(`한도(${BUDGET_USD}달러)를 넘을 것 같아 ${doc.id} 앞에서 멈춘다.`);
      break;
    }
    last = null;
    try {
      const res = await llm.complete(buildExtractRequest(doc.text));
      const usd = costUsd(model, res.usage);
      total += usd;
      const raw = last as Anthropic.Message | null;
      rows.push({
        id: doc.id,
        inTok: res.usage.inputTokens,
        outTok: res.usage.outputTokens,
        thinkTok: raw?.usage.output_tokens_details?.thinking_tokens ?? '-',
        ms: res.latencyMs,
        usd: usd.toFixed(6),
        stop: res.stopReason,
        schema: '통과',
        fields: res.output.fields.length,
      });
      console.log(`\n[${doc.id}] type=${res.output.type} subtype=${res.output.subtype}`);
      for (const f of res.output.fields) console.log(`  ${f.field}: raw=${JSON.stringify(f.raw)} value=${JSON.stringify(f.value)}`);
    } catch (err) {
      const raw = last as Anthropic.Message | null;
      const code = isLlmUnavailable(err) ? `${err.code} (${err.message})` : '알 수 없는 오류';
      let usd = 0;
      if (raw) {
        usd = costUsd(model, { inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens });
        total += usd;
      }
      rows.push({
        id: doc.id,
        inTok: raw?.usage.input_tokens ?? '-',
        outTok: raw?.usage.output_tokens ?? '-',
        thinkTok: raw?.usage.output_tokens_details?.thinking_tokens ?? '-',
        ms: '-',
        usd: usd.toFixed(6),
        stop: raw?.stop_reason ?? '-',
        schema: `실패: ${code}`,
        fields: '-',
      });
      // 응답을 받지도 못한 오류(인증·잔액·모델 이름·연결)는 다음 건도 같을 것이라 멈춘다.
      if (!raw) {
        console.log(`[${doc.id}] 호출 실패: ${code}. 다시 부르지 않고 멈춘다.`);
        break;
      }
    }
  }

  console.log('');
  console.table(rows);
  console.log(`호출 ${rows.length}번 · 합계 ${total.toFixed(6)}달러`);
}

main().catch(() => {
  // 오류 글에 요청 내용이 섞일 수 있어 종류만 알린다.
  console.log('스크립트가 예상하지 못한 오류로 끝났다.');
  process.exitCode = 1;
});
