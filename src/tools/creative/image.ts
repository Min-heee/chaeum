// 그림 파일(PNG·JPG·WEBP)의 머리에서 가로·세로를 읽는다. 그림을 풀지 않는다.
// 읽지 못하면 null 이다. 그릇에 적힌 길이보다 파일이 짧으면(잘린 파일) 머리가 멀쩡해도 null 을 준다.
// 저장된 픽셀 수를 그대로 낸다. JPG 부가 정보의 방향 표식(휴대전화 사진을 돌려 보여 주라는 표시)은 읽지 않는다(알고 둔 한계).
import { tag, u16be, u16le, u24le, u32be, u32le, u8 } from './bytes';

export interface PixelSize {
  width: number;
  height: number;
}

const sized = (width: number | null, height: number | null): PixelSize | null =>
  width !== null && height !== null && width > 0 && height > 0 ? { width, height } : null;

/**
 * PNG: 서명 8바이트 뒤 첫 조각이 IHDR(길이 13)이고 그 안에 가로 4바이트·세로 4바이트가 있다.
 * 조각을 끝 표식(IEND)까지 따라가 본다. 조각이 파일 끝을 넘거나 IEND 가 없으면 잘린 파일이다.
 */
export function readPng(bytes: Uint8Array): PixelSize | null {
  if (u32be(bytes, 8) !== 13 || tag(bytes, 12) !== 'IHDR') return null;
  const size = sized(u32be(bytes, 16), u32be(bytes, 20));
  if (!size) return null;
  let at = 8;
  for (;;) {
    const length = u32be(bytes, at);
    const type = tag(bytes, at + 4);
    if (length === null || type === null) return null;
    // 조각 하나 = 길이 4 + 이름 4 + 내용 + 검사값 4
    const next = at + 12 + length;
    if (next > bytes.length) return null;
    if (type === 'IEND') return size;
    at = next;
  }
}

/** 가로·세로가 든 표식(SOF)인가. C0~CF 가운데 C4(허프만 표)·C8(예약)·CC(산술 부호 조건)는 아니다. */
const isSizeMarker = (marker: number): boolean => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/** 길이가 따라붙지 않는 표식: 시작(D8), 다시 맞춤(D0~D7), 임시(01). */
const isBareMarker = (marker: number): boolean => marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);

/** from 뒤에 끝 표식(FF D9)이 있는가. 뒤에서부터 찾는다(온전한 파일은 맨 끝에 있다). */
function hasEndMarker(bytes: Uint8Array, from: number): boolean {
  for (let at = bytes.length - 2; at >= from; at -= 1) {
    if (bytes[at] === 0xff && bytes[at + 1] === 0xd9) return true;
  }
  return false;
}

/**
 * JPG: 표식(FF xx)과 길이를 따라가다 SOF 를 만나면 세로 2바이트·가로 2바이트를 읽는다.
 * 미리보기 그림이 든 부가 정보(APP1)는 길이만큼 건너뛰므로 그 안의 크기를 잘못 집지 않는다.
 * 그림 자료가 시작된 뒤(SOS)에 끝 표식이 없으면 잘린 파일이다.
 */
export function readJpeg(bytes: Uint8Array): PixelSize | null {
  let at = 2;
  let size: PixelSize | null = null;
  while (at < bytes.length) {
    if (u8(bytes, at) !== 0xff) return null;
    let marker = u8(bytes, at + 1);
    // 표식 앞의 채움 바이트(FF 가 이어진다)를 건너뛴다.
    while (marker === 0xff) {
      at += 1;
      marker = u8(bytes, at + 1);
    }
    if (marker === null) return null;
    if (isBareMarker(marker)) {
      at += 2;
      continue;
    }
    // 그림 자료 없이 끝났다.
    if (marker === 0xd9) return null;
    const length = u16be(bytes, at + 2);
    if (length === null || length < 2) return null;
    if (isSizeMarker(marker) && !size) {
      // 길이 2 + 정밀도 1 + 세로 2 + 가로 2
      size = sized(u16be(bytes, at + 7), u16be(bytes, at + 5));
      if (!size) return null;
    }
    if (marker === 0xda) return size && hasEndMarker(bytes, at + 2 + length) ? size : null;
    at += 2 + length;
  }
  return null;
}

/**
 * WEBP: RIFF 그릇 안 첫 조각의 이름으로 갈린다.
 * - "VP8 "(손실): 시작 표식 9D 01 2A 뒤에 가로·세로가 14비트씩.
 * - "VP8L"(무손실): 표식 2F 뒤 4바이트에 (가로−1) 14비트, (세로−1) 14비트.
 * - "VP8X"(확장. 투명·움직임·색 정보가 붙은 것): 캔버스 (가로−1) 3바이트, (세로−1) 3바이트.
 * RIFF 에 적힌 길이보다 파일이 짧으면 잘린 파일이다.
 */
export function readWebp(bytes: Uint8Array): PixelSize | null {
  const riffLength = u32le(bytes, 4);
  if (riffLength === null || riffLength + 8 > bytes.length) return null;
  const kind = tag(bytes, 12);
  if (kind === 'VP8 ') {
    if (u8(bytes, 23) !== 0x9d || u8(bytes, 24) !== 0x01 || u8(bytes, 25) !== 0x2a) return null;
    const width = u16le(bytes, 26);
    const height = u16le(bytes, 28);
    return width === null || height === null ? null : sized(width & 0x3fff, height & 0x3fff);
  }
  if (kind === 'VP8L') {
    const bits = u32le(bytes, 21);
    if (u8(bytes, 20) !== 0x2f || bits === null) return null;
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (kind === 'VP8X') {
    const width = u24le(bytes, 24);
    const height = u24le(bytes, 27);
    return width === null || height === null ? null : sized(width + 1, height + 1);
  }
  return null;
}
