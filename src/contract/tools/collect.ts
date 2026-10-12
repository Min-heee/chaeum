// 모으기의 약속. 파이썬 수집기(collector/)가 공공 자료를 받아 한 꼴로 정리한 줄을 서버가 받는다.
// 수집기와 서버 사이의 JSON 꼴은 docs/IMPORT-FORMAT.md 에 사람 말로 한 쪽 적혀 있다. 그 문서와 이 파일이 다르면 이 파일이 맞다.
//
//   POST /api/imports               정리된 줄 묶음(한 번에 500줄까지). 건별 결과를 돌려준다(202)
//   GET  /api/imports               받은 묶음 목록과 수
//   GET  /api/collected             모은 줄 목록·거르기
//   POST /api/collected/:id/draft   고른 줄을 본체의 초안으로(새 초안 201, 이미 만든 줄 200)
//
// 한 곳에서만 판단한다
// - 수집기는 받기·인코딩 판별·칸 이름 맞추기·꼴 정리까지 한다. 값이 맞는지와 중복인지는 서버가 다시 본다.
// - 줄을 초안으로 만들 때 LLM 을 부르지 않는다. 줄의 값을 "원문 표현"으로 삼아 본체의 맞추기·따지기(evaluateDraft)를 그대로 거친다.
//   가격이 없는 자료라 "필수 칸 빔"이 붙어 검수함의 확인 필요로 간다. 뽑은 방식은 'import' 로 남는다.
import { z } from 'zod';
import type { Extraction } from '../fields';
import { DRAFT_STATUSES } from '../transitions';

// ── 상한 ───────────────────────────────────────────────────

export const COLLECT_LIMITS = {
  /** 요청 하나의 줄 수 */
  rowsPerRequest: 500,
  /** 요청 본문의 크기(바이트). 500줄 × 원래 줄 4KB 가 들어간다. */
  requestMaxBytes: 3 * 1024 * 1024,
  /** 공간 하나에 모아 두는 줄 수 */
  itemsPerWorkspace: 2000,
  /** 공간 하나의 묶음 수 */
  batchesPerWorkspace: 100,
  /** 글자 칸의 글자 수 */
  textMaxChars: 200,
  /** 원래 줄(raw)을 JSON 글로 적었을 때의 글자 수 */
  rawMaxChars: 4000,
  /** 목록 한 쪽의 건수 */
  pageSize: 50,
} as const;

// ── 줄 하나 ────────────────────────────────────────────────

const text = z.string().trim().min(1).max(COLLECT_LIMITS.textMaxChars);

/** 표의 정수 칸(4바이트)이 받는 가장 큰 수. 이보다 큰 수는 꼴 검사에서 거른다(표에 넣다가 오류가 나지 않게). */
const INT4_MAX = 2_147_483_647;

/** 제어 글자(NUL, 줄바꿈 등)가 없는가. 출처의 이름·주소·이용 조건은 한 줄짜리 글이다. */
const noControlChars = (value: string): boolean => !/[\u0000-\u001f\u007f]/.test(value);
const CONTROL_MESSAGE = '제어 글자(줄바꿈, NUL 등)는 넣을 수 없습니다.';
const optionalText = text.nullable().optional();

/**
 * 수집기가 붙이는 표시. encoding_guessed: 인코딩을 짐작해 읽었다.
 * unit_assumed: 값에도 칸 이름에도 단위가 적혀 있지 않아 그 출처의 기본 단위(수집기의 출처 목록에 사람이 적은 mm·cm·m)로 읽었다.
 */
export const COLLECTOR_FLAGS = ['encoding_guessed', 'unit_assumed'] as const;

/**
 * 서버가 붙이는 표시.
 * - no_name: 이름이 없다           - no_location: 주소·지역·역이 모두 없다
 * - no_size: 가로나 세로가 없다    - odd_size: 가로나 세로가 oddSizeOverM 보다 크다(단위가 틀렸을 수 있다)
 */
export const SERVER_FLAGS = ['no_name', 'no_location', 'no_size', 'odd_size'] as const;

export const COLLECT_FLAGS = [...COLLECTOR_FLAGS, ...SERVER_FLAGS] as const;
export type CollectFlag = (typeof COLLECT_FLAGS)[number];

export const COLLECT_FLAG_LABELS: Record<CollectFlag, string> = {
  encoding_guessed: '인코딩을 짐작해 읽음',
  unit_assumed: '단위가 적혀 있지 않아 출처의 기본 단위로 봄',
  no_name: '이름 없음',
  no_location: '위치 없음',
  no_size: '크기 없음',
  odd_size: '크기가 너무 큼',
};

export const COLLECT_RULES = { oddSizeOverM: 100 } as const;

/**
 * 정리된 줄 하나(수집기 → 서버). 칸 이름은 이 꼴 그대로다. 없는 값은 null 로 주거나 칸을 뺀다.
 * 숫자는 숫자로 준다(글자 "7.5" 는 받지 않는다). 가로·세로는 m 단위다.
 */
export const ImportRowSchema = z.strictObject({
  /** 출처 파일 안의 줄 번호(머리줄 다음이 1). 같은 출처에서 줄을 찾아갈 때 쓴다. 표의 칸(4바이트 정수)이 받는 수까지다. */
  line: z.number().int().min(1).max(INT4_MAX),
  /** 종류. 자료에 적힌 큰 갈래("전광판", "옥외광고", "지하철 광고"). */
  kind: optionalText,
  name: optionalText,
  /** 지역(시·구·동) */
  region: optionalText,
  /** 주소 */
  address: optionalText,
  /** 호선("2호선") */
  subway_line: optionalText,
  /** 역("홍대입구역") */
  station: optionalText,
  /** 매체 종류("LED 전광판", "스크린도어", "조명광고") */
  media_type: optionalText,
  width_m: z.number().positive().max(10_000).nullable().optional(),
  height_m: z.number().positive().max(10_000).nullable().optional(),
  /** 수량(면, 기) */
  quantity: z.number().int().min(0).max(1_000_000).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  /** 운영 기관 */
  operator: optionalText,
  /** 원래 줄 그대로(원래 칸 이름 → 값). 사람이 견줄 때 쓴다. */
  raw: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  flags: z.array(z.enum(COLLECTOR_FLAGS)).max(COLLECTOR_FLAGS.length).optional(),
});
export type ImportRow = z.infer<typeof ImportRowSchema>;

/** 출처 하나. 무엇을 어디서 어떤 조건으로 받았는지 묶음마다 남긴다. */
export const ImportSourceSchema = z.strictObject({
  /** 출처의 짧은 번호(수집기의 출처 목록에 적힌 것). 소문자·숫자·줄표. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
  /** 자료 이름과 낸 기관 */
  name: text.refine(noControlChars, CONTROL_MESSAGE),
  /** 받은 주소 */
  url: z.string().url().max(500).refine(noControlChars, CONTROL_MESSAGE),
  /** 이용 조건(예: "공공누리 제1유형", "이용허락범위 제한 없음") */
  license: text.refine(noControlChars, CONTROL_MESSAGE),
  /** 받은 시각(ISO 8601) */
  fetchedAt: z.string().datetime({ offset: true }),
});
export type ImportSource = z.infer<typeof ImportSourceSchema>;

/**
 * POST /api/imports 의 요청.
 * rows 의 줄은 하나씩 따로 검사한다(한 줄이 틀려도 나머지는 들어간다). 그래서 여기서는 줄의 꼴을 묻지 않는다.
 * collector: 수집기가 서버로 보내기 전에 스스로 뺀 줄의 수. 서버는 세지 못하는 수라 받은 그대로 묶음에 적는다.
 *   파일 전체에서 뺀 수다. 수집기는 줄을 골라 보낼 때(--limit, --skip-mark) 이 칸을 싣지 않는다.
 */
export const ImportRequestSchema = z.strictObject({
  source: ImportSourceSchema,
  rows: z.array(z.unknown()).min(1).max(COLLECT_LIMITS.rowsPerRequest),
  collector: z
    .strictObject({
      /** 수집기가 읽지 못해 뺀 줄 */
      unreadable: z.number().int().min(0).max(INT4_MAX).default(0),
      /** 수집기가 같은 파일 안의 중복으로 뺀 줄 */
      duplicates: z.number().int().min(0).max(INT4_MAX).default(0),
    })
    .optional(),
});
export type ImportRequest = z.infer<typeof ImportRequestSchema>;

// ── 중복 열쇠 ──────────────────────────────────────────────

const keyPart = (value: string | null | undefined): string => (value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const numPart = (value: number | null | undefined): string => (value === null || value === undefined ? '' : String(Math.round(value * 100) / 100));

/**
 * 중복 열쇠. 같은 공간에 같은 열쇠는 한 건이다(표의 유일 제약). "같은 위치·같은 규격"을 한 건으로 본다.
 * 조각 일곱을 | 로 잇는다: 위치(주소, 없으면 지역) | 호선 | 역 | 매체 종류 | 가로 | 세로 | 이름
 * - 글자 조각은 NFKC 로 맞추고 소문자로 바꾼 뒤 빈칸을 전부 뗀다. 수는 소수 둘째 자리로 반올림한다. 없는 조각은 빈 글자다.
 * - 이름 조각은 위치·역이 모두 비었을 때만 넣는다(그때는 이름 말고 가를 것이 없다). 그 밖에는 빈 글자다.
 *   같은 자리의 같은 규격을 출처마다 다른 이름으로 적어도 한 건이 되게 하려는 것이다.
 * - 출처는 열쇠에 넣지 않는다. 다른 출처가 같은 자리를 적었으면 중복이다.
 * 수집기도 같은 식으로 미리 뺄 수 있지만 맞고 틀림은 서버의 이 함수가 정한다.
 */
export function collectDedupeKey(row: Pick<ImportRow, 'address' | 'region' | 'subway_line' | 'station' | 'media_type' | 'width_m' | 'height_m' | 'name'>): string {
  const place = keyPart(row.address) || keyPart(row.region);
  const station = keyPart(row.station);
  const name = place === '' && station === '' ? keyPart(row.name) : '';
  return [place, keyPart(row.subway_line), station, keyPart(row.media_type), numPart(row.width_m), numPart(row.height_m), name].join('|');
}

/** 서버가 줄에 붙이는 표시. 순서는 SERVER_FLAGS 그대로. */
export function serverFlagsOf(row: Pick<ImportRow, 'name' | 'address' | 'region' | 'station' | 'width_m' | 'height_m'>): (typeof SERVER_FLAGS)[number][] {
  const flags: (typeof SERVER_FLAGS)[number][] = [];
  if (!row.name) flags.push('no_name');
  if (!row.address && !row.region && !row.station) flags.push('no_location');
  const sizes = [row.width_m, row.height_m];
  if (sizes.some((v) => v === null || v === undefined)) flags.push('no_size');
  if (sizes.some((v) => typeof v === 'number' && v > COLLECT_RULES.oddSizeOverM)) flags.push('odd_size');
  return flags;
}

// ── 받기의 응답 ────────────────────────────────────────────

const id = z.number().int().positive();
const index = z.number().int().min(0);

/** 줄 하나의 결과. index 는 요청의 rows 에서 몇째인가(0부터). line 은 줄이 읽혔을 때만. */
export const ImportItemSchema = z.discriminatedUnion('result', [
  z.object({ index, line: z.number().int(), result: z.literal('new'), itemId: id }),
  /** 같은 열쇠의 줄이 이미 있다(이번 요청의 앞줄이거나 전에 받은 줄). itemId 는 있던 줄의 번호. */
  z.object({ index, line: z.number().int(), result: z.literal('duplicate'), itemId: id }),
  /** BAD_ROW: 줄의 꼴이 틀렸다. LIMIT_EXCEEDED: 공간의 줄 수 상한에 닿았다. */
  z.object({ index, result: z.literal('error'), code: z.enum(['BAD_ROW', 'LIMIT_EXCEEDED']), message: z.string() }),
]);
export type ImportItem = z.infer<typeof ImportItemSchema>;

export const ImportBatchSchema = z.object({
  id,
  source: ImportSourceSchema,
  /** 서버가 받은 줄 = new + duplicate + unreadable */
  received: z.number().int().min(0),
  /** 새로 들어간 줄 */
  new: z.number().int().min(0),
  /** 중복이라 넣지 않은 줄 */
  duplicate: z.number().int().min(0),
  /** 서버가 읽지 못한 줄(꼴이 틀림, 상한) */
  unreadable: z.number().int().min(0),
  /** 수집기가 보내기 전에 스스로 뺀 줄(읽지 못함 / 파일 안 중복). 수집기가 알려 준 그대로다. */
  collectorUnreadable: z.number().int().min(0),
  collectorDuplicates: z.number().int().min(0),
  receivedAt: z.string().min(1),
});
export type ImportBatch = z.infer<typeof ImportBatchSchema>;

/**
 * POST /api/imports 의 응답(202). 한 줄도 못 넣었어도 묶음은 남는다(무엇을 받았다가 못 넣었는지가 기록이다).
 * 공간 번호 없이 오면 그때 새 공간을 만들고 workspace 에 돌려준다. 수집기는 이 번호를 다음 요청의 X-Workspace 로 쓴다.
 * 오류: 본문의 꼴(출처, 500줄 초과) 400 · 본문 크기 413 · 본보기 공간 403 · 공간의 묶음 수 상한 429.
 */
export const ImportResponseSchema = z.object({
  workspace: z.string().uuid(),
  batch: ImportBatchSchema,
  items: z.array(ImportItemSchema),
});
export type ImportResponse = z.infer<typeof ImportResponseSchema>;

/** GET /api/imports 의 응답. 묶음은 새것부터. */
export const ImportListResponseSchema = z.object({
  batches: z.array(ImportBatchSchema),
  totals: z.object({
    /** 서로 다른 출처의 수 */
    sources: z.number().int().min(0),
    received: z.number().int().min(0),
    new: z.number().int().min(0),
    duplicate: z.number().int().min(0),
    unreadable: z.number().int().min(0),
    collectorUnreadable: z.number().int().min(0),
    collectorDuplicates: z.number().int().min(0),
    /** 지금 공간에 있는 모은 줄 */
    items: z.number().int().min(0),
    /** 그 가운데 초안이 된 줄 */
    drafted: z.number().int().min(0),
  }),
});
export type ImportListResponse = z.infer<typeof ImportListResponseSchema>;

// ── 모은 줄 ────────────────────────────────────────────────

/** 모은 줄 하나(표 collected_items 의 한 줄). */
export const CollectedItemSchema = z.object({
  id,
  batchId: id,
  sourceId: z.string(),
  sourceName: z.string(),
  line: z.number().int(),
  kind: z.string().nullable(),
  name: z.string().nullable(),
  region: z.string().nullable(),
  address: z.string().nullable(),
  subwayLine: z.string().nullable(),
  station: z.string().nullable(),
  mediaType: z.string().nullable(),
  widthM: z.number().nullable(),
  heightM: z.number().nullable(),
  quantity: z.number().int().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  operator: z.string().nullable(),
  raw: z.record(z.string(), z.unknown()),
  flags: z.array(z.enum(COLLECT_FLAGS)),
  /** 이 줄로 만든 초안의 번호. 아직이면 null. */
  draftId: id.nullable(),
  createdAt: z.string().min(1),
});
export type CollectedItem = z.infer<typeof CollectedItemSchema>;

/** GET /api/collected 의 주소 값. 모두 선택이다. q 는 이름·주소·지역·역에서 찾는 글자. */
export const CollectedQuerySchema = z.object({
  sourceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/).optional(),
  flag: z.enum(COLLECT_FLAGS).optional(),
  drafted: z.enum(['yes', 'no']).optional(),
  q: z.string().trim().min(1).max(60).optional(),
  /** 지난 응답의 nextCursor */
  cursor: z.coerce.number().int().positive().optional(),
});
export type CollectedQuery = z.infer<typeof CollectedQuerySchema>;

/** GET /api/collected 의 응답. 새것부터. total 은 걸러 낸 뒤의 전체 수. */
export const CollectedListResponseSchema = z.object({
  items: z.array(CollectedItemSchema),
  nextCursor: id.nullable(),
  total: z.number().int().min(0),
});
export type CollectedListResponse = z.infer<typeof CollectedListResponseSchema>;

/**
 * POST /api/collected/:id/draft 의 응답. 요청 본문은 없다.
 * 새 초안이면 201, 이 줄로 이미 초안을 만들었으면 200(duplicate) 이고 있던 초안을 돌려준다.
 * 오류: 없는 줄·다른 공간의 줄 404 · 본보기 공간 403 · 공간의 초안 수나 오늘 접수 상한 429.
 */
export const CollectedDraftResponseSchema = z.object({
  workspace: z.string().uuid(),
  itemId: id,
  sourceDocId: id,
  draftId: id,
  status: z.enum(DRAFT_STATUSES),
  duplicate: z.boolean(),
});
export type CollectedDraftResponse = z.infer<typeof CollectedDraftResponseSchema>;

// ── 줄 → 초안(src/tools/collect 가 내보낼 순수 함수의 꼴) ───

/**
 * 모은 줄을 본체의 초안 재료로 바꾼다. LLM 을 부르지 않는다.
 * - sourceText: 초안의 "원문"이 되는 글. 줄의 값을 "이름표: 값" 한 줄씩으로 적고, 첫 줄에 출처 번호와 줄 번호를 적는다
 *   (그래서 줄마다 글이 다르다. 같은 글은 한 건이라는 본체의 규칙에 걸리지 않는다).
 * - extraction: 뽑기 결과의 꼴(fields.ts 의 Extraction). 종류는 'ad', 갈래는 매체 종류를 본체의 갈래 목록에 맞춰 본 것
 *   (맞는 것이 없으면 자료의 말 그대로 두어 "종류·갈래 불일치"로 사람이 보게 한다).
 *   칸마다 raw 는 sourceText 에 그대로 있는 구절이고 value 는 null 이다(코드가 raw 를 읽어 맞춘다). evidence 는 raw 가 든 그 줄.
 *   채우는 칸: name ← 이름, region ← 역(없으면 지역, 없으면 주소), size_m ← "가로x세로m". 나머지 칸은 자료에 없어 비운다.
 * 이 둘을 evaluateDraft({ sourceText, extraction, extractedBy: 'import' }) 에 넣은 결과가 초안의 칸과 사유가 된다.
 * 규칙만 길이 아니므로 LLM_SKIPPED 는 붙이지 않는다.
 */
export interface CollectDraftApi {
  itemToSourceText(item: CollectedItem): string;
  itemToExtraction(item: CollectedItem, sourceText: string): Extraction;
}
