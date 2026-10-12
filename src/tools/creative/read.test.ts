// 파일 머리 읽기. 도구로 만든 작은 파일(tests/tools/fixtures/creative)과 손으로 짠 최소 파일로 본다.
// 맞게 만든 파일은 값이 그대로 읽히고, 잘렸거나 다른 형식인 파일은 값을 지어내지 않는다.
import { describe, expect, it } from 'vitest';
import { CreativeFactsSchema } from '@/contract/tools/creative';
import { ascii, be16, be32, be64, bytesOf, fixture, le24, le32, segment, sofBody, tinyJpeg, tinyMp4, tinyPng, tinyWebp } from '../../../tests/tools/creative-fixtures';
import { readJpeg, readPng, readWebp } from './image';
import { boxAt } from './mp4';
import { readCreative, readCreativeFile, readMp4ByRange, RANGE_READ_LIMITS, sniffCreativeFormat, type ReadRange } from './read';

/** [파일, 형식, 가로, 세로, 길이(초)] */
type Row = [name: string, format: string, width: number, height: number, seconds: number | null];

function expectFacts([name, format, width, height, seconds]: Row) {
  const bytes = fixture(name);
  const got = readCreative(bytes);
  expect(got, name).toEqual({ ok: true, facts: { format, width, height, sizeBytes: bytes.length, durationSeconds: seconds }, rotation: 0 });
  if (got.ok) expect(CreativeFactsSchema.safeParse(got.facts).success, name).toBe(true);
}

describe('규격에 맞게 만든 파일을 읽는다', () => {
  const rows: Row[] = [
    ['board-1920x1080.jpg', 'jpg', 1920, 1080, null],
    ['pillar-1080x1920-progressive.jpg', 'jpg', 1080, 1920, null],
    ['pillar-1080x1920.png', 'png', 1080, 1920, null],
    ['shelter-1280x720.png', 'png', 1280, 720, null],
    ['shelter-1280x720-lossy.webp', 'webp', 1280, 720, null],
    ['shelter-1280x720-lossless.webp', 'webp', 1280, 720, null],
    ['shelter-1280x720-alpha.webp', 'webp', 1280, 720, null],
    ['board-1920x1080-15s.mp4', 'mp4', 1920, 1080, 15],
    ['board-1920x1080-15s-faststart.mp4', 'mp4', 1920, 1080, 15],
    ['shelter-1280x720-10s-hevc.mp4', 'mp4', 1280, 720, 10],
  ];
  it.each(rows)('%s → %s %i x %i', (...row) => expectFacts(row));

  it('용량은 파일 전체의 바이트 수다', () => {
    const bytes = fixture('board-1920x1080.jpg');
    const got = readCreative(bytes);
    expect(got.ok && got.facts.sizeBytes).toBe(12446);
  });
});

describe('규격과 다르게 만든 파일도 값은 있는 그대로 읽는다', () => {
  const rows: Row[] = [
    ['small-960x540.jpg', 'jpg', 960, 540, null],
    ['rounded-853x480.png', 'png', 853, 480, null],
    ['square-1080x1080.jpg', 'jpg', 1080, 1080, null],
    ['small-1280x720-15s.mp4', 'mp4', 1280, 720, 15],
    ['board-1920x1080-10s.mp4', 'mp4', 1920, 1080, 10],
    ['board-1920x1080-15.4s.mp4', 'mp4', 1920, 1080, 15.4],
    ['board-1920x1080-15.6s.mp4', 'mp4', 1920, 1080, 15.6],
    // 영상 항목의 이름(코덱)이 달라도 가로·세로는 같은 자리에 있다.
    ['oldcodec-320x180.mp4', 'mp4', 320, 180, 2],
    // 움직이는 WEBP 는 그림으로 읽는다. 길이는 읽지 않는다.
    ['moving-320x180.webp', 'webp', 320, 180, null],
  ];
  it.each(rows)('%s → %s %i x %i', (...row) => expectFacts(row));
});

describe('확장자와 내용이 다르면 내용이 기준이다', () => {
  it('이름은 jpg 인데 내용이 PNG 면 png 로 읽는다', () => {
    expect(readCreative(fixture('png-inside.jpg'))).toMatchObject({ ok: true, facts: { format: 'png', width: 1920, height: 1080 } });
  });

  it.each(['quicktime-inside.mp4', 'gif-inside.png', 'text-inside.png'])('%s 는 받는 형식이 아니다', (name) => {
    expect(readCreative(fixture(name))).toEqual({ ok: false, problem: 'unsupported' });
  });

  it('머리 바이트로 형식을 정한다. 모르는 머리면 null', () => {
    expect(sniffCreativeFormat(fixture('png-inside.jpg'))).toBe('png');
    expect(sniffCreativeFormat(fixture('board-1920x1080.jpg'))).toBe('jpg');
    expect(sniffCreativeFormat(fixture('shelter-1280x720-lossless.webp'))).toBe('webp');
    expect(sniffCreativeFormat(fixture('board-1920x1080-15s.mp4'))).toBe('mp4');
    expect(sniffCreativeFormat(fixture('quicktime-inside.mp4'))).toBeNull();
    expect(sniffCreativeFormat(bytesOf(ascii('%PDF-1.7\n')))).toBeNull();
    expect(sniffCreativeFormat(new Uint8Array())).toBeNull();
  });

  it('같은 상자 구조를 쓰는 다른 형식(HEIF 그림, 3GP)은 MP4 로 치지 않는다. 낯선 MP4 갈래는 읽어 본다', () => {
    expect(readCreative(tinyMp4({ brand: 'heic' }))).toEqual({ ok: false, problem: 'unsupported' });
    expect(readCreative(tinyMp4({ brand: '3gp5' }))).toEqual({ ok: false, problem: 'unsupported' });
    expect(readCreative(tinyMp4({ brand: 'M4V ' }))).toMatchObject({ ok: true, facts: { format: 'mp4', width: 1920, height: 1080 } });
  });
});

describe('잘렸거나 빈 파일은 값을 지어내지 않는다', () => {
  it.each([
    ['cut-head.png', '머리(IHDR)가 다 들어오기 전에 끊김'],
    ['cut-tail.png', '머리는 멀쩡하고 뒤가 없음'],
    ['cut-head.jpg', '크기 표식이 나오기 전에 끊김'],
    ['cut-tail.jpg', '크기는 읽히지만 끝 표식이 없음'],
    ['cut-tail.webp', '그릇에 적힌 길이보다 짧음'],
    ['cut-tail.mp4', '머리 상자(moov)가 통째로 사라짐'],
    ['cut-tail-faststart.mp4', '머리 상자는 멀쩡하고 영상 자료가 끊김'],
    ['sound-only.mp4', '영상 트랙이 없음'],
  ])('%s (%s) → 읽지 못함', (name) => {
    expect(readCreative(fixture(name))).toEqual({ ok: false, problem: 'unreadable' });
  });

  it('빈 파일은 빈 파일이라고 한다', () => {
    expect(readCreative(new Uint8Array())).toEqual({ ok: false, problem: 'empty' });
  });

  it('잘린 파일의 머리에 크기가 멀쩡히 적혀 있어도 내지 않는다', () => {
    // 같은 머리를 가진 온전한 파일은 읽힌다. 잘린 쪽만 못 읽는다.
    expect(readPng(tinyPng(1080, 1920))).toEqual({ width: 1080, height: 1920 });
    expect(readPng(tinyPng(1080, 1920, { data: true }))).toEqual({ width: 1080, height: 1920 });
    expect(readPng(tinyPng(1080, 1920, { end: false }))).toBeNull();
    // 그림 자료 조각까지는 온전해도 끝 표식이 없으면 잘린 파일이다.
    expect(readPng(tinyPng(1080, 1920, { data: true, end: false }))).toBeNull();
    expect(readJpeg(tinyJpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(readJpeg(tinyJpeg(1920, 1080, { end: false }))).toBeNull();
  });
});

describe('회전 표식이 붙은 영상', () => {
  it('90도: 저장된 크기는 1920x1080 이지만 돌려서 보이는 1080x1920 으로 낸다', () => {
    const got = readCreative(fixture('phone-1920x1080-turn90.mp4'));
    expect(got).toMatchObject({ ok: true, facts: { width: 1080, height: 1920, durationSeconds: 15 }, rotation: 90 });
  });

  it('180도: 가로·세로는 그대로이고 표식이 있다는 것만 알린다', () => {
    expect(readCreative(fixture('tiny-320x180-turn180.mp4'))).toMatchObject({ ok: true, facts: { width: 320, height: 180 }, rotation: 180 });
  });

  it('270도: 가로·세로를 바꿔 낸다', () => {
    expect(readCreative(fixture('tiny-320x180-turn270.mp4'))).toMatchObject({ ok: true, facts: { width: 180, height: 320 }, rotation: 270 });
  });

  it('손으로 짠 파일에서도 같다(행렬의 네 값으로 돌림을 읽는다)', () => {
    for (const turn of [0, 90, 180, 270] as const) {
      const got = readCreative(tinyMp4({ stored: { width: 1280, height: 720 }, turn }));
      const swapped = turn === 90 || turn === 270;
      expect(got, `${turn}도`).toMatchObject({ ok: true, facts: { width: swapped ? 720 : 1280, height: swapped ? 1280 : 720 }, rotation: turn });
    }
  });
});

describe('MP4 머리 상자의 여러 꼴', () => {
  it('조각으로 나뉜 MP4 는 머리에 전체 길이가 없다. 가로·세로만 내고 길이는 모른다고 한다', () => {
    const got = readCreative(fixture('fragmented-1280x720.mp4'));
    expect(got).toMatchObject({ ok: true, facts: { format: 'mp4', width: 1280, height: 720, durationSeconds: null } });
  });

  it('길이 = duration ÷ timescale, 소수 둘째 자리까지', () => {
    const seconds = (timescale: number, duration: number) => {
      const got = readCreative(tinyMp4({ timescale, duration }));
      return got.ok ? got.facts.durationSeconds : 'unreadable';
    };
    expect(seconds(1000, 15000)).toBe(15);
    expect(seconds(600, 9000)).toBe(15);
    expect(seconds(30000, 450600)).toBe(15.02);
    expect(seconds(90000, 1351800)).toBe(15.02);
    // 셋째 자리에서 반올림한다.
    expect(seconds(1000, 15004)).toBe(15);
    expect(seconds(1000, 15006)).toBe(15.01);
    // 길이를 모른다는 표시(0, 모든 비트 1)와 0 인 시간 단위는 길이 없음이다.
    expect(seconds(1000, 0)).toBeNull();
    expect(seconds(1000, 0xffffffff)).toBeNull();
    expect(seconds(0, 15000)).toBeNull();
  });

  it('길이는 영상 트랙의 것이다. 소리가 더 길어 파일 전체가 길어도 영상 트랙의 길이를 내고, 전체 길이는 따로 알린다', () => {
    // ffmpeg 로 만든 파일: 영상 15초 + 소리 17초(ffprobe 로 확인한 값).
    expect(readCreative(fixture('board-1920x1080-15s-sound17s.mp4'))).toMatchObject({ ok: true, facts: { width: 1920, height: 1080, durationSeconds: 15 }, wholeSeconds: 17, rotation: 0 });
    for (const version of [0, 1] as const) {
      expect(readCreative(tinyMp4({ version, duration: 17_000, trackDuration: 15_000 }))).toMatchObject({ ok: true, facts: { durationSeconds: 15 }, wholeSeconds: 17 });
    }
    // 전체와 같으면 전체 길이를 따로 싣지 않는다.
    const same = readCreative(tinyMp4({ duration: 15_000 }));
    expect(same.ok && 'wholeSeconds' in same).toBe(false);
    // 트랙 머리에 길이가 없으면(0, 모든 비트 1) 파일 전체의 길이를 쓴다.
    expect(readCreative(tinyMp4({ duration: 15_000, trackDuration: 0 }))).toMatchObject({ ok: true, facts: { durationSeconds: 15 } });
    expect(readCreative(tinyMp4({ duration: 15_000, trackDuration: 0xffffffff }))).toMatchObject({ ok: true, facts: { durationSeconds: 15 } });
  });

  it('시각·길이를 8바이트로 적은 머리(판 1)도 같은 값으로 읽는다', () => {
    const got = readCreative(tinyMp4({ version: 1, stored: { width: 1080, height: 1920 }, timescale: 1000, duration: 20_000, turn: 90 }));
    expect(got).toMatchObject({ ok: true, facts: { width: 1920, height: 1080, durationSeconds: 20 }, rotation: 90 });
  });

  it('저장된 크기(stsd)가 없으면 트랙 머리(tkhd)의 보이는 크기를 쓴다. 둘 다 있으면 저장된 크기다', () => {
    expect(readCreative(tinyMp4({ stored: null, shown: { width: 1280, height: 720 } }))).toMatchObject({ ok: true, facts: { width: 1280, height: 720 } });
    expect(readCreative(tinyMp4({ stored: { width: 1440, height: 1080 }, shown: { width: 1920, height: 1080 } }))).toMatchObject({
      ok: true,
      facts: { width: 1440, height: 1080 },
    });
  });

  it('영상 자료 상자의 크기가 64비트로 적혀 있거나, 끝 상자가 "파일 끝까지"여도 따라간다', () => {
    expect(readCreative(tinyMp4({ mdatBytes: 64, wideMdat: true, openEnded: true }))).toMatchObject({ ok: true, facts: { width: 1920, height: 1080, durationSeconds: 15 } });
  });

  it('영상 트랙이 없으면(소리만) 읽지 못함', () => {
    expect(readCreative(tinyMp4({ handler: 'soun' }))).toEqual({ ok: false, problem: 'unreadable' });
  });

  it('크기가 머리보다 작다고 적힌 상자는 읽지 않는다(같은 자리를 끝없이 다시 읽지 않는다)', () => {
    const ftyp = [...tinyMp4().subarray(0, 20)];
    const pad = (parts: number[]) => bytesOf(parts, new Array<number>(100 - parts.length).fill(0));
    // 64비트 크기가 0, 64비트 크기가 8(머리 16바이트보다 작다), 32비트 크기가 4(머리 8바이트보다 작다).
    const cases: Array<[string, number[]]> = [
      ['64비트 크기 0', [...be32(1), ...ascii('moov'), ...be64(0)]],
      ['64비트 크기 8', [...be32(1), ...ascii('moov'), ...be64(8)]],
      ['32비트 크기 4', [...be32(4), ...ascii('moov')]],
    ];
    for (const [name, head] of cases) {
      const bytes = pad([...ftyp, ...head]);
      // 상자 머리부터 본다(이 방어가 없으면 아래 readCreative 가 끝나지 않는다).
      expect(boxAt(bytes, 20, bytes.length), name).toBeNull();
      expect(readCreative(bytes), name).toEqual({ ok: false, problem: 'unreadable' });
    }
    // 머리와 꼭 같은 크기(내용이 빈 상자)는 된다.
    expect(boxAt(bytesOf(be32(8), ascii('free')), 0, 8)).toEqual({ type: 'free', body: 8, end: 8 });
    expect(boxAt(bytesOf(be32(1), ascii('free'), be64(16)), 0, 16)).toEqual({ type: 'free', body: 16, end: 16 });
  });

  it('상자가 파일 끝을 넘으면 잘린 파일이다', () => {
    const whole = tinyMp4({ mdatBytes: 64 });
    expect(readCreative(whole).ok).toBe(true);
    for (const cut of [whole.length - 1, whole.length - 40, 40, 12]) {
      expect(readCreative(whole.subarray(0, cut)), `${cut}바이트에서 끊음`).toEqual({ ok: false, problem: 'unreadable' });
    }
  });
});

describe('JPG 표식의 여러 꼴', () => {
  it('부가 정보(APP1) 안의 미리보기 그림 크기를 집지 않는다', () => {
    // 부가 정보 안에 크기 표식처럼 생긴 바이트(160x120)가 들어 있다. 길이만큼 건너뛰어야 한다.
    const thumbnail = [...ascii('Exif'), 0, 0, 0xff, 0xd8, ...segment(0xc0, sofBody(160, 120)), 0xff, 0xd9];
    expect(readJpeg(tinyJpeg(1920, 1080, { before: segment(0xe1, thumbnail) }))).toEqual({ width: 1920, height: 1080 });
  });

  it('표식 앞의 채움 바이트(FF 가 이어짐)와 다른 표(DQT·DHT)를 건너뛴다', () => {
    const before = [...segment(0xdb, [0, ...new Array<number>(64).fill(1)]), ...segment(0xc4, [0, 1, 2, 3]), 0xff, 0xff];
    expect(readJpeg(tinyJpeg(1080, 1920, { before }))).toEqual({ width: 1080, height: 1920 });
  });

  it('점진 방식(SOF2)도 같은 자리에서 읽는다. 허프만 표(C4)는 크기 표식이 아니다', () => {
    expect(readJpeg(tinyJpeg(1280, 720, { sof: 0xc2 }))).toEqual({ width: 1280, height: 720 });
    // C4 는 SOF 가 아니므로 크기를 찾지 못한 채 그림 자료에 닿는다.
    expect(readJpeg(tinyJpeg(1280, 720, { sof: 0xc4 }))).toBeNull();
  });

  it('세로가 0 이거나 그림 자료 없이 끝나면 읽지 못함', () => {
    expect(readJpeg(tinyJpeg(1920, 0))).toBeNull();
    expect(readJpeg(bytesOf([0xff, 0xd8], segment(0xc0, sofBody(1920, 1080)), [0xff, 0xd9]))).toBeNull();
    expect(readJpeg(bytesOf([0xff, 0xd8, 0x00, 0x10]))).toBeNull();
  });
});

describe('PNG·WEBP 머리의 여러 꼴', () => {
  it('PNG: 가로나 세로가 0 이면 읽지 못함. 첫 조각이 IHDR 이 아니어도 읽지 못함', () => {
    expect(readPng(tinyPng(0, 1080))).toBeNull();
    const wrongFirst = tinyPng(1920, 1080);
    wrongFirst.set(ascii('tEXt'), 12);
    expect(readPng(wrongFirst)).toBeNull();
  });

  it('WEBP 확장 머리(VP8X): 캔버스 크기는 3바이트씩, 1 을 뺀 값으로 적혀 있다', () => {
    expect(readWebp(tinyWebp('VP8X', [0x10, 0, 0, 0, ...le24(3840 - 1), ...le24(2160 - 1)]))).toEqual({ width: 3840, height: 2160 });
  });

  it('WEBP 손실 머리(VP8): 시작 표식 뒤 14비트씩. 위의 2비트(확대 표시)는 버린다', () => {
    const body = (width: number, height: number, mark = [0x9d, 0x01, 0x2a]) => [0, 0, 0, ...mark, width & 0xff, width >> 8, height & 0xff, height >> 8];
    expect(readWebp(tinyWebp('VP8 ', body(1280, 720)))).toEqual({ width: 1280, height: 720 });
    expect(readWebp(tinyWebp('VP8 ', body(1280 | 0x4000, 720 | 0x8000)))).toEqual({ width: 1280, height: 720 });
    expect(readWebp(tinyWebp('VP8 ', body(1280, 720, [0, 0, 0])))).toBeNull();
  });

  it('WEBP 무손실 머리(VP8L): 4바이트에 (가로−1) 14비트, (세로−1) 14비트', () => {
    const bits = (1080 - 1) | ((1920 - 1) << 14);
    expect(readWebp(tinyWebp('VP8L', [0x2f, ...le32(bits)]))).toEqual({ width: 1080, height: 1920 });
    expect(readWebp(tinyWebp('VP8L', [0x00, ...le32(bits)]))).toBeNull();
  });

  it('WEBP: 모르는 첫 조각이거나 그릇에 적힌 길이보다 짧으면 읽지 못함', () => {
    expect(readWebp(tinyWebp('ICCP', [1, 2, 3, 4]))).toBeNull();
    const whole = tinyWebp('VP8X', [0, 0, 0, 0, ...le24(99), ...le24(99)]);
    expect(readWebp(whole.subarray(0, whole.length - 1))).toBeNull();
  });
});

describe('브라우저에서 읽는 길(파일을 조각으로 읽는다)', () => {
  /** 바이트 배열을 파일처럼 조각으로 읽어 주고, 어디를 얼마나 읽었는지 적어 둔다. */
  function ranged(bytes: Uint8Array) {
    const asked: Array<[offset: number, length: number]> = [];
    const read: ReadRange = async (offset, length) => {
      asked.push([offset, length]);
      return bytes.subarray(offset, offset + length);
    };
    return { read, asked, total: () => asked.reduce((sum, [, length]) => sum + length, 0) };
  }

  const MP4S = [
    'board-1920x1080-15s.mp4',
    'board-1920x1080-15s-faststart.mp4',
    'board-1920x1080-15.6s.mp4',
    'shelter-1280x720-10s-hevc.mp4',
    'phone-1920x1080-turn90.mp4',
    'fragmented-1280x720.mp4',
    'oldcodec-320x180.mp4',
    'sound-only.mp4',
    'board-1920x1080-15s-sound17s.mp4',
    'cut-tail.mp4',
    'cut-tail-faststart.mp4',
  ];
  it.each(MP4S)('%s: 조각으로 읽어도 통째로 읽은 것과 같은 답이다', async (name) => {
    const bytes = fixture(name);
    expect(await readMp4ByRange(ranged(bytes).read, bytes.length)).toEqual(readCreative(bytes));
    expect(await readCreativeFile(ranged(bytes).read, bytes.length)).toEqual(readCreative(bytes));
  });

  it('영상 자료(mdat)는 읽지 않는다. 머리 상자와 상자 머리 몇 개만 읽는다', async () => {
    const bytes = tinyMp4({ mdatBytes: 1_000_000, stored: { width: 1080, height: 1920 }, duration: 20_000 });
    const file = ranged(bytes);
    const got = await readCreativeFile(file.read, bytes.length);
    expect(got).toEqual({ ok: true, facts: { format: 'mp4', width: 1080, height: 1920, sizeBytes: bytes.length, durationSeconds: 20 }, rotation: 0 });
    expect(file.total()).toBeLessThan(2000);
  });

  it('용량은 읽은 조각이 아니라 파일 전체의 크기로 낸다', async () => {
    const bytes = tinyMp4({ mdatBytes: 5000 });
    const got = await readMp4ByRange(ranged(bytes).read, bytes.length);
    expect(got.ok && got.facts.sizeBytes).toBe(bytes.length);
  });

  it('그림은 통째로 읽는다. MP4 가 아닌 것을 조각 읽기에 넣으면 받지 않는 형식이다', async () => {
    for (const name of ['board-1920x1080.jpg', 'pillar-1080x1920.png', 'shelter-1280x720-alpha.webp', 'cut-tail.jpg', 'gif-inside.png']) {
      const bytes = fixture(name);
      expect(await readCreativeFile(ranged(bytes).read, bytes.length), name).toEqual(readCreative(bytes));
    }
    const png = fixture('pillar-1080x1920.png');
    expect(await readMp4ByRange(ranged(png).read, png.length)).toEqual({ ok: false, problem: 'unsupported' });
  });

  it('통째로 읽는 상한을 넘는 그림은 읽지 않고 그렇게 알린다(앞머리만 읽는다)', async () => {
    const file = ranged(tinyPng(1920, 1080));
    expect(await readCreativeFile(file.read, RANGE_READ_LIMITS.wholeFileMaxBytes + 1)).toEqual({ ok: false, problem: 'too_big' });
    expect(file.asked).toEqual([[0, 16]]);
  });

  it('화면이 쓰는 꼴 그대로: File.slice 로 조각을 읽어도 같은 답이다', async () => {
    for (const name of ['board-1920x1080-15s.mp4', 'phone-1920x1080-turn90.mp4', 'pillar-1080x1920.png', 'cut-tail.webp', 'text-inside.png']) {
      const bytes = fixture(name);
      const file = new File([bytes], name);
      const read: ReadRange = async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
      expect(await readCreativeFile(read, file.size), name).toEqual(readCreative(bytes));
    }
  });

  it('맨 위 상자가 끝없이 이어지는 파일은 상한에서 그만 따라간다', async () => {
    // ftyp 뒤로 8바이트짜리 빈 상자가 끝없이 이어진다고 답하는 읽기 함수. 파일 크기는 16GB 라고 한다.
    const ftyp = tinyMp4().subarray(0, 20);
    let reads = 0;
    const read: ReadRange = async (offset, length) => {
      reads += 1;
      if (reads > RANGE_READ_LIMITS.maxTopBoxes + 10) throw new Error('상한을 넘어 계속 읽는다');
      return offset === 0 ? ftyp.subarray(0, length) : bytesOf(be32(8), ascii('free')).subarray(0, length);
    };
    expect(await readMp4ByRange(read, 16 * 1024 ** 3)).toEqual({ ok: false, problem: 'unreadable' });
    expect(reads).toBeGreaterThan(RANGE_READ_LIMITS.maxTopBoxes - 10);
    expect(reads).toBeLessThanOrEqual(RANGE_READ_LIMITS.maxTopBoxes + 10);
  });

  it('빈 파일, 머리 상자가 상한보다 큰 파일', async () => {
    expect(await readCreativeFile(ranged(new Uint8Array()).read, 0)).toEqual({ ok: false, problem: 'empty' });
    // moov 의 크기가 상한보다 크다고 적힌 파일. 그만큼을 메모리에 올리지 않고 그만둔다.
    const size = RANGE_READ_LIMITS.headBoxMaxBytes + 100;
    const head = bytesOf([...tinyMp4().subarray(0, 20)], be32(size), ascii('moov'), be16(0));
    const file = ranged(head);
    expect(await readMp4ByRange(file.read, 20 + size)).toEqual({ ok: false, problem: 'unreadable' });
    expect(file.total()).toBeLessThan(100);
  });
});
