// 실제 호출 확인. 고른 갈래만 한 번씩 부르고 토큰·시간·비용을 표로 찍는다.
//   (갈래를 안 적으면)     직접 지은 짧은 글 3건을 뽑기 프롬프트로
//   --transcribe 파일 …   그림(JPG·PNG·WEBP)·PDF 를 글로 옮기기. 파일마다 한 번
//   --content             글 만들기 한 번
//   --expect 글파일        (옮기기) 옮긴 글에 있어야 하는 구절. 한 줄에 하나
//   --forbid 글파일        (옮기기) 옮긴 글에 있으면 안 되는 구절. 한 줄에 하나
//   --dry                 부르지 않고 정해 둔 답으로 흐름만 본다. 키가 없어도 되고 돈이 들지 않는다
// --dry 가 아니면 돈이 드는 호출이다. 실패해도 다시 부르지 않는다. 키 값과 파일 내용은 찍지 않는다.
// 실행: npm run llm:smoke -- --transcribe 단가표.png 소개서.pdf --expect 있어야-할-구절.txt --content
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { LANGS, TEXT_FIELDS, type ContentInput } from '@/contract/content';
import { DEFAULT_LLM_MODEL, isLlmUnavailable, type LlmAttachment, type LlmRequest, type LlmResult } from '@/contract/llm-types';
import { checkUpload, countPdfPagesRoughly, UPLOAD_LIMITS, UPLOAD_PROBLEM_MESSAGES } from '@/contract/pipeline-api';
import { checkContent } from '@/core/content-check';
import {
  buildContentRequest,
  buildExtractRequest,
  buildTranscribeRequest,
  costUsd,
  countUnreadableMarks,
  createProvider,
  MemoryCallStore,
  priceOf,
} from '@/llm';
import { createAnthropicProvider, newAnthropicClient, type MessagesClient } from '@/llm/anthropic';

/** 이번 실행의 합이 이 값을 넘을 것 같으면 그 호출 앞에서 멈춘다(달러). */
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

/** 글 만들기에 넣는 상품. 숫자(값, 일수)는 넣지 않는다. 모델은 자리표시만 써야 한다. */
const CONTENT_INPUT: ContentInput = {
  type: 'ad',
  subtype: '전광판',
  name: '합정역 스퀘어비전',
  region: '합정역 3번 출구 앞',
  glossary: [
    { ko: '전광판', en: 'digital billboard', 'zh-Hans': '电子屏' },
    { ko: '합정역', en: 'Hapjeong Station', 'zh-Hans': '合井站' },
    { ko: '스퀘어비전', en: 'Square Vision', 'zh-Hans': 'Square Vision' },
  ],
  placeholders: ['price', 'days'],
};

interface Args {
  transcribe: string[];
  content: boolean;
  expect: string | null;
  forbid: string | null;
  dry: boolean;
}

/** 옵션을 잘못 적었거나 파일을 못 읽었을 때. 이 오류의 글은 그대로 알려도 된다. */
class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  const args: Args = { transcribe: [], content: false, expect: null, forbid: null, dry: false };
  let takingFiles = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--transcribe') {
      takingFiles = true;
    } else if (a === '--content' || a === '--dry') {
      args[a === '--content' ? 'content' : 'dry'] = true;
      takingFiles = false;
    } else if (a === '--expect' || a === '--forbid') {
      const value = argv[++i];
      if (!value) throw new UsageError(`${a} 뒤에 글 파일을 적는다`);
      args[a === '--expect' ? 'expect' : 'forbid'] = value;
      takingFiles = false;
    } else if (!a.startsWith('--') && takingFiles) {
      args.transcribe.push(a);
    } else {
      throw new UsageError(`모르는 옵션: ${a}`);
    }
  }
  return args;
}

/** 파일을 읽는다. 못 읽으면 파일 이름만 알린다(경로는 찍지 않는다). */
function readBytes(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new UsageError(`파일을 읽지 못했다: ${basename(path)}`);
  }
}

/** 글 파일을 줄 목록으로 읽는다. 빈 줄은 뺀다. */
function readLines(path: string | null): string[] {
  if (!path) return [];
  return readBytes(path)
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

interface Row {
  id: string;
  inTok: number | string;
  outTok: number | string;
  thinkTok: number | string;
  ms: number | string;
  usd: string;
  stop: string;
  schema: string;
  result: string;
}

/**
 * --dry 에서 쓰는 가짜 답. 요청이 요구한 꼴을 보고 일을 알아낸다. 토큰은 0 이다.
 * 모델의 답이 아니다. 스크립트가 끝까지 도는지만 본다.
 */
function dryMessage(params: Anthropic.MessageCreateParamsNonStreaming): Anthropic.Message {
  const wanted = Object.keys((params.output_config?.format?.schema as { properties?: object } | undefined)?.properties ?? {});
  const answer = wanted.includes('unreadable')
    ? { unreadable: false, text: '(부르지 않음) 매체명 | 1주\n합정역 스퀘어비전 | [안 보임]', note: '정해 둔 답이다' }
    : wanted.includes('fields')
      ? { type: 'not_product', subtype: null, fields: [] }
      : { en: { title: 'Hapjeong Station Square Vision', summary: '(not called) From {price} for {days} days.' }, 'zh-Hans': { title: '合井站 Square Vision', summary: '(未调用) {days}天 {price}起。' } };
  return {
    id: 'msg_dry', type: 'message', role: 'assistant', model: params.model,
    content: [{ type: 'text', text: JSON.stringify(answer), citations: null }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
  } as unknown as Anthropic.Message;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey && !args.dry) {
    console.log('ANTHROPIC_API_KEY 가 없다. 부르지 않고 끝낸다.');
    process.exitCode = 1;
    return;
  }
  if (args.dry) console.log('--dry: 모델을 부르지 않는다. 아래의 답은 정해 둔 것이고 토큰과 비용은 0 이다.');
  const model = process.env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;
  const price = priceOf(model);
  console.log(`모델 ${model} · 단가 입력 ${price.inputPerMTok} / 출력 ${price.outputPerMTok} 달러(100만 토큰) · ${price.checkedOn} 확인`);

  // 진짜 클라이언트를 한 겹 싸서, 구현이 내보내지 않는 값(생각 토큰, 실패한 호출의 토큰, 모델의 덧말)을 여기서만 본다.
  const real = args.dry || !apiKey ? null : newAnthropicClient(apiKey);
  let last: Anthropic.Message | null = null;
  const client: MessagesClient = {
    messages: {
      async create(params) {
        last = real ? await real.messages.create(params) : dryMessage(params);
        return last;
      },
    },
  };
  // 받은 답을 메모리 장부에 적어 둔다. 같은 요청을 녹화 재생으로 다시 물어 보는 데 쓴다.
  const store = new MemoryCallStore();
  const llm = createAnthropicProvider({ model, client, store });

  const rows: Row[] = [];
  let total = 0;
  let stopped = false;

  /**
   * 한 번 부른다. 다시 부르지 않는다. 부르지 않았거나 답을 못 썼으면 null.
   * worstUsd 는 이 호출이 가장 비쌀 때의 어림이다. 지금까지 쓴 돈에 이것을 더해 한도를 넘으면 부르지 않는다.
   */
  async function callOnce<T>(id: string, req: LlmRequest<T>, describe: (res: LlmResult<T>) => string, worstUsd: number): Promise<LlmResult<T> | null> {
    if (stopped) return null;
    if (total + worstUsd > BUDGET_USD) {
      console.log(`[${id}] 한도(${BUDGET_USD}달러)를 넘을 수 있어 부르지 않는다(지금까지 ${total.toFixed(6)}, 이 호출의 어림 ${worstUsd.toFixed(6)}).`);
      return null;
    }
    last = null;
    try {
      const res = await llm.complete(req);
      const usd = costUsd(model, res.usage);
      total += usd;
      const raw = last as Anthropic.Message | null;
      rows.push({
        id,
        inTok: res.usage.inputTokens,
        outTok: res.usage.outputTokens,
        thinkTok: raw?.usage.output_tokens_details?.thinking_tokens ?? '-',
        ms: res.latencyMs,
        usd: usd.toFixed(6),
        stop: res.stopReason,
        schema: '통과',
        result: describe(res),
      });
      return res;
    } catch (err) {
      const raw = last as Anthropic.Message | null;
      const code = isLlmUnavailable(err) ? `${err.code} (${err.message})` : '알 수 없는 오류';
      let usd = 0;
      if (raw) {
        usd = costUsd(model, { inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens });
        total += usd;
      }
      rows.push({
        id,
        inTok: raw?.usage.input_tokens ?? '-',
        outTok: raw?.usage.output_tokens ?? '-',
        thinkTok: raw?.usage.output_tokens_details?.thinking_tokens ?? '-',
        ms: '-',
        usd: usd.toFixed(6),
        stop: raw?.stop_reason ?? '-',
        schema: `실패: ${code}`,
        result: '-',
      });
      console.log(`[${id}] 실패: ${code}`);
      // 응답을 받지도 못한 오류(인증·잔액·모델 이름·연결)는 다음 건도 같을 것이라 멈춘다.
      if (!raw) {
        console.log('다시 부르지 않고 멈춘다.');
        stopped = true;
        process.exitCode = 1;
      }
      return null;
    }
  }

  /** 가장 비쌀 때의 어림. 글은 글자마다 2토큰, 그림은 4,784토큰, PDF 는 쪽마다 그림 + 글 3,000토큰, 답은 최대 토큰 수까지로 본다. */
  function worstCaseUsd(req: LlmRequest<unknown>, pdfPages = 0): number {
    const textTokens = (req.system.length + JSON.stringify(req.input).length) * 2;
    const fileTokens = (req.attachments ?? []).reduce((sum, a) => sum + (a.kind === 'pdf' ? pdfPages * (4784 + 3000) : 4784), 0);
    return costUsd(model, { inputTokens: textTokens + fileTokens, outputTokens: req.maxTokens });
  }

  // ── 글로 옮기기 ──────────────────────────────────────────
  if (args.transcribe.length > 0) {
    if (real) await printModelInfo(real, model);
    const expected = readLines(args.expect);
    const forbidden = readLines(args.forbid);

    for (const path of args.transcribe) {
      const name = basename(path);
      const bytes = readBytes(path);
      const check = checkUpload(bytes);
      if (!check.ok) {
        console.log(`[${name}] 올리기 검사에서 걸렸다: ${UPLOAD_PROBLEM_MESSAGES[check.problem]} 부르지 않는다.`);
        continue;
      }
      const file: LlmAttachment = { kind: check.kind, mediaType: check.mediaType, dataBase64: bytes.toString('base64') };
      const req = buildTranscribeRequest(file);
      // 쪽수를 못 세는 PDF 는 가장 많은 쪽수로 어림한다.
      const pages = check.kind === 'pdf' ? countPdfPagesRoughly(bytes) || UPLOAD_LIMITS.pdfMaxPages : 0;
      console.log(`\n[${name}] ${check.mediaType} · ${bytes.length.toLocaleString('en-US')}바이트${check.kind === 'pdf' ? ` · ${pages}쪽(어림)` : ''}`);
      const res = await callOnce(
        `옮기기 ${name}`,
        req,
        (r) => `${[...r.output.text].length}자 · 못 읽은 곳 ${countUnreadableMarks(r.output.text)}`,
        worstCaseUsd(req as LlmRequest<unknown>, pages),
      );
      if (!res) continue;

      const text = res.output.text.normalize('NFC');
      console.log(`readable=${res.output.readable}`);
      console.log(`덧말(note): ${JSON.stringify(noteOf(last))}`);
      console.log('──── 옮긴 글 ────');
      console.log(res.output.text);
      console.log('──── 끝 ────');
      if (expected.length > 0) {
        const missing = expected.filter((line) => !text.includes(line.normalize('NFC')));
        console.log(`있어야 하는 구절: ${expected.length - missing.length}/${expected.length} 있음`);
        for (const line of missing) console.log(`  없음: ${line}`);
      }
      if (forbidden.length > 0) {
        const found = forbidden.filter((line) => text.includes(line.normalize('NFC')));
        console.log(`있으면 안 되는 구절: ${found.length}/${forbidden.length} 나옴`);
        for (const line of found) console.log(`  나옴: ${line}`);
      }
      // 같은 파일로 만든 요청을 녹화 재생에 물으면 방금 받은 답이 장부에서 나와야 한다(호출 없음).
      const again = await createProvider({ kind: 'replay', model, store }).complete(buildTranscribeRequest({ ...file }));
      console.log(`녹화 재생: ${again.recorded && again.output.text === res.output.text ? '같은 파일로 다시 물으니 장부의 답이 나왔다(호출 없음)' : '장부의 답이 방금 답과 다르다'}`);
    }
  }

  // ── 글 만들기 ────────────────────────────────────────────
  if (args.content) {
    const req = buildContentRequest(CONTENT_INPUT);
    const res = await callOnce('글 만들기', req, () => '위 표', worstCaseUsd(req as LlmRequest<unknown>));
    if (res) {
      const termsIn = (source: string, lang: (typeof LANGS)[number]) => CONTENT_INPUT.glossary.filter((e) => source.includes(e.ko)).map((e) => e[lang]);
      const lines = LANGS.flatMap((lang) =>
        TEXT_FIELDS.map((field) => {
          const text = res.output[lang][field];
          const summary = field === 'summary';
          const fails = checkContent({
            lang,
            field,
            text,
            // 자리표시는 요약에만 쓴다. 요약에는 알려 준 자리표시가 모두 있어야 한다.
            requiredPlaceholders: summary ? CONTENT_INPUT.placeholders : [],
            requiredTerms: [...new Set([...termsIn(CONTENT_INPUT.name, lang), ...(summary ? termsIn(CONTENT_INPUT.region ?? '', lang) : [])])],
            // 이름·지역에 원래 있는 숫자("3번 출구")만 자리표시 밖에 나올 수 있다.
            allowedNumbers: `${CONTENT_INPUT.name} ${CONTENT_INPUT.region ?? ''}`.match(/\d+/g) ?? [],
          });
          return { lang, field, text, check: fails.length === 0 ? '통과' : fails.join(', ') };
        }),
      );
      console.log('\n[글 만들기] 입력에는 숫자가 없다. 요약에는 {price} 와 {days} 가 자리표시인 채로 있어야 한다.');
      console.table(lines);
    }
  }

  // ── 뽑기(갈래를 고르지 않았을 때) ─────────────────────────
  if (args.transcribe.length === 0 && !args.content) {
    for (const doc of DOCS) {
      const req = buildExtractRequest(doc.text);
      const res = await callOnce(`뽑기 ${doc.id}`, req, (r) => `칸 ${r.output.fields.length}개`, worstCaseUsd(req as LlmRequest<unknown>));
      if (!res) continue;
      console.log(`\n[${doc.id}] type=${res.output.type} subtype=${res.output.subtype}`);
      for (const f of res.output.fields) console.log(`  ${f.field}: raw=${JSON.stringify(f.raw)} value=${JSON.stringify(f.value)}`);
    }
  }

  console.log('');
  console.table(rows);
  console.log(real ? `호출 ${rows.length}번 · 합계 ${total.toFixed(6)}달러` : `실제 호출 0번(정해 둔 답 ${rows.length}번) · 합계 0달러`);
}

/** 돈이 들지 않는 조회다. 이 모델이 그림과 PDF 를 받는지 API 에게 직접 묻는다. */
async function printModelInfo(real: Anthropic, model: string): Promise<void> {
  try {
    const info = await real.models.retrieve(model);
    const yn = (v: boolean | undefined) => (v === undefined ? '모름' : v ? '받음' : '안 받음');
    const caps = info.capabilities;
    console.log(
      `모델 정보: 그림 ${yn(caps?.image_input.supported)} · PDF ${yn(caps?.pdf_input.supported)} · 스키마에 묶인 답 ${yn(caps?.structured_outputs.supported)}` +
        ` · 입력 창 ${info.max_input_tokens ?? '?'}토큰 · 답 최대 ${info.max_tokens ?? '?'}토큰`,
    );
  } catch {
    console.log('모델 정보를 읽지 못했다. 호출은 그대로 해 본다.');
  }
}

/** 모델이 글로 옮기기 답에 적은 덧말. 약속의 꼴에는 자리가 없어 구현이 버리는 값이라 날것의 답에서 꺼낸다. */
function noteOf(message: Anthropic.Message | null): string {
  const text = message?.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
  if (!text) return '';
  try {
    const note = (JSON.parse(text) as { note?: unknown }).note;
    return typeof note === 'string' ? note : '';
  } catch {
    return '';
  }
}

main().catch((err: unknown) => {
  // 오류 글에 요청 내용이 섞일 수 있어 종류만 알린다. 옵션을 잘못 적은 것은 그대로 알린다.
  console.log(err instanceof UsageError ? err.message : '스크립트가 예상하지 못한 오류로 끝났다.');
  process.exitCode = 1;
});
