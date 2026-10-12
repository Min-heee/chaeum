// 견적의 DB 일과 모델 부르기. 약속은 src/contract/tools/quote.ts, 판단(조건 다듬기·고르기·총액·마감·답장 검사)은 src/tools/quote 의 순수 함수다.
// 여기서 하는 일: 글 정리와 상한 보기, 길 고르기(본체와 같은 planLlmRoute·하루 상한), 모델 두 번 부르기, 상품 읽기, 표에 적기.
//
//   문의 글 → 조건 뽑기(모델 1회. 못 부르면 접수하지 않고 까닭을 돌려준다)
//          → 고르기·총액·마감(코드. 종류·갈래·지역이 하나도 없으면 상품을 고르지 않고 되묻는 틀 문장) → 답장 초안(모델 1회, 검사에 걸리면 한 번 더. 못 부르면 틀 문장) → 글 검사(코드) → 저장
import { kstDay, PUBLIC_WORKSPACE_ID } from '@/contract/api';
import type { GlossaryEntry } from '@/contract/content';
import { isLlmUnavailable, type LlmRequest } from '@/contract/llm-types';
import { afterLlmFailure, type LlmRouter } from '@/contract/pipeline-api';
import { LLM_SKIP_LABELS, type ContentFailCode, type LlmSkipCause } from '@/contract/reasons';
import {
  QUOTE_LIMITS,
  QuoteCandidateSchema,
  QuoteConditionsSchema,
  QuoteExcludedSchema,
  QuoteExtractionSchema,
  type QuoteCall,
  type QuoteCandidate,
  type QuoteCatalog,
  type QuoteConditions,
  type QuoteConfirmRequest,
  type QuoteCreateRequest,
  type QuoteExcluded,
  type QuoteExtraction,
  type QuoteLang,
  type QuoteReply,
  type QuoteReplyInput,
  type QuoteResponse,
  type QuoteStatus,
} from '@/contract/tools/quote';
import { z } from 'zod';
import { pickGlossary } from '@/content';
import { buildQuoteExtractRequest, buildQuoteReplyRequest, cacheKeyFor } from '@/llm';
import {
  askReply,
  checkReply,
  fillReply,
  hasLeftoverPlaceholder,
  hasSearchCondition,
  matchQuote,
  replyInputOf,
  replyRetryHint,
  replyValues,
  resolveConditions,
  templateReply,
} from '@/tools/quote';
import { getPool, withTx } from './db';
import { AppError } from './errors';
import { charCount, cleanText } from './limits';
import { llmRouterFromEnv } from './llm-router';
import { callInfo, isRules } from './pipeline/call';
import { approvedGlossary } from './repos/glossary-terms';
import { listProducts } from './repos/products';
import { toId, type Db } from './types';
import { touchWorkspaceForWrite, workspaceForWrite } from './workspace';

// ── 모델 부르기 ────────────────────────────────────────────

type Asked<T> = { ok: true; output: T; call: QuoteCall } | { ok: false; cause: LlmSkipCause };

/**
 * 길을 고르고 한 번 부른다. 던지지 않는다. 요청 안이라 기다렸다 다시 할 수 없어서 잠깐의 오류도 'error' 로 돌려준다.
 * 길 고르기는 본체와 같다: 받아 둔 답 → 하루 상한 안의 실제 호출 → 못 부름(까닭).
 */
async function ask<T>(router: LlmRouter, req: LlmRequest<T>, textChars: number, now: Date): Promise<Asked<T>> {
  const pick = await router.pick({ task: req.task, cacheKey: cacheKeyFor(req as LlmRequest<unknown>, router.model), textChars, now });
  if (isRules(pick)) return { ok: false, cause: pick.cause };
  try {
    const result = await pick.provider.complete(req);
    return { ok: true, output: result.output, call: callInfo(pick.route, pick.provider, req.promptVersion, result) };
  } catch (err) {
    if (!isLlmUnavailable(err)) return { ok: false, cause: 'error' };
    const after = afterLlmFailure(err.code, 1, 1);
    return { ok: false, cause: after === 'retry' ? 'error' : after };
  }
}

/** 조건 뽑기를 못 불렀다. 대신할 규칙 길이 없어 접수하지 않는다. 오늘 상한이 찬 경우만 429. */
function extractSkipped(cause: LlmSkipCause): AppError {
  const message = `문의 글에서 조건을 뽑지 못했습니다. ${LLM_SKIP_LABELS[cause]} 조건을 직접 골라 넣으면 계산은 그대로 됩니다.`;
  return new AppError(cause === 'daily_cap' ? 'LIMIT_EXCEEDED' : 'LLM_UNAVAILABLE', message, undefined, cause);
}

// ── 답장 ───────────────────────────────────────────────────

interface DraftedReply {
  reply: QuoteReply;
  call: QuoteCall | null;
  skipCause: LlmSkipCause | null;
}

/** 두 호출의 기록을 하나로. 돈과 시간은 더한다(다시 부른 것도 쓴 돈이다). 나머지는 마지막 호출의 것. */
function addCalls(first: QuoteCall | null, second: QuoteCall): QuoteCall {
  if (!first) return second;
  return { ...second, costUsd: first.costUsd + second.costUsd, latencyMs: first.latencyMs + second.latencyMs };
}

/**
 * 답장 초안을 쓴다. 본체의 글 만들기와 같은 순서다.
 *  1. 모델을 한 번 부르고 글 검사를 돌린다. 통과하면 그 글.
 *  2. 걸렸으면 걸린 까닭을 알려 한 번만 다시 부른다. 통과하면 그 글.
 *  3. 두 번 다 걸렸거나 모델을 못 불렀으면 코드가 만든 틀 문장이다(source 'template').
 *     두 번 다 걸린 경우 failCodes 에 모델의 마지막 글이 걸린 코드를 남기고 needs_review 로 둔다.
 * 숫자와 날짜는 맨 끝에 코드가 넣는다. 모델에게는 값이 가지 않는다.
 */
async function draftReply(args: {
  router: LlmRouter;
  input: QuoteReplyInput;
  candidate: QuoteCandidate | null;
  lang: QuoteLang;
  now: Date;
}): Promise<DraftedReply> {
  const { router, input, candidate, lang, now } = args;
  const values = replyValues(candidate);
  const fill = (template: string) => fillReply(template, values, lang, { vatIncluded: candidate?.pricing.vatIncluded ?? null });
  const made = (template: string, source: QuoteReply['source'], failCodes: ContentFailCode[]): QuoteReply => ({
    template,
    text: fill(template),
    source,
    status: failCodes.length === 0 ? 'ok' : 'needs_review',
    failCodes,
  });
  const fallback = (modelFails: ContentFailCode[] = []): QuoteReply => {
    const template = templateReply(input);
    // 틀 문장 자체가 걸리는 경우도 있다(용어집에 없는 한글 이름이 영어 답장에 남을 때). 그것도 숨기지 않는다.
    const own = checkReply(template, input);
    return made(template, 'template', [...new Set([...modelFails, ...own])]);
  };
  const textChars = charCount(input.inquiry);

  const first = await ask(router, buildQuoteReplyRequest(input), textChars, now);
  if (!first.ok) return { reply: fallback(), call: null, skipCause: first.cause };
  const firstText = first.output.reply.trim();
  const firstFails = checkReply(firstText, input);
  if (firstFails.length === 0) return { reply: made(firstText, 'llm', []), call: first.call, skipCause: null };

  const second = await ask(router, buildQuoteReplyRequest({ ...input, retryHint: replyRetryHint(firstFails, input) }), textChars, now);
  if (!second.ok) return { reply: fallback(firstFails), call: first.call, skipCause: null };
  const call = addCalls(first.call, second.call);
  const secondText = second.output.reply.trim();
  const secondFails = checkReply(secondText, input);
  if (secondFails.length === 0) return { reply: made(secondText, 'llm', []), call, skipCause: null };
  return { reply: fallback(secondFails), call, skipCause: null };
}

// ── 표 ─────────────────────────────────────────────────────

interface QuoteRow {
  id: string;
  workspace_id: string;
  inquiry_text: string;
  today: string;
  extraction: unknown;
  conditions: unknown;
  candidates: unknown;
  candidate_count: number;
  excluded: unknown;
  product_count: number;
  catalog: QuoteCatalog;
  selected_product_id: string | null;
  reply_template: string;
  reply_text: string;
  reply_source: QuoteReply['source'];
  reply_status: QuoteReply['status'];
  reply_fail_codes: ContentFailCode[];
  llm: unknown;
  status: QuoteStatus;
  confirmed_reply: string | null;
  confirmed_at: Date | null;
  created_at: Date;
}

// today 는 날짜 칸이다. 드라이버가 시각으로 바꾸지 않게 글자로 읽는다.
const COLUMNS = `id, workspace_id, inquiry_text, today::text AS today, extraction, conditions, candidates, candidate_count, excluded,
  product_count, catalog, selected_product_id, reply_template, reply_text, reply_source, reply_status, reply_fail_codes, llm,
  status, confirmed_reply, confirmed_at, created_at`;

const LlmColumnSchema = z.object({
  extract: z.custom<QuoteCall>((v) => typeof v === 'object' && v !== null),
  reply: z.custom<QuoteCall>((v) => typeof v === 'object' && v !== null).nullable(),
  replySkipCause: z.string().nullable(),
});

/** 표의 한 줄 → 응답. 표에 든 JSON 은 넣을 때 본 꼴이지만 꺼낼 때도 다시 본다. */
function toResponse(row: QuoteRow): QuoteResponse {
  const llm = LlmColumnSchema.parse(row.llm);
  return {
    workspace: row.workspace_id,
    id: toId(row.id),
    status: row.status,
    text: row.inquiry_text,
    today: row.today,
    extraction: QuoteExtractionSchema.parse(row.extraction),
    conditions: QuoteConditionsSchema.parse(row.conditions),
    candidates: z.array(QuoteCandidateSchema).parse(row.candidates),
    candidateCount: row.candidate_count,
    excluded: z.array(QuoteExcludedSchema).parse(row.excluded),
    catalog: row.catalog,
    productCount: row.product_count,
    selectedProductId: row.selected_product_id === null ? null : toId(row.selected_product_id),
    reply: { template: row.reply_template, text: row.reply_text, source: row.reply_source, status: row.reply_status, failCodes: row.reply_fail_codes },
    llm: { extract: llm.extract, reply: llm.reply, replySkipCause: llm.replySkipCause as LlmSkipCause | null },
    confirmedReply: row.confirmed_reply,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

async function quoteCount(db: Db, workspaceId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM quotes WHERE workspace_id = $1', [workspaceId]);
  return Number(rows[0]?.n ?? 0);
}

const quotesFull = () => new AppError('LIMIT_EXCEEDED', `한 공간에는 견적을 ${QUOTE_LIMITS.quotesPerWorkspace}건까지 둘 수 있습니다.`);

/** 응답과 표에 싣는 맞는 상품. 총액이 작은 것부터 상한까지. 고른 상품이 그 밖에 있으면 마지막 자리에 넣는다. */
function shownCandidates(all: readonly QuoteCandidate[], selected: QuoteCandidate | null): QuoteCandidate[] {
  const top = all.slice(0, QUOTE_LIMITS.maxCandidates);
  if (!selected || top.some((c) => c.productId === selected.productId)) return top;
  return [...top.slice(0, QUOTE_LIMITS.maxCandidates - 1), selected];
}

// ── 경로가 부르는 함수 셋 ──────────────────────────────────

/**
 * POST /api/quotes. 문의 글 한 건을 견적으로 만들어 저장한다.
 * 돈이 드는 일(모델 부르기)보다 먼저 볼 수 있는 것은 먼저 본다: 글의 꼴, 본보기 공간, 공간의 견적 수.
 * workspaceId 가 null 이면 저장할 때 새 공간을 만든다(그 공간에는 상품이 없으므로 catalog 가 'own' 이면 맞는 상품도 0개다).
 */
export async function createQuote(
  workspaceId: string | null,
  body: QuoteCreateRequest,
  now: Date,
  router: LlmRouter = llmRouterFromEnv(),
): Promise<QuoteResponse> {
  const text = cleanText(body.text);
  if (text === '') throw new AppError('BAD_INPUT', '문의 글이 비었습니다.');
  if (charCount(text) > QUOTE_LIMITS.textMaxChars) {
    throw new AppError('BAD_INPUT', `문의 글은 ${QUOTE_LIMITS.textMaxChars.toLocaleString('ko-KR')}자까지 넣을 수 있습니다.`);
  }
  if (workspaceId === PUBLIC_WORKSPACE_ID) throw new AppError('READ_ONLY_WORKSPACE', '본보기 공간은 읽기 전용입니다.');
  const pool = getPool();
  if (workspaceId && (await quoteCount(pool, workspaceId)) >= QUOTE_LIMITS.quotesPerWorkspace) throw quotesFull();
  const today = body.today ?? kstDay(now);

  // 1. 조건 뽑기. 모델은 글에 적힌 것만 옮긴다.
  const extracted = await ask(router, buildQuoteExtractRequest(text), charCount(text), now);
  if (!extracted.ok) throw extractSkipped(extracted.cause);
  const extraction: QuoteExtraction = extracted.output;

  // 2. 고르기·총액·마감. 전부 코드다.
  const conditions: QuoteConditions = resolveConditions(extraction, today);
  // 살필 상품. 본보기 공간의 상품은 누구나 읽을 수 있다(읽기만 한다. 견적은 요청한 공간에 저장된다).
  const catalog: QuoteCatalog = body.catalog ?? 'own';
  const catalogWorkspace = catalog === 'public' ? PUBLIC_WORKSPACE_ID : workspaceId;
  const products = catalogWorkspace ? await listProducts(pool, catalogWorkspace) : [];
  const matched = matchQuote(conditions, products, today);
  // 무엇을 찾는지 알 수 없는 문의(종류·갈래·지역이 하나도 없음)에는 상품을 대신 골라 주지 않는다. 사람이 골라 주면(productId) 그 상품으로 쓴다.
  const vague = body.productId === undefined && !hasSearchCondition(conditions);
  const first = vague ? null : (matched.candidates[0] ?? null);
  const selected = body.productId === undefined ? first : (matched.candidates.find((c) => c.productId === body.productId) ?? null);
  if (body.productId !== undefined && !selected) throw new AppError('BAD_INPUT', '고른 상품이 조건에 맞는 상품 가운데 없습니다.');

  // 3. 답장 초안. 용어집은 용어 사전의 승인된 줄 가운데 이 상품에 해당하는 것만.
  let glossary: GlossaryEntry[] = [];
  if (selected && conditions.lang !== 'ko') {
    const approved = await approvedGlossary(pool, workspaceId ?? PUBLIC_WORKSPACE_ID);
    glossary = pickGlossary(approved, { type: selected.type, subtype: selected.subtype, name: selected.name, region: selected.region });
  }
  const input = replyInputOf({ lang: conditions.lang, inquiry: text, candidate: selected, candidateCount: matched.candidates.length, glossary });
  // 되묻는 글은 코드의 틀 문장이다. 모델을 부르지 않는다(부를 까닭이 없다. replySkipCause 도 없다).
  const askText = askReply(conditions.lang);
  const drafted: DraftedReply = vague
    ? { reply: { template: askText, text: askText, source: 'template', status: 'ok', failCodes: [] }, call: null, skipCause: null }
    : await draftReply({ router, input, candidate: selected, lang: conditions.lang, now });

  // 4. 저장.
  const candidates = shownCandidates(matched.candidates, selected);
  const excluded: QuoteExcluded[] = matched.excluded.slice(0, QUOTE_LIMITS.maxExcluded);
  const llm = { extract: extracted.call, reply: drafted.call, replySkipCause: drafted.skipCause };
  return withTx(async (client) => {
    // 공간 줄이 잠겨 같은 공간의 견적 만들기가 한 줄로 선다. 그래서 수 세기가 상한을 넘지 않는다.
    const ws = await workspaceForWrite(client, workspaceId, now);
    if ((await quoteCount(client, ws.id)) >= QUOTE_LIMITS.quotesPerWorkspace) throw quotesFull();
    // 모델을 부르는 사이에 고른 상품이 지워졌을 수 있다. 그러면 번호 없이 적는다(견적의 글과 값은 그대로 남는다).
    const alive = selected ? await client.query('SELECT 1 FROM products WHERE id = $1 AND workspace_id = $2', [selected.productId, catalog === 'public' ? PUBLIC_WORKSPACE_ID : ws.id]) : null;
    const selectedId = selected && (alive?.rowCount ?? 0) > 0 ? selected.productId : null;
    const { rows } = await client.query<QuoteRow>(
      `INSERT INTO quotes (workspace_id, inquiry_text, lang, today, extraction, conditions, candidates, candidate_count, excluded, product_count,
                           catalog, selected_product_id, reply_template, reply_text, reply_source, reply_status, reply_fail_codes, llm, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19)
       RETURNING ${COLUMNS}`,
      [
        ws.id, text, conditions.lang, today, JSON.stringify(extraction), JSON.stringify(conditions), JSON.stringify(candidates),
        matched.candidates.length, JSON.stringify(excluded), products.length, catalog, selectedId,
        drafted.reply.template, drafted.reply.text, drafted.reply.source, drafted.reply.status, drafted.reply.failCodes, JSON.stringify(llm), now,
      ],
    );
    const response = toResponse(rows[0] as QuoteRow);
    // 응답의 고른 상품은 답장을 쓴 그 상품이다(방금 지워졌어도 이번 응답에서는 알려 준다).
    return { ...response, selectedProductId: selected?.productId ?? null };
  });
}

const notFound = () => new AppError('NOT_FOUND', '견적이 없습니다.');

/** GET /api/quotes/:id. 다른 공간의 견적이면 없는 것으로 답한다. */
export async function getQuote(workspaceId: string, quoteId: number, db: Db = getPool()): Promise<QuoteResponse> {
  const { rows } = await db.query<QuoteRow>(`SELECT ${COLUMNS} FROM quotes WHERE id = $1 AND workspace_id = $2`, [quoteId, workspaceId]);
  if (!rows[0]) throw notFound();
  return toResponse(rows[0]);
}

/**
 * POST /api/quotes/:id/confirm. 사람이 본(고친) 답장으로 확정한다. 표에 적는 것까지다. 어디로도 보내지 않는다.
 * 자리표시나 중괄호가 남았으면 BAD_INPUT, 이미 확정했으면 BAD_TRANSITION, 다른 공간의 견적이면 NOT_FOUND.
 */
export async function confirmQuote(workspaceId: string, quoteId: number, body: QuoteConfirmRequest, now: Date): Promise<QuoteResponse> {
  const reply = cleanText(body.reply);
  if (reply === '') throw new AppError('BAD_INPUT', '답장 글이 비었습니다.');
  if (charCount(reply) > QUOTE_LIMITS.replyMaxChars) {
    throw new AppError('BAD_INPUT', `답장은 ${QUOTE_LIMITS.replyMaxChars.toLocaleString('ko-KR')}자까지 넣을 수 있습니다.`);
  }
  if (hasLeftoverPlaceholder(reply)) {
    throw new AppError('BAD_INPUT', '답장에 자리표시나 중괄호({ })가 남아 있습니다. 값으로 바꾸거나 지운 뒤 확정해 주세요.');
  }
  return withTx(async (client) => {
    const found = await client.query<{ status: QuoteStatus }>('SELECT status FROM quotes WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [quoteId, workspaceId]);
    const row = found.rows[0];
    if (!row) throw notFound();
    if (row.status === 'confirmed') throw new AppError('BAD_TRANSITION', '이미 확정한 견적입니다.');
    await touchWorkspaceForWrite(client, workspaceId, now);
    const { rows } = await client.query<QuoteRow>(
      `UPDATE quotes SET status = 'confirmed', confirmed_reply = $2, confirmed_at = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
      [quoteId, reply, now],
    );
    return toResponse(rows[0] as QuoteRow);
  });
}
