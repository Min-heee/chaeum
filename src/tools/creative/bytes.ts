// 바이트에서 수와 이름표를 읽는 작은 함수들. 자리가 파일 밖이면 null 을 준다(던지지 않고, 값을 지어내지 않는다).

const within = (bytes: Uint8Array, at: number, length: number): boolean => Number.isInteger(at) && at >= 0 && at + length <= bytes.length;

export function u8(bytes: Uint8Array, at: number): number | null {
  return within(bytes, at, 1) ? (bytes[at] as number) : null;
}

/** 큰 자리부터 적힌 2바이트 수(JPG, MP4). */
export function u16be(bytes: Uint8Array, at: number): number | null {
  if (!within(bytes, at, 2)) return null;
  return (bytes[at] as number) * 0x100 + (bytes[at + 1] as number);
}

/** 큰 자리부터 적힌 4바이트 수(PNG, MP4). */
export function u32be(bytes: Uint8Array, at: number): number | null {
  if (!within(bytes, at, 4)) return null;
  return (bytes[at] as number) * 0x1000000 + (bytes[at + 1] as number) * 0x10000 + (bytes[at + 2] as number) * 0x100 + (bytes[at + 3] as number);
}

/** 큰 자리부터 적힌 8바이트 수(MP4 의 긴 길이). 2^53 을 넘으면 정확하지 않으므로 null. */
export function u64be(bytes: Uint8Array, at: number): number | null {
  const high = u32be(bytes, at);
  const low = u32be(bytes, at + 4);
  if (high === null || low === null || high >= 0x200000) return null;
  return high * 0x100000000 + low;
}

/** 작은 자리부터 적힌 수(WEBP). */
export function u16le(bytes: Uint8Array, at: number): number | null {
  if (!within(bytes, at, 2)) return null;
  return (bytes[at] as number) + (bytes[at + 1] as number) * 0x100;
}

export function u24le(bytes: Uint8Array, at: number): number | null {
  if (!within(bytes, at, 3)) return null;
  return (bytes[at] as number) + (bytes[at + 1] as number) * 0x100 + (bytes[at + 2] as number) * 0x10000;
}

export function u32le(bytes: Uint8Array, at: number): number | null {
  if (!within(bytes, at, 4)) return null;
  return (bytes[at] as number) + (bytes[at + 1] as number) * 0x100 + (bytes[at + 2] as number) * 0x10000 + (bytes[at + 3] as number) * 0x1000000;
}

/** 네 글자 이름표("IHDR", "moov", "VP8 "). */
export function tag(bytes: Uint8Array, at: number): string | null {
  if (!within(bytes, at, 4)) return null;
  return String.fromCharCode(bytes[at] as number, bytes[at + 1] as number, bytes[at + 2] as number, bytes[at + 3] as number);
}
