// MP4 의 머리 상자에서 가로·세로·길이를 읽는다. 영상을 풀지 않고, 영상 자료(mdat)는 건너뛴다.
//
//   파일 = 상자가 이어진 것. 상자 = 크기 4바이트 + 이름 4글자 + 내용(크기가 1 이면 이름 뒤 8바이트가 진짜 크기, 0 이면 그릇의 끝까지).
//   ftyp                      어떤 갈래의 파일인가
//   moov
//     mvhd                    파일 전체의 길이 = duration ÷ timescale (가장 긴 트랙의 길이다. 소리가 더 길면 소리의 길이)
//     trak (영상 트랙 하나)
//       tkhd                  이 트랙의 길이(mvhd 의 timescale 로 적혀 있다), 회전 표식(행렬), 화면에 보이는 가로·세로
//       mdia
//         hdlr                이 트랙이 영상('vide')인가
//         minf > stbl > stsd  저장된 가로·세로(픽셀 수)
//
// 길이는 영상 트랙의 길이를 쓴다(트랙 머리에 없으면 파일 전체의 길이). 소리가 영상보다 긴 파일을 "영상이 길다"고 하지 않으려는 것이다.
// 가로·세로는 stsd 의 픽셀 수를 쓴다(없으면 tkhd). 회전 표식이 90도·270도면 가로·세로를 바꿔 낸다(재생기가 돌려서 보여 주는 크기).
// 읽지 못하면 null 이다. 상자가 그릇의 끝을 넘으면 잘린 파일로 보고 null 을 준다.
import { tag, u16be, u32be, u64be, u8 } from './bytes';
import type { PixelSize } from './image';

/** 영상의 회전 표식(도). 표식이 없거나 돌림이 아닌 행렬이면 0. */
export type Rotation = 0 | 90 | 180 | 270;

export interface Box {
  type: string;
  /** 내용이 시작하는 자리 */
  body: number;
  /** 상자가 끝나는 자리(다음 상자의 시작) */
  end: number;
}

/**
 * at 자리의 상자 머리를 읽는다. limit 는 이 상자가 든 그릇의 끝이다.
 * bytes 가 그릇의 앞부분뿐이어도 된다(머리 16바이트만 있으면 읽는다). 그래서 큰 파일을 조각으로 읽는 쪽도 같이 쓴다.
 * 머리가 모자라거나, 크기가 머리보다 작거나, 상자가 그릇의 끝을 넘으면 null.
 */
export function boxAt(bytes: Uint8Array, at: number, limit: number): Box | null {
  const size32 = u32be(bytes, at);
  const type = tag(bytes, at + 4);
  if (size32 === null || type === null) return null;
  let header = 8;
  let size: number | null = size32;
  if (size32 === 1) {
    header = 16;
    size = u64be(bytes, at + 8);
  } else if (size32 === 0) {
    size = limit - at;
  }
  if (size === null || size < header || at + size > limit) return null;
  return { type, body: at + header, end: at + size };
}

/** from 부터 to 까지 이어진 상자들. 하나라도 그릇의 끝을 넘으면 null. 8바이트가 안 되는 꼬리는 버린다. */
function boxesIn(bytes: Uint8Array, from: number, to: number): Box[] | null {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    const box = boxAt(bytes, at, to);
    if (!box) return null;
    out.push(box);
    at = box.end;
  }
  return out;
}

/** 그릇 안에서 이름이 같은 첫 상자. */
function child(bytes: Uint8Array, parent: Box, type: string): Box | null {
  return boxesIn(bytes, parent.body, parent.end)?.find((b) => b.type === type) ?? null;
}

const toSeconds = (duration: number | null, timescale: number | null): number | null => {
  if (!timescale || !duration) return null;
  const seconds = Math.round((duration / timescale) * 100) / 100;
  return seconds > 0 ? seconds : null;
};

/** mvhd 의 시간 단위(1초를 몇으로 나눴나). 판(version) 0 이면 시각·길이가 4바이트, 1 이면 8바이트다. */
function movieTimescale(bytes: Uint8Array, mvhd: Box): number | null {
  const version = u8(bytes, mvhd.body);
  if (version !== 0 && version !== 1) return null;
  return u32be(bytes, mvhd.body + (version === 1 ? 20 : 12));
}

/** mvhd 의 길이(파일 전체). 길이를 모르는 파일(0 또는 모든 비트 1)은 null. */
function movieSeconds(bytes: Uint8Array, mvhd: Box): number | null {
  const version = u8(bytes, mvhd.body);
  const wide = version === 1;
  if (version !== 0 && !wide) return null;
  const duration = wide ? u64be(bytes, mvhd.body + 24) : u32be(bytes, mvhd.body + 16);
  if (!wide && duration === 0xffffffff) return null;
  return toSeconds(duration, movieTimescale(bytes, mvhd));
}

/**
 * tkhd 의 길이(이 트랙 하나). 단위는 mvhd 의 시간 단위다.
 * 판·표시 4 + 만든 시각 + 고친 시각 + 트랙 번호 4 + 예약 4 뒤에 있다(시각은 판 0 이면 4바이트씩, 판 1 이면 8바이트씩).
 */
function trackSeconds(bytes: Uint8Array, tkhd: Box, timescale: number | null): number | null {
  const version = u8(bytes, tkhd.body);
  const wide = version === 1;
  if (version !== 0 && !wide) return null;
  const duration = wide ? u64be(bytes, tkhd.body + 28) : u32be(bytes, tkhd.body + 20);
  if (!wide && duration === 0xffffffff) return null;
  return toSeconds(duration, timescale);
}

/** tkhd 의 행렬과 가로·세로가 시작하는 자리. 판 1 은 시각·길이가 8바이트라 12바이트 뒤다. */
function trackHeaderOffsets(bytes: Uint8Array, tkhd: Box): { matrix: number; size: number } | null {
  const version = u8(bytes, tkhd.body);
  if (version !== 0 && version !== 1) return null;
  const matrix = tkhd.body + (version === 1 ? 52 : 40);
  return { matrix, size: matrix + 36 };
}

/** 부호 있는 4바이트 수로 읽는다(행렬의 −1 은 FFFF0000). */
const signed = (value: number | null): number | null => (value === null ? null : value | 0);

/** tkhd 의 행렬 [a b u / c d v / x y w] 에서 돌림을 읽는다. 값은 16.16 고정 소수(1 = 0x10000). */
function trackRotation(bytes: Uint8Array, tkhd: Box): Rotation {
  const at = trackHeaderOffsets(bytes, tkhd);
  if (!at) return 0;
  const a = signed(u32be(bytes, at.matrix));
  const b = signed(u32be(bytes, at.matrix + 4));
  const c = signed(u32be(bytes, at.matrix + 12));
  const d = signed(u32be(bytes, at.matrix + 16));
  const ONE = 0x10000;
  if (a === 0 && d === 0 && b === ONE && c === -ONE) return 90;
  if (a === 0 && d === 0 && b === -ONE && c === ONE) return 270;
  if (a === -ONE && d === -ONE && b === 0 && c === 0) return 180;
  return 0;
}

/** tkhd 의 가로·세로(16.16 고정 소수). 화면에 보이는 크기다. */
function trackShownSize(bytes: Uint8Array, tkhd: Box): PixelSize | null {
  const at = trackHeaderOffsets(bytes, tkhd);
  if (!at) return null;
  const width = u32be(bytes, at.size);
  const height = u32be(bytes, at.size + 4);
  if (!width || !height) return null;
  const size = { width: Math.round(width / 0x10000), height: Math.round(height / 0x10000) };
  return size.width > 0 && size.height > 0 ? size : null;
}

/** stsd 첫 항목의 가로·세로(2바이트씩). 영상 항목은 코덱이 달라도 같은 자리에 있다. */
function trackStoredSize(bytes: Uint8Array, stsd: Box): PixelSize | null {
  // 판·표시 4 + 항목 수 4 뒤에 첫 항목. 항목 = 크기 4 + 이름 4 + 예약 6 + 자료 번호 2 + 예약 16 + 가로 2 + 세로 2 …
  const entry = stsd.body + 8;
  const width = u16be(bytes, entry + 32);
  const height = u16be(bytes, entry + 34);
  if (entry + 36 > stsd.end || !width || !height) return null;
  return { width, height };
}

export interface MovieFacts extends PixelSize {
  /** 영상 트랙의 길이(초). 트랙 머리에 없으면 파일 전체의 길이. 길이를 모르는 파일(조각으로 나뉜 MP4 등)은 null. */
  durationSeconds: number | null;
  /** 파일 전체의 길이(초). 영상 트랙보다 길 때만 있다(소리 같은 다른 트랙이 더 긴 파일). */
  wholeSeconds?: number;
  rotation: Rotation;
}

/** moov 상자에서 첫 영상 트랙의 가로·세로와 길이를 읽는다. 영상 트랙이 없으면 null. */
function readMovie(bytes: Uint8Array, moov: Box): MovieFacts | null {
  const inside = boxesIn(bytes, moov.body, moov.end);
  if (!inside) return null;
  const mvhd = inside.find((b) => b.type === 'mvhd');
  for (const trak of inside.filter((b) => b.type === 'trak')) {
    const mdia = child(bytes, trak, 'mdia');
    const hdlr = mdia && child(bytes, mdia, 'hdlr');
    // hdlr: 판·표시 4 + 예약 4 뒤에 트랙의 갈래 네 글자
    if (!mdia || !hdlr || tag(bytes, hdlr.body + 8) !== 'vide') continue;
    const tkhd = child(bytes, trak, 'tkhd');
    const minf = child(bytes, mdia, 'minf');
    const stbl = minf && child(bytes, minf, 'stbl');
    const stsd = stbl && child(bytes, stbl, 'stsd');
    const stored = (stsd && trackStoredSize(bytes, stsd)) ?? (tkhd && trackShownSize(bytes, tkhd)) ?? null;
    if (!stored) continue;
    const rotation = tkhd ? trackRotation(bytes, tkhd) : 0;
    const turned = rotation === 90 || rotation === 270;
    const whole = mvhd ? movieSeconds(bytes, mvhd) : null;
    const track = mvhd && tkhd ? trackSeconds(bytes, tkhd, movieTimescale(bytes, mvhd)) : null;
    const durationSeconds = track ?? whole;
    return {
      width: turned ? stored.height : stored.width,
      height: turned ? stored.width : stored.height,
      durationSeconds,
      ...(whole !== null && durationSeconds !== null && whole > durationSeconds ? { wholeSeconds: whole } : {}),
      rotation,
    };
  }
  return null;
}

/** MP4 파일 전체(또는 ftyp 과 moov 만 이어 붙인 것)에서 읽는다. */
export function readMp4(bytes: Uint8Array): MovieFacts | null {
  const top = boxesIn(bytes, 0, bytes.length);
  const moov = top?.find((b) => b.type === 'moov');
  return moov ? readMovie(bytes, moov) : null;
}

/**
 * ftyp 의 큰 갈래 가운데 MP4 가 아닌 것. 같은 상자 구조를 쓰지만 다른 형식이다.
 * QuickTime(mov), HEIF·AVIF 그림. 3GP 는 갈래 이름이 "3g" 로 시작한다. 이런 파일은 받지 않는 형식으로 낸다.
 * 목록에 없는 갈래는 MP4 로 보고 읽어 본다(영상 트랙이 없으면 "읽지 못함"이 된다).
 */
const NOT_MP4_BRANDS = new Set(['qt  ', 'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis']);

/** 머리 바이트가 MP4 인가. 첫 상자가 ftyp 이고 큰 갈래가 위 목록에 없어야 한다. */
export function looksLikeMp4(bytes: Uint8Array): boolean {
  const brand = tag(bytes, 8);
  return tag(bytes, 4) === 'ftyp' && brand !== null && !NOT_MP4_BRANDS.has(brand) && !brand.startsWith('3g');
}
