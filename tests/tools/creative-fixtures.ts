// 시안 검사 시험이 함께 쓰는 것: 시험 재료 읽기, 지면 규격 셋, 손으로 짠 최소 파일.
// 재료는 tests/tools/fixtures/creative/ 에 있다(만드는 법은 그 폴더의 make.sh). 지면과 규격은 전부 지어낸 것이다.
import { readFileSync } from 'node:fs';

/** 시험 재료 하나를 바이트로 읽는다. */
export function fixture(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(new URL(`./fixtures/creative/${name}`, import.meta.url)));
}

// ── 지면 규격(상품의 spec 에서 시안 검사가 읽는 칸만) ───────────

/** 가로 전광판: 1920x1080, jpg·mp4, 한 번 15초 */
export const BOARD = { resolution_px: { width: 1920, height: 1080 }, file_format: ['jpg', 'mp4'], spot_seconds: 15 };
/** 세로 조명 광고: 1080x1920, jpg·png. 멈춘 그림만 받아 한 번 길이가 없다 */
export const PILLAR = { resolution_px: { width: 1080, height: 1920 }, file_format: ['jpg', 'png'] };
/** 쉘터 화면: 1280x720, mp4·png·webp, 한 번 10초 */
export const SHELTER = { resolution_px: { width: 1280, height: 720 }, file_format: ['mp4', 'png', 'webp'], spot_seconds: 10 };
/** 세로 전광판: 1080x1920, mp4, 한 번 15초 */
export const TALL_BOARD = { resolution_px: { width: 1080, height: 1920 }, file_format: ['mp4'], spot_seconds: 15 };

// ── 손으로 짠 최소 파일 ─────────────────────────────────────
// 도구로는 만들기 어려운 꼴(64비트 길이, 미리보기 그림이 든 부가 정보 등)을 바이트로 직접 짠다. 그림·영상 자료는 들어 있지 않다.

export const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));
export const be16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
export const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
export const be64 = (n: number): number[] => [...be32(Math.floor(n / 0x100000000)), ...be32(n % 0x100000000)];
export const le24 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
export const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const zeros = (n: number): number[] => new Array<number>(n).fill(0);

export const bytesOf = (...parts: number[][]): Uint8Array<ArrayBuffer> => new Uint8Array(parts.flat());

/** MP4 상자 하나: 크기 4 + 이름 4 + 내용. */
export const box = (type: string, ...parts: number[][]): number[] => {
  const body = parts.flat();
  return [...be32(8 + body.length), ...ascii(type), ...body];
};

/** 16.16 고정 소수 */
const fixed = (n: number): number[] => be32(Math.round(n * 0x10000) >>> 0);

export type Turn = 0 | 90 | 180 | 270;
/** tkhd 의 행렬 [a b u / c d v / x y w]. 돌림만 넣는다. */
const MATRIX: Record<Turn, [number, number, number, number]> = { 0: [1, 0, 0, 1], 90: [0, 1, -1, 0], 180: [-1, 0, 0, -1], 270: [0, -1, 1, 0] };
const matrix = (turn: Turn): number[] => {
  const [a, b, c, d] = MATRIX[turn];
  return [...fixed(a), ...fixed(b), ...zeros(4), ...fixed(c), ...fixed(d), ...zeros(4), ...zeros(8), ...be32(0x40000000)];
};

export interface TinyMovie {
  /** stsd 에 적는 저장된 크기. null 이면 stsd 를 넣지 않는다(tkhd 의 크기로 읽히는지 볼 때). */
  stored?: { width: number; height: number } | null;
  /** tkhd 에 적는 보이는 크기. 비우면 stored 와 같다. */
  shown?: { width: number; height: number };
  timescale?: number;
  /** mvhd 에 적는 파일 전체의 길이 */
  duration?: number;
  /** tkhd 에 적는 영상 트랙의 길이. 비우면 duration 과 같다. */
  trackDuration?: number;
  /** 머리 상자(mvhd·tkhd)의 판. 1 이면 시각·길이가 8바이트다. */
  version?: 0 | 1;
  turn?: Turn;
  /** 트랙의 갈래. 'soun' 이면 영상 트랙이 없는 파일이 된다. */
  handler?: 'vide' | 'soun';
  brand?: string;
  /** moov 앞에 두는 영상 자료 상자의 내용 크기(바이트, 0 으로 채운다) */
  mdatBytes?: number;
  /** 영상 자료 상자의 크기를 64비트로 적는다(크기 칸이 1) */
  wideMdat?: boolean;
  /** 맨 끝에 크기 칸이 0 인 상자(파일 끝까지라는 뜻)를 붙인다 */
  openEnded?: boolean;
}

/** 머리 상자만 갖춘 MP4. 영상 자료는 0 으로 채운 자리뿐이라 재생되지는 않는다. */
export function tinyMp4(options: TinyMovie = {}): Uint8Array<ArrayBuffer> {
  const { timescale = 1000, duration = 15000, version = 0, turn = 0, handler = 'vide', brand = 'isom', mdatBytes = 0, wideMdat = false, openEnded = false } = options;
  const stored = options.stored === undefined ? { width: 1920, height: 1080 } : options.stored;
  const shown = options.shown ?? stored ?? { width: 1920, height: 1080 };
  const times = (value: number) => (version === 1 ? [...zeros(16), ...be32(timescale), ...be64(value)] : [...zeros(8), ...be32(timescale), ...be32(value)]);
  const mvhd = box('mvhd', [version, 0, 0, 0], times(duration), zeros(80));
  const trackDuration = options.trackDuration ?? duration;
  const trackTimes = version === 1 ? [...zeros(16), ...be32(1), ...zeros(4), ...be64(trackDuration)] : [...zeros(8), ...be32(1), ...zeros(4), ...be32(trackDuration)];
  const tkhd = box('tkhd', [version, 0, 0, 3], trackTimes, zeros(8), zeros(8), matrix(turn), fixed(shown.width), fixed(shown.height));
  const hdlr = box('hdlr', zeros(8), ascii(handler), zeros(12), [0]);
  const entry = stored ? box('avc1', zeros(6), be16(1), zeros(16), be16(stored.width), be16(stored.height), zeros(50)) : [];
  const stbl = stored ? box('stbl', box('stsd', zeros(4), be32(1), entry)) : box('stbl');
  const trak = box('trak', tkhd, box('mdia', hdlr, box('minf', stbl)));
  const ftyp = box('ftyp', ascii(brand), be32(0), ascii('isom'));
  const mdat = wideMdat ? [...be32(1), ...ascii('mdat'), ...be64(16 + mdatBytes), ...zeros(mdatBytes)] : mdatBytes > 0 ? box('mdat', zeros(mdatBytes)) : [];
  const tail = openEnded ? [...be32(0), ...ascii('free'), ...zeros(12)] : [];
  return bytesOf(ftyp, mdat, box('moov', mvhd, trak), tail);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** PNG 조각 하나: 길이 4 + 이름 4 + 내용 + 검사값 4(읽는 쪽이 보지 않아 0 으로 둔다). */
const chunk = (type: string, body: number[]): number[] => [...be32(body.length), ...ascii(type), ...body, ...zeros(4)];

/** 머리(IHDR)와 끝 표식만 있는 PNG. data 를 켜면 그 사이에 그림 자료 조각(IDAT, 내용은 0)을 하나 둔다. */
export function tinyPng(width: number, height: number, options: { end?: boolean; data?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const { end = true, data = false } = options;
  const head = chunk('IHDR', [...be32(width), ...be32(height), 8, 2, 0, 0, 0]);
  return bytesOf(PNG_SIGNATURE, head, data ? chunk('IDAT', zeros(16)) : [], end ? chunk('IEND', []) : []);
}

/** JPG 조각 하나: FF + 표식 + 길이 2(자기 자신 포함) + 내용. */
export const segment = (marker: number, body: number[]): number[] => [0xff, marker, ...be16(body.length + 2), ...body];
/** 크기 표식의 내용: 정밀도 1 + 세로 2 + 가로 2 + 성분 수 1 */
export const sofBody = (width: number, height: number): number[] => [8, ...be16(height), ...be16(width), 1, 1, 0x11, 0];

/** 표식만 갖춘 JPG. before 는 크기 표식 앞에 끼워 넣는 바이트다. */
export function tinyJpeg(width: number, height: number, options: { before?: number[]; sof?: number; end?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const { before = [], sof = 0xc0, end = true } = options;
  return bytesOf([0xff, 0xd8], before, segment(sof, sofBody(width, height)), segment(0xda, [1, 1, 0, 0, 63, 0]), [0x12, 0x34], end ? [0xff, 0xd9] : []);
}

/** WEBP 그릇: "RIFF" + 길이 + "WEBP" + 첫 조각. */
export function tinyWebp(kind: string, body: number[]): Uint8Array<ArrayBuffer> {
  const first = [...ascii(kind), ...le32(body.length), ...body];
  return bytesOf(ascii('RIFF'), le32(4 + first.length), ascii('WEBP'), first);
}
