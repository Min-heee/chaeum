// 시안 파일에서 형식·가로·세로·길이·용량을 읽는다. 바이트만 받는 순수 함수라 서버에서도 브라우저에서도 같은 코드가 돈다.
// 파일 이름과 브라우저가 붙인 형식 이름은 보지 않는다. 형식은 머리 바이트로만 정한다(확장자와 내용이 다르면 내용이 이긴다).
// 읽지 못한 값은 짐작하지 않는다. 형식을 모르면 unsupported, 형식은 알지만 가로·세로를 못 읽으면 unreadable 이다.
import { sniffMediaType } from '@/contract/pipeline-api';
import { CREATIVE_FORMATS, CREATIVE_MEDIA_TYPES, type CreativeFacts, type CreativeFormat, type CreativeReadResult } from '@/contract/tools/creative';
import { readJpeg, readPng, readWebp, type PixelSize } from './image';
import { boxAt, looksLikeMp4, readMp4, type Rotation } from './mp4';

/**
 * 읽은 결과. 약속의 CreativeReadResult 에 회전 표식 하나를 더 싣는다(화면이 알림을 적는 데 쓴다).
 * rotation: 영상의 회전 표식(도). 90·270 이면 facts 의 가로·세로는 이미 바꿔 놓은 값이다. 그림이거나 표식이 없으면 0.
 * wholeSeconds: 파일 전체의 길이. 영상 트랙보다 길 때만 있다(소리가 영상보다 긴 파일). facts 의 길이는 영상 트랙의 길이다.
 */
export type CreativeRead =
  | (Extract<CreativeReadResult, { ok: true }> & { rotation: Rotation; wholeSeconds?: number })
  | Extract<CreativeReadResult, { ok: false }>;

/**
 * 머리 바이트로 형식을 정한다. 받는 형식(jpg·png·webp·mp4)이 아니면 null.
 * 그림 셋은 본체의 올리기와 같은 함수(sniffMediaType)로 본다. 같은 판단을 두 군데 두지 않는다.
 */
export function sniffCreativeFormat(bytes: Uint8Array): CreativeFormat | null {
  const mediaType = sniffMediaType(bytes);
  const image = CREATIVE_FORMATS.find((format) => CREATIVE_MEDIA_TYPES[format] === mediaType);
  if (image) return image;
  return looksLikeMp4(bytes) ? 'mp4' : null;
}

const IMAGE_READERS: Record<Exclude<CreativeFormat, 'mp4'>, (bytes: Uint8Array) => PixelSize | null> = {
  jpg: readJpeg,
  png: readPng,
  webp: readWebp,
};

/**
 * 파일 바이트에서 사실을 읽는다.
 * sizeBytes 는 파일 전체의 크기다. bytes 가 파일 전체면 비워 둔다. 영상에서 머리 상자만 골라 넘길 때(readMp4ByRange)만 따로 준다.
 */
export function readCreative(bytes: Uint8Array, sizeBytes: number = bytes.length): CreativeRead {
  if (bytes.length === 0 || sizeBytes <= 0) return { ok: false, problem: 'empty' };
  const format = sniffCreativeFormat(bytes);
  if (!format) return { ok: false, problem: 'unsupported' };
  if (format === 'mp4') {
    const movie = readMp4(bytes);
    if (!movie) return { ok: false, problem: 'unreadable' };
    const facts: CreativeFacts = { format, width: movie.width, height: movie.height, sizeBytes, durationSeconds: movie.durationSeconds };
    return { ok: true, facts, rotation: movie.rotation, ...(movie.wholeSeconds === undefined ? {} : { wholeSeconds: movie.wholeSeconds }) };
  }
  const size = IMAGE_READERS[format](bytes);
  if (!size) return { ok: false, problem: 'unreadable' };
  return { ok: true, facts: { format, width: size.width, height: size.height, sizeBytes, durationSeconds: null }, rotation: 0 };
}

/** 파일의 offset 자리부터 length 바이트를 읽어 주는 함수. 브라우저에서는 File.slice 로 만든다. */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

export const RANGE_READ_LIMITS = {
  /** 맨 위 상자를 이만큼까지만 따라간다. 조각으로 나뉜 MP4 는 상자가 아주 많다. */
  maxTopBoxes: 2000,
  /** ftyp·moov 하나의 크기 상한(바이트). 머리 상자가 이보다 크면 읽지 않는다. */
  headBoxMaxBytes: 32 * 1024 * 1024,
  /** 그림을 통째로 메모리에 올려 읽는 상한(바이트). 넘으면 읽지 않고 그렇게 알린다. */
  wholeFileMaxBytes: 64 * 1024 * 1024,
} as const;

/**
 * MP4 를 통째로 메모리에 올리지 않고 읽는다. 맨 위 상자의 머리(16바이트)만 차례로 읽어 ftyp 과 moov 를 찾고,
 * 그 둘만 이어 붙여 readCreative 에 넘긴다. 영상 자료(mdat)는 읽지 않는다.
 * 파일을 읽는 일은 부르는 쪽이 준 함수가 한다. 이 함수는 파일도 네트워크도 모른다.
 * MP4 가 아니면 unsupported 다. 같은 파일이면 통째로 읽은 readCreative 와 같은 답을 낸다(시험이 본다).
 */
export async function readMp4ByRange(read: ReadRange, fileSize: number): Promise<CreativeRead> {
  if (!Number.isInteger(fileSize) || fileSize <= 0) return { ok: false, problem: 'empty' };
  const headOf = (offset: number) => read(offset, Math.min(16, fileSize - offset));
  if (!looksLikeMp4(await headOf(0))) return { ok: false, problem: 'unsupported' };

  const parts: Uint8Array[] = [];
  let hasMovie = false;
  let offset = 0;
  // moov 를 찾은 뒤에도 끝까지 따라가 본다(뒤쪽 상자가 파일 끝을 넘으면 잘린 파일이다). 상자가 너무 많으면 거기서 멈춘다.
  for (let seen = 0; offset + 8 <= fileSize && seen < RANGE_READ_LIMITS.maxTopBoxes; seen += 1) {
    const box = boxAt(await headOf(offset), 0, fileSize - offset);
    if (!box) return { ok: false, problem: 'unreadable' };
    // box.end 는 이 상자의 크기다(머리를 0 자리에서 읽었다).
    if (box.type === 'ftyp' || box.type === 'moov') {
      if (box.end > RANGE_READ_LIMITS.headBoxMaxBytes) return { ok: false, problem: 'unreadable' };
      parts.push(await read(offset, box.end));
      hasMovie ||= box.type === 'moov';
    }
    offset += box.end;
  }
  if (!hasMovie) return { ok: false, problem: 'unreadable' };
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return readCreative(joined, fileSize);
}

/** too_big: 그림이 통째로 읽는 상한을 넘어 읽지 않았다(MP4 는 머리 상자만 읽으므로 이 상한이 없다). */
export type CreativeFileRead = CreativeRead | { ok: false; problem: 'too_big' };

/**
 * 화면이 브라우저에서 파일 하나를 읽는 길. 파일을 서버로 보내지 않는다.
 * 앞머리 16바이트로 MP4 인지 보고, MP4 면 머리 상자만 읽는다(몇백 MB 영상도 메모리에 올리지 않는다).
 * 그 밖에는 통째로 읽어 readCreative 에 넘긴다. 그림은 끝 표식까지 따라가야 잘린 파일을 가려낼 수 있어서다.
 */
export async function readCreativeFile(read: ReadRange, fileSize: number): Promise<CreativeFileRead> {
  if (!Number.isInteger(fileSize) || fileSize <= 0) return { ok: false, problem: 'empty' };
  if (looksLikeMp4(await read(0, Math.min(16, fileSize)))) return readMp4ByRange(read, fileSize);
  if (fileSize > RANGE_READ_LIMITS.wholeFileMaxBytes) return { ok: false, problem: 'too_big' };
  return readCreative(await read(0, fileSize));
}
