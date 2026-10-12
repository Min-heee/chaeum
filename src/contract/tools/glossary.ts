// 용어 사전의 약속. 번역 표기를 한곳(표 glossary_terms)에서 정한다.
// 글 만들기와 글 검사는 "승인된 용어"만 본다. 제안 상태의 줄은 어디에도 쓰이지 않는다.
//
//   GET   /api/glossary        공용 줄 + 내 공간의 줄
//   POST  /api/glossary        내 공간에 한 줄 더하기(201). 공간이 없으면 그때 만든다
//   PATCH /api/glossary/:id    내 공간의 줄 고치기·승인·승인 풀기
//
// 줄에는 두 가지가 있다.
// - 공용 줄: 본보기 공간(PUBLIC_WORKSPACE_ID)의 줄. 씨앗(npm run db:seed)이 data/seed/glossary.json 을 승인 상태로 싣는다.
//   방문자는 고치지 못한다(403 READ_ONLY_WORKSPACE).
// - 내 줄: 방문자 공간의 줄. 같은 한국어 낱말이 공용 줄에 있으면 내 줄이 이긴다(승인된 내 줄만).
//
// 장부 키와의 관계: 글 만들기 요청에는 그 상품에 해당하는 용어 줄({ko, en, zh-Hans} 셋만)이 한국어 낱말 순서로 들어간다.
// 번호·상태·메모는 요청에 들어가지 않는다. 그래서 승인된 용어가 그대로면 요청이 같고 장부 키도 같다(받아 둔 녹화본이 그대로 맞는다).
// 승인된 줄을 고치거나 더하면 그 낱말이 든 상품의 요청만 달라진다.
import { z } from 'zod';
import type { GlossaryEntry } from '../content';

export const GLOSSARY_STATUSES = ['proposed', 'approved'] as const;
export type GlossaryStatus = (typeof GLOSSARY_STATUSES)[number];

export const GLOSSARY_STATUS_LABELS: Record<GlossaryStatus, string> = { proposed: '제안', approved: '승인' };

export const GLOSSARY_LIMITS = {
  /** 공간 하나의 용어 줄 수 */
  termsPerWorkspace: 200,
  /** 한국어 낱말·표기의 글자 수 */
  termMaxChars: 60,
  /** 메모의 글자 수 */
  noteMaxChars: 200,
} as const;

const term = z.string().trim().min(1).max(GLOSSARY_LIMITS.termMaxChars);
const note = z.string().trim().max(GLOSSARY_LIMITS.noteMaxChars);

/** 용어 한 줄(표 glossary_terms 의 한 줄). 칸 이름은 용어집 줄(GlossaryEntry)과 같다. */
export const GlossaryTermSchema = z.object({
  id: z.number().int().positive(),
  ko: z.string(),
  /** 제안 상태에서는 아직 없을 수 있다. 승인된 줄에는 둘 다 꼭 있다. */
  en: z.string().nullable(),
  'zh-Hans': z.string().nullable(),
  status: z.enum(GLOSSARY_STATUSES),
  note: z.string().nullable(),
  /** 공용 줄인가. 참이면 고칠 수 없다. */
  shared: z.boolean(),
  /** 같은 낱말의 내 승인 줄에 가려 쓰이지 않는 공용 줄인가 */
  overridden: z.boolean(),
  updatedAt: z.string().min(1),
});
export type GlossaryTerm = z.infer<typeof GlossaryTermSchema>;

/** GET /api/glossary 의 주소 값. */
export const GlossaryListQuerySchema = z.object({ status: z.enum(GLOSSARY_STATUSES).optional() });

/** GET /api/glossary 의 응답. 공용 줄이 먼저, 그 안에서는 한국어 낱말 순서. counts 는 거르기 전의 수다. */
export const GlossaryListResponseSchema = z.object({
  items: z.array(GlossaryTermSchema),
  counts: z.record(z.enum(GLOSSARY_STATUSES), z.number().int().min(0)),
  /** 지금 이 공간의 글 만들기·글 검사가 쓰는 용어의 수(승인된 공용 줄 + 승인된 내 줄, 겹침 없이) */
  inUse: z.number().int().min(0),
});
export type GlossaryListResponse = z.infer<typeof GlossaryListResponseSchema>;

/**
 * POST /api/glossary 의 요청. status 를 비우면 제안으로 들어간다.
 * 승인으로 넣으려면 두 표기가 다 있어야 한다(없으면 400). 같은 공간에 같은 한국어 낱말이 이미 있으면 409 ALREADY_EXISTS.
 * 공간의 줄 수가 상한에 닿으면 429.
 */
export const GlossaryCreateRequestSchema = z
  .strictObject({
    ko: term,
    en: term.nullable().optional(),
    'zh-Hans': term.nullable().optional(),
    note: note.nullable().optional(),
    status: z.enum(GLOSSARY_STATUSES).optional(),
  })
  .refine((v) => v.status !== 'approved' || (Boolean(v.en) && Boolean(v['zh-Hans'])), '승인하려면 두 표기가 다 있어야 한다');
export type GlossaryCreateRequest = z.infer<typeof GlossaryCreateRequestSchema>;

/**
 * PATCH /api/glossary/:id 의 요청. 준 칸만 고친다. 한국어 낱말은 고치지 못한다(다른 낱말이면 새 줄이다).
 * 고친 뒤의 줄이 승인인데 표기가 비면 400. 공용 줄이면 403, 다른 공간의 줄이거나 없는 번호면 404.
 * version 을 두지 않았다. 한 공간을 한 사람이 쓰는 도구라 나중에 쓴 것이 이긴다.
 */
export const GlossaryPatchRequestSchema = z
  .strictObject({
    en: term.nullable().optional(),
    'zh-Hans': term.nullable().optional(),
    note: note.nullable().optional(),
    status: z.enum(GLOSSARY_STATUSES).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), '고칠 것이 없다');
export type GlossaryPatchRequest = z.infer<typeof GlossaryPatchRequestSchema>;

/** POST(201)·PATCH(200)의 응답. workspace 는 쓴 공간의 번호다(POST 가 공간을 새로 만들었으면 화면이 저장한다). */
export const GlossaryWriteResponseSchema = z.object({ workspace: z.string().uuid(), term: GlossaryTermSchema });
export type GlossaryWriteResponse = z.infer<typeof GlossaryWriteResponseSchema>;

// ── 쓰이는 용어를 정하는 규칙(순수 함수) ────────────────────

/** 표의 줄에서 이 함수가 보는 것. */
export interface GlossaryRow {
  ko: string;
  en: string | null;
  'zh-Hans': string | null;
  status: GlossaryStatus;
}

/**
 * 한 공간에서 실제로 쓰이는 용어집을 만든다. 글 만들기·글 검사·점검이 모두 이 결과만 본다.
 * - 승인된 줄만 쓴다. 표기가 빈 줄은 승인이어도 버린다(표의 CHECK 가 막지만 한 번 더 본다).
 * - 내 줄이 공용 줄보다 먼저다. 같은 한국어 낱말은 앞의 것만 남긴다.
 * - 돌려주는 줄에는 { ko, en, zh-Hans } 셋만 있다. 순서는 한국어 낱말의 글자순이다.
 */
export function effectiveGlossary(own: readonly GlossaryRow[], shared: readonly GlossaryRow[]): GlossaryEntry[] {
  const picked = new Map<string, GlossaryEntry>();
  for (const row of [...own, ...shared]) {
    if (row.status !== 'approved' || !row.en || !row['zh-Hans']) continue;
    if (!picked.has(row.ko)) picked.set(row.ko, { ko: row.ko, en: row.en, 'zh-Hans': row['zh-Hans'] });
  }
  return [...picked.values()].sort((a, b) => (a.ko < b.ko ? -1 : a.ko > b.ko ? 1 : 0));
}
