// 작업 종류별 처리기. 작업자(npm run worker)와 /jobs/drain 이 이 지도를 줄에 넘긴다.
//
//   extract: 길 고르기 → 뽑기 → 맞추기 → 따지기 → 갈래 → 칸·사유·상태 저장. 죽으면 초안을 FAILED 로.
//   content: 승인된 상품의 두 언어 글 만들기 → product_texts. 죽으면 틀 문장 넷을 "글 확인 필요"로 남긴다.
//
// 일(work)은 트랜잭션 밖에서 돈다. LLM 을 부르는 동안 DB 연결을 붙잡지 않는다.
// 저장(돌려주는 함수)은 줄이 "done 표시"와 같은 트랜잭션에서 부른다. 여러 번 돌아도 결과가 한 번만 남는다:
// 뽑기는 초안이 PROCESSING 일 때만 쓰고, 글은 (상품, 칸, 언어)가 같으면 덮어쓴다.
import type { PoolClient } from 'pg';
import { GlossarySchema, type ContentApi, type GeneratedText, type GlossaryEntry, type ProductText } from '@/contract/content';
import type { ExtractOutcome, ExtractStep, LlmRouter } from '@/contract/pipeline-api';
import type { DraftStatus } from '@/contract/transitions';
import glossaryJson from '../../data/seed/glossary.json';
import { contentApi } from './content-api';
import { contentInputOf } from './content-input';
import { getPool } from './db';
import { llmRouterFromEnv } from './llm-router';
import { createContentStep } from './pipeline/content';
import { extract as extractStep } from './pipeline/extract';
import type { JobHandler, JobHandlers, SaveFn } from './queue';
import { getDraftById, saveFields, transitionDraft } from './repos/drafts';
import { getProductById, saveProductTexts } from './repos/products';
import { getSource } from './repos/source-docs';
import { failDraftIfProcessing } from './review';

export interface JobHandlerDeps {
  /** 시계. 작업자와 /jobs/drain 이 준다. */
  now: () => Date;
  /** 길을 고르는 자리. 비우면 환경 변수로 만든 것. */
  router?: LlmRouter;
  /** 뽑기 단계. 비우면 진짜 단계. */
  extract?: ExtractStep;
  /** 글 만들기(src/content 가 내보내는 것). 없으면 글 처리기를 두지 않고, 글 작업은 줄에서 기다린다. */
  content?: ContentPort;
  /** 용어집. 비우면 data/seed/glossary.json. */
  glossary?: readonly GlossaryEntry[];
}

/** 처리기가 글 만들기에서 쓰는 것. templateTexts 가 있으면 글 작업이 죽었을 때 틀 문장을 그것으로 만든다. */
export type ContentPort = Pick<ContentApi, 'generateContent' | 'pickGlossary'> & Partial<Pick<ContentApi, 'templateTexts'>>;

/** data/seed/glossary.json. 꼴이 틀리면 여기서 멈춘다. */
export function seedGlossary(): GlossaryEntry[] {
  return GlossarySchema.parse(glossaryJson);
}

/** 뽑기 결과를 초안에 쓴다. 초안이 아직 PROCESSING 일 때만 쓴다(줄을 잠그고 본다). */
export function saveExtraction(draftId: number, outcome: ExtractOutcome): SaveFn {
  return async (client: PoolClient, at: Date) => {
    const { rows } = await client.query<{ status: DraftStatus; version: number; workspace_id: string }>(
      'SELECT status, version, workspace_id FROM drafts WHERE id = $1 FOR UPDATE',
      [draftId],
    );
    const current = rows[0];
    // 공간이 지워졌거나, 먼저 끝난 실행이 이미 써 뒀다. 두 번 쓰지 않는다.
    if (!current || current.status !== 'PROCESSING') return;

    const { evaluation, llm } = outcome;
    await saveFields(client, draftId, evaluation.fields);
    await transitionDraft(client, {
      workspaceId: current.workspace_id,
      draftId,
      to: evaluation.route,
      expectedVersion: current.version,
      actor: 'system',
      patch: {
        type: evaluation.type,
        subtype: evaluation.subtype,
        reasons: evaluation.draftReasons,
        extractedBy: outcome.extractedBy,
        model: llm?.model ?? null,
        promptVersion: llm?.promptVersion ?? null,
        llmSkipCause: outcome.skipCause,
        // 장부에서 꺼냈으면 true, 이번에 실제로 불렀으면 false. 시험용 구현은 둘 다 아니라 비워 둔다.
        llmRecorded: llm ? (llm.recorded ? true : llm.live ? false : null) : null,
        llmLatencyMs: llm ? Math.round(llm.latencyMs) : null,
        llmCostUsd: llm ? llm.costUsd : null,
      },
      now: at,
    });
  };
}

function extractHandler(deps: JobHandlerDeps): JobHandler {
  const step = deps.extract ?? extractStep;
  return {
    async work(job) {
      const pool = getPool();
      const draft = await getDraftById(pool, job.refId);
      // 초안이 없거나(공간이 지워짐) 이미 끝난 초안이면 모델을 부르지 않는다.
      if (!draft || draft.status !== 'PROCESSING') return;
      const source = await getSource(pool, draft.sourceDocId);
      if (!source) return;

      const outcome = await step(
        { sourceText: source.text, transcribed: source.kind !== 'text', attempt: job.attempts, now: deps.now() },
        deps.router ?? llmRouterFromEnv(),
      );
      return saveExtraction(draft.id, outcome);
    },
    async onDead(client, job, now) {
      await failDraftIfProcessing(client, job.refId, now);
    },
  };
}

const plainTexts = (texts: readonly GeneratedText[]): ProductText[] =>
  texts.map((t) => ({ field: t.field, lang: t.lang, text: t.text, source: t.source, status: t.status, failCodes: t.failCodes }));

function contentHandler(deps: JobHandlerDeps, content: NonNullable<JobHandlerDeps['content']>): JobHandler {
  const step = createContentStep(content);
  return {
    /**
     * 글 작업이 죽었다. 상품의 글이 끝없이 "만드는 중"으로 남지 않게, 글이 한 줄도 없으면 틀 문장 넷을 "글 확인 필요"로 써 넣는다.
     * 모델은 부르지 않는다. 이미 글이 있으면(먼저 끝난 실행이 썼다) 건드리지 않는다.
     */
    async onDead(client, job) {
      const product = await getProductById(client, job.refId);
      if (!product) return;
      const has = await client.query('SELECT 1 FROM product_texts WHERE product_id = $1 LIMIT 1', [product.id]);
      if ((has.rowCount ?? 0) > 0) return;
      const input = contentInputOf(product, deps.glossary ?? seedGlossary(), content.pickGlossary);
      const texts = content.templateTexts ? content.templateTexts(input) : (await content.generateContent(input, null, 'error')).texts;
      await saveProductTexts(client, product.id, plainTexts(texts));
    },
    async work(job) {
      const product = await getProductById(getPool(), job.refId);
      if (!product) return;
      const generated = await step(
        { generate: contentInputOf(product, deps.glossary ?? seedGlossary(), content.pickGlossary), attempt: job.attempts, now: deps.now() },
        deps.router ?? llmRouterFromEnv(),
      );
      const texts = plainTexts(generated.texts);
      return async (client) => {
        // 그사이 공간이 지워졌으면 쓸 곳이 없다.
        const alive = await client.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [product.id]);
        if (alive.rowCount === 0) return;
        await saveProductTexts(client, product.id, texts);
      };
    },
  };
}

export function createJobHandlers(deps: JobHandlerDeps): JobHandlers {
  const handlers: JobHandlers = { extract: extractHandler(deps) };
  if (deps.content) handlers.content = contentHandler(deps, deps.content);
  return handlers;
}

/** 서버가 쓰는 기본 처리기. 길은 환경 변수로, 글 만들기는 content-api.ts 에 끼운 것으로. */
export function defaultJobHandlers(now: () => Date): JobHandlers {
  return createJobHandlers({ now, content: contentApi });
}
