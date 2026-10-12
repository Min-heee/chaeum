// 시안 검사의 약속. 광고 시안 파일이 그 지면의 규격에 맞는지 본다.
// 파일 머리에서 가로·세로·형식·용량·길이를 읽어, 본체가 채운 규격 칸(해상도, 파일 형식, 한 번 길이)과 견준다.
// LLM 을 쓰지 않는다. 파일도 결과도 저장하지 않는다. 내용 심사(문구, 초상)는 하지 않는다.
//
//   POST /api/creative-checks
//     · multipart/form-data: 글자 칸 "productId" + 파일 칸 "file" 하나  → 서버가 파일 머리를 읽는다(readBy: 'server')
//     · JSON { productId, facts, fileName? }                            → 화면이 브라우저에서 같은 순수 함수로 읽은 것을 보낸다(readBy: 'client')
//   둘째 길을 둔 까닭: 호스팅이 받는 요청 본문이 4.5MB 까지라 영상 시안은 대개 올리지 못한다.
//   파일을 읽는 함수(src/tools/creative)는 바이트만 받는 순수 함수라 브라우저에서도 돈다. 큰 파일은 서버로 보내지 않고 읽은 값만 보낸다.
//   둘째 길에서는 서버가 파일을 보지 못했다. 응답과 화면이 그렇게 적는다.
import { z } from 'zod';
import { PRODUCT_TYPES } from '../fields';

// ── 파일 ───────────────────────────────────────────────────

/** 받는 형식 넷. 이름은 본체의 파일 형식 칸(file_format)에 적히는 소문자 확장자와 같다. */
export const CREATIVE_FORMATS = ['jpg', 'png', 'webp', 'mp4'] as const;
export type CreativeFormat = (typeof CREATIVE_FORMATS)[number];

export const CREATIVE_MEDIA_TYPES: Record<CreativeFormat, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
};

/** 규격의 형식 이름을 견줄 때 같은 것으로 치는 이름. "jpeg" 는 "jpg" 다. 그 밖에는 소문자로 바꿔 글자 그대로 견준다. */
export const CREATIVE_FORMAT_ALIASES: Record<string, CreativeFormat> = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp', mp4: 'mp4' };

export const CREATIVE_LIMITS = {
  /** 서버가 받는 파일 하나의 크기(바이트). 요청 본문 한도 안에 든다. */
  fileMaxBytes: 4 * 1024 * 1024,
  /** 요청 본문 전체(바이트). 넘으면 파일을 읽기 전에 413. */
  requestMaxBytes: 4_400_000,
  /** 화면이 읽은 값만 보낼 때 받는 파일 크기의 상한(바이트). 이보다 큰 값은 잘못 적은 것으로 본다. */
  declaredMaxBytes: 2 * 1024 * 1024 * 1024,
  /** multipart 의 칸 이름 */
  formField: 'file',
  productField: 'productId',
} as const;

/**
 * 파일에서 읽은 것. 브라우저가 보낸 형식 이름은 믿지 않고 머리 바이트로 정한다.
 * - JPG: SOF 마커의 가로·세로.  - PNG: IHDR.  - WEBP: VP8 / VP8L / VP8X 머리.
 * - MP4: moov 안의 영상 트랙(tkhd)의 가로·세로와 mvhd 의 길이(duration ÷ timescale).
 * 읽지 못한 값은 null 이다(짐작하지 않는다). 형식조차 모르면 415, 형식은 알지만 가로·세로를 못 읽으면 422.
 */
export const CreativeFactsSchema = z.object({
  format: z.enum(CREATIVE_FORMATS),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /** 파일 전체의 크기(바이트) */
  sizeBytes: z.number().int().positive().max(CREATIVE_LIMITS.declaredMaxBytes),
  /** 영상의 길이(초, 소수 둘째 자리까지). 그림이면 null. */
  durationSeconds: z.number().positive().nullable(),
});
export type CreativeFacts = z.infer<typeof CreativeFactsSchema>;

/** JSON 으로 부를 때의 요청. */
export const CreativeCheckRequestSchema = z.strictObject({
  productId: z.number().int().positive(),
  facts: CreativeFactsSchema,
  fileName: z.string().max(200).optional(),
});
export type CreativeCheckRequest = z.infer<typeof CreativeCheckRequestSchema>;

// ── 견주기 ─────────────────────────────────────────────────

/**
 * 견주는 항목 셋과, 견줄 규격이 든 상품 칸.
 * - format: file_format(확장자 목록) 안에 파일의 형식이 있는가
 * - resolution: resolution_px 와 가로·세로가 꼭 같은가(돌려 놓은 것은 안 맞음이고, 고칠 점에 그렇게 적는다)
 * - duration: spot_seconds 와 영상 길이가 같은가(durationToleranceSeconds 까지 봐준다). 영상에만 있는 항목이다. 그림이면 목록에 없다.
 */
export const CREATIVE_CHECKS = ['format', 'resolution', 'duration'] as const;
export type CreativeCheckKey = (typeof CREATIVE_CHECKS)[number];

export const CREATIVE_CHECK_LABELS: Record<CreativeCheckKey, string> = { format: '파일 형식', resolution: '해상도', duration: '길이' };

export const CREATIVE_SPEC_FIELDS = { format: 'file_format', resolution: 'resolution_px', duration: 'spot_seconds' } as const;

export const CREATIVE_RULES = {
  /** 영상 길이가 규격과 이만큼(초)까지 달라도 맞음으로 친다 */
  durationToleranceSeconds: 0.5,
} as const;

/** match: 맞음. mismatch: 안 맞음. no_spec: 견줄 규격 없음(상품에 그 칸이 비었다. 맞다고도 틀리다고도 하지 않는다). */
export const CREATIVE_OUTCOMES = ['match', 'mismatch', 'no_spec'] as const;
export type CreativeOutcome = (typeof CREATIVE_OUTCOMES)[number];

export const CREATIVE_OUTCOME_LABELS: Record<CreativeOutcome, string> = { match: '맞음', mismatch: '안 맞음', no_spec: '견줄 규격 없음' };

export const CreativeCheckItemSchema = z.object({
  key: z.enum(CREATIVE_CHECKS),
  outcome: z.enum(CREATIVE_OUTCOMES),
  /** 규격을 사람이 읽는 글로("1920x1080", "jpg, mp4", "15초"). 규격이 없으면 null. */
  expected: z.string().nullable(),
  /** 파일에서 읽은 값을 같은 꼴로. 읽지 못했으면 null. */
  actual: z.string().nullable(),
  /** 안 맞을 때만. 무엇을 얼마로 고칠지 한 줄("가로 1920px, 세로 1080px 로 다시 내보내 주세요"). */
  fix: z.string().nullable(),
});
export type CreativeCheckItem = z.infer<typeof CreativeCheckItemSchema>;

/** pass: 안 맞는 항목이 없고 맞는 항목이 하나는 있다. fail: 안 맞는 항목이 있다. no_spec: 견줄 규격이 하나도 없다. */
export const CREATIVE_VERDICTS = ['pass', 'fail', 'no_spec'] as const;
export type CreativeVerdict = (typeof CREATIVE_VERDICTS)[number];

/** POST /api/creative-checks 의 응답(200). 오류: 상품 없음 404 · 형식 415 · 크기 413 · 머리를 못 읽음 422. */
export const CreativeCheckResponseSchema = z.object({
  product: z.object({ id: z.number().int().positive(), name: z.string(), type: z.enum(PRODUCT_TYPES), subtype: z.string() }),
  file: CreativeFactsSchema.extend({ name: z.string().nullable() }),
  /** 누가 파일을 읽었나. client 면 서버는 파일을 보지 못했고 화면이 보낸 값을 그대로 견줬다. */
  readBy: z.enum(['server', 'client']),
  items: z.array(CreativeCheckItemSchema),
  verdict: z.enum(CREATIVE_VERDICTS),
  /** 늘 거짓이다. 파일도 결과도 저장하지 않는다는 것을 응답에 적어 둔다. */
  stored: z.literal(false),
});
export type CreativeCheckResponse = z.infer<typeof CreativeCheckResponseSchema>;

// ── src/tools/creative 가 내보낼 순수 함수의 꼴 ─────────────

export type CreativeReadResult =
  | { ok: true; facts: CreativeFacts }
  /** unsupported: 받는 형식이 아니다(415). unreadable: 형식은 알지만 가로·세로를 읽지 못했다(422). */
  | { ok: false; problem: 'empty' | 'unsupported' | 'unreadable' };

export interface CreativeApi {
  /** 파일 바이트에서 사실을 읽는다. 브라우저에서도 돈다(Node 전용 기능을 쓰지 않는다). */
  readCreative(bytes: Uint8Array): CreativeReadResult;
  /** 사실과 상품의 규격 칸(spec)을 견준다. 그림이면 duration 항목은 내지 않는다. */
  checkCreative(facts: CreativeFacts, spec: Record<string, unknown>): { items: CreativeCheckItem[]; verdict: CreativeVerdict };
}
