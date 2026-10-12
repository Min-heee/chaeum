// 견주기. 지면 규격 셋(가로 전광판, 세로 조명 광고, 쉘터 화면)마다 맞게 만든 파일과 일부러 틀리게 만든 파일을 가른다.
// 파일은 tests/tools/fixtures/creative 의 것을 실제로 읽어서 견준다(읽기와 견주기가 이어져 도는지까지 본다).
import { describe, expect, it } from 'vitest';
import { API_ERRORS } from '@/contract/api';
import {
  CREATIVE_CHECKS,
  CREATIVE_LIMITS,
  CREATIVE_RULES,
  CreativeCheckResponseSchema,
  type CreativeCheckKey,
  type CreativeFacts,
  type CreativeOutcome,
} from '@/contract/tools/creative';
import { BOARD, fixture, PILLAR, SHELTER, TALL_BOARD, tinyPng } from '../../../tests/tools/creative-fixtures';
import { checkCreative, ratioMatch, ratioText, verdictOf } from './check';
import { readCreative } from './read';
import { CREATIVE_PROBLEM_CODES, CREATIVE_PROBLEM_MESSAGES, creativeCheckResponse, readUploadedCreative } from './respond';

type Spec = Record<string, unknown>;

/** 시험 재료를 읽어 규격과 견준다. 파일 이름도 함께 넘긴다(확장자 속임을 적는지 보려고). */
function checkFile(name: string, spec: Spec) {
  const read = readCreative(fixture(name));
  if (!read.ok) throw new Error(`${name}: 읽지 못함(${read.problem})`);
  const { items, verdict } = checkCreative(read.facts, spec, { fileName: name, rotation: read.rotation, wholeSeconds: read.wholeSeconds });
  const item = (key: CreativeCheckKey) => items.find((i) => i.key === key);
  return { items, verdict, item, outcomes: Object.fromEntries(items.map((i) => [i.key, i.outcome])) as Partial<Record<CreativeCheckKey, CreativeOutcome>> };
}

const image = (width: number | null, height: number | null, format: CreativeFacts['format'] = 'jpg'): CreativeFacts => ({
  format,
  width,
  height,
  sizeBytes: 1000,
  durationSeconds: null,
});
const video = (seconds: number | null, width = 1920, height = 1080): CreativeFacts => ({ format: 'mp4', width, height, sizeBytes: 1000, durationSeconds: seconds });

describe('규격에 맞는 파일은 통과한다', () => {
  it.each([
    ['가로 전광판', BOARD, 'board-1920x1080.jpg'],
    ['가로 전광판', BOARD, 'board-1920x1080-15s.mp4'],
    ['가로 전광판', BOARD, 'board-1920x1080-15s-faststart.mp4'],
    ['세로 조명 광고', PILLAR, 'pillar-1080x1920.png'],
    ['세로 조명 광고', PILLAR, 'pillar-1080x1920-progressive.jpg'],
    ['쉘터 화면', SHELTER, 'shelter-1280x720.png'],
    ['쉘터 화면', SHELTER, 'shelter-1280x720-lossy.webp'],
    ['쉘터 화면', SHELTER, 'shelter-1280x720-lossless.webp'],
    ['쉘터 화면', SHELTER, 'shelter-1280x720-alpha.webp'],
    ['쉘터 화면', SHELTER, 'shelter-1280x720-10s-hevc.mp4'],
  ])('%s ← %s', (_slot, spec, name) => {
    const got = checkFile(name, spec);
    expect(got.verdict).toBe('pass');
    expect(got.items.every((i) => i.outcome === 'match' && i.fix === null)).toBe(true);
    // 영상은 항목이 셋(형식, 해상도, 길이), 그림은 둘이다. 순서는 약속의 순서다.
    expect(got.items.map((i) => i.key)).toEqual(name.endsWith('.mp4') ? [...CREATIVE_CHECKS] : ['format', 'resolution']);
  });

  it('규격과 파일의 값을 사람이 읽는 글로 싣는다', () => {
    expect(checkFile('board-1920x1080-15s.mp4', BOARD).items).toEqual([
      { key: 'format', outcome: 'match', expected: 'jpg, mp4', actual: 'mp4', fix: null },
      { key: 'resolution', outcome: 'match', expected: '1920x1080', actual: '1920x1080', fix: null },
      { key: 'duration', outcome: 'match', expected: '15초', actual: '15초', fix: null },
    ]);
  });
});

describe('해상도가 다른 파일', () => {
  it('비율은 같고 작다: 크기만 키우면 된다고 하고 목표 크기를 적는다', () => {
    const got = checkFile('small-960x540.jpg', BOARD);
    expect(got.verdict).toBe('fail');
    expect(got.outcomes).toEqual({ format: 'match', resolution: 'mismatch' });
    expect(got.item('resolution')).toMatchObject({ expected: '1920x1080', actual: '960x540' });
    expect(got.item('resolution')?.fix).toContain('비율은 같습니다. 크기만 키우면 됩니다(960x540 → 1920x1080).');
  });

  it('비율은 같고 크다: 크기만 줄이면 된다', () => {
    const got = checkFile('board-1920x1080-10s.mp4', SHELTER);
    expect(got.outcomes).toEqual({ format: 'match', resolution: 'mismatch', duration: 'match' });
    expect(got.item('resolution')?.fix).toBe('비율은 같습니다. 크기만 줄이면 됩니다(1920x1080 → 1280x720).');
  });

  it('영상도 같다: 해상도만 안 맞고 길이는 맞다', () => {
    const got = checkFile('small-1280x720-15s.mp4', BOARD);
    expect(got.outcomes).toEqual({ format: 'match', resolution: 'mismatch', duration: 'match' });
    expect(got.item('resolution')?.fix).toContain('1280x720 → 1920x1080');
  });

  it('16:9 를 반올림한 크기(853x480)는 비율이 거의 같다고 본다', () => {
    const got = checkFile('rounded-853x480.png', SHELTER);
    expect(got.outcomes).toEqual({ format: 'match', resolution: 'mismatch' });
    expect(got.item('resolution')?.fix).toContain('비율은 거의 같습니다(1px 안쪽 차이). 크기만 키우면 됩니다(853x480 → 1280x720).');
  });

  it('비율이 다르다: 크기만 바꾸면 찌그러진다고 하고 두 비율을 적는다', () => {
    const got = checkFile('square-1080x1080.jpg', BOARD);
    expect(got.verdict).toBe('fail');
    expect(got.item('resolution')?.fix).toBe(
      '비율이 다릅니다(지금 1080x1080 = 1:1, 규격 1920x1080 = 16:9). 크기만 바꾸면 찌그러지니 규격 크기에 맞춰 다시 만들어 주세요.',
    );
  });

  it('가로·세로가 뒤바뀐 크기는 따로 알린다', () => {
    const got = checkFile('board-1920x1080.jpg', PILLAR);
    expect(got.outcomes).toEqual({ format: 'match', resolution: 'mismatch' });
    expect(got.item('resolution')?.fix).toBe('가로·세로가 뒤바뀐 크기입니다(지금 1920x1080, 규격 1080x1920). 방향을 맞춰 다시 만들어 주세요.');
  });

  it('가로·세로를 읽지 못한 값은 맞음으로 치지 않는다', () => {
    const got = checkCreative(image(null, null), BOARD);
    expect(got.items[1]).toMatchObject({ key: 'resolution', outcome: 'mismatch', actual: null });
    expect(got.items[1]?.fix).toContain('읽지 못해');
    expect(got.verdict).toBe('fail');
  });
});

describe('비율 견주기', () => {
  it('꼭 같은 비율, 1px 안쪽으로 어긋난 비율, 다른 비율', () => {
    expect(ratioMatch(960, 540, 1920, 1080)).toBe('exact');
    expect(ratioMatch(3840, 2160, 1920, 1080)).toBe('exact');
    expect(ratioMatch(853, 480, 1920, 1080)).toBe('rounded');
    expect(ratioMatch(854, 480, 1920, 1080)).toBe('rounded');
    expect(ratioMatch(1366, 768, 1920, 1080)).toBe('rounded');
    // 852x480: 가로로 보면 1.33px 모자라지만(853.33 이어야 한다) 세로로 보면 0.75px 차이다. 한쪽이라도 1px 안쪽이면 같은 비율로 본다.
    expect(ratioMatch(852, 480, 1920, 1080)).toBe('rounded');
    // 850x480 은 어느 쪽으로 봐도 1px 넘게 어긋난다.
    expect(ratioMatch(850, 480, 1920, 1080)).toBe('different');
    expect(ratioMatch(1080, 1080, 1920, 1080)).toBe('different');
    expect(ratioMatch(1080, 1920, 1920, 1080)).toBe('different');
    expect(ratioMatch(1440, 1080, 1920, 1080)).toBe('different');
  });

  it('경계: 어긋남이 꼭 1px 이면 다른 비율이다(1px 안쪽만 봐준다)', () => {
    // 16x8 과 1920x1080: 세로가 8 이면 가로는 14.22 여야 한다. 엇갈려 곱한 차이 16×1080 − 8×1920 = 1920 = 규격의 긴 변. 꼭 경계다.
    expect(16 * 1080 - 8 * 1920).toBe(1920);
    expect(ratioMatch(16, 8, 1920, 1080)).toBe('different');
    // 세로 규격(1080x1920)에서도 긴 변이 경계다.
    expect(ratioMatch(8, 16, 1080, 1920)).toBe('different');
  });

  it('비율을 약분해 적는다. 약분해도 수가 크면 소수로 적는다', () => {
    expect(ratioText(1920, 1080)).toBe('16:9');
    expect(ratioText(1080, 1920)).toBe('9:16');
    expect(ratioText(1080, 1080)).toBe('1:1');
    expect(ratioText(1440, 1080)).toBe('4:3');
    expect(ratioText(1366, 768)).toBe('1.78:1');
    expect(ratioText(768, 1366)).toBe('1:1.78');
  });
});

describe('형식이 다른 파일', () => {
  it('목록에 없는 형식이면 받는 형식을 적는다', () => {
    const got = checkFile('shelter-1280x720-lossy.webp', BOARD);
    expect(got.outcomes).toEqual({ format: 'mismatch', resolution: 'mismatch' });
    expect(got.item('format')).toMatchObject({ expected: 'jpg, mp4', actual: 'webp' });
    expect(got.item('format')?.fix).toBe('이 지면은 jpg, mp4 파일만 받습니다. 지금 파일은 webp 입니다. 받는 형식으로 다시 내보내 주세요.');
  });

  it('확장자를 속인 파일: 내용이 기준이고, 이름과 다르다는 것을 적는다', () => {
    // 이름은 jpg 이고 가로 전광판은 jpg 를 받지만, 내용은 PNG 다.
    const got = checkFile('png-inside.jpg', BOARD);
    expect(got.outcomes).toEqual({ format: 'mismatch', resolution: 'match' });
    expect(got.item('format')?.actual).toBe('png (파일 이름은 .jpg)');
    expect(got.item('format')?.fix).toContain('파일 이름은 .jpg 이지만 내용은 png 입니다. 이름만 바꿔서는 형식이 바뀌지 않습니다.');
    // 내용의 형식을 받는 지면이면 통과한다. 이름이 다르다는 것은 그래도 적는다.
    const fine = checkFile('png-inside.jpg', { ...BOARD, file_format: ['png'] });
    expect(fine.verdict).toBe('pass');
    expect(fine.item('format')).toMatchObject({ outcome: 'match', actual: 'png (파일 이름은 .jpg)', fix: null });
  });

  it('규격의 형식 이름은 대소문자·앞의 점·jpeg 를 같은 것으로 본다', () => {
    const spec = { file_format: ['JPEG', '.PNG', ' Mp4 '] };
    expect(checkCreative(image(100, 100, 'jpg'), spec).items[0]).toMatchObject({ outcome: 'match', expected: 'jpg, png, mp4' });
    expect(checkCreative(image(100, 100, 'png'), spec).items[0]?.outcome).toBe('match');
    expect(checkCreative(image(100, 100, 'webp'), spec).items[0]?.outcome).toBe('mismatch');
    // 이름이 .jpeg 인 jpg 파일은 속인 것이 아니다.
    expect(checkCreative(image(100, 100, 'jpg'), spec, { fileName: '시안 최종.JPEG' }).items[0]?.actual).toBe('jpg');
  });

  it('이 도구가 읽지 못하는 형식만 받는 지면이면 안 맞음이다', () => {
    const got = checkCreative(image(1920, 1080, 'jpg'), { file_format: ['ai', 'psd'] });
    expect(got.items[0]).toMatchObject({ outcome: 'mismatch', expected: 'ai, psd' });
  });
});

describe('길이가 다른 영상', () => {
  it('짧다: 얼마나 짧은지와 맞출 길이를 적는다', () => {
    const got = checkFile('board-1920x1080-10s.mp4', BOARD);
    expect(got.outcomes).toEqual({ format: 'match', resolution: 'match', duration: 'mismatch' });
    expect(got.item('duration')).toMatchObject({ expected: '15초', actual: '10초' });
    expect(got.item('duration')?.fix).toBe('영상이 5초 짧습니다(지금 10초). 15초에 맞춰 다시 내보내 주세요. 0.5초까지는 봐줍니다.');
  });

  it('봐주는 폭(0.5초) 안이면 맞음, 밖이면 안 맞음', () => {
    expect(checkFile('board-1920x1080-15.4s.mp4', BOARD).verdict).toBe('pass');
    const long = checkFile('board-1920x1080-15.6s.mp4', BOARD);
    expect(long.outcomes.duration).toBe('mismatch');
    expect(long.item('duration')?.fix).toBe('영상이 0.6초 깁니다(지금 15.6초). 15초로 잘라 다시 내보내 주세요. 0.5초까지는 봐줍니다.');
  });

  it('경계: 꼭 0.5초 차이는 맞음이다', () => {
    expect(CREATIVE_RULES.durationToleranceSeconds).toBe(0.5);
    const outcome = (seconds: number) => checkCreative(video(seconds), BOARD).items[2]?.outcome;
    expect(outcome(15)).toBe('match');
    expect(outcome(15.5)).toBe('match');
    expect(outcome(14.5)).toBe('match');
    expect(outcome(15.51)).toBe('mismatch');
    expect(outcome(14.49)).toBe('mismatch');
    expect(outcome(30)).toBe('mismatch');
  });

  it('소리가 영상보다 긴 파일: 영상 트랙의 길이로 견주고, 파일 전체가 더 길다는 것은 읽은 값 옆에 적는다', () => {
    const got = checkFile('board-1920x1080-15s-sound17s.mp4', BOARD);
    expect(got.outcomes).toEqual({ format: 'match', resolution: 'match', duration: 'match' });
    expect(got.item('duration')).toMatchObject({ expected: '15초', fix: null });
    expect(got.item('duration')?.actual).toBe('15초 (영상 트랙의 길이. 파일 전체는 17초: 소리 같은 다른 트랙이 영상보다 깁니다)');
    // 영상 트랙 자체가 길면 그대로 안 맞음이다. 고칠 점의 "지금 ○초"는 영상 트랙의 길이다.
    const long = checkCreative(video(17), BOARD, { wholeSeconds: 19 }).items[2];
    expect(long).toMatchObject({ outcome: 'mismatch', fix: '영상이 2초 깁니다(지금 17초). 15초로 잘라 다시 내보내 주세요. 0.5초까지는 봐줍니다.' });
  });

  it('길이를 읽지 못한 영상(조각으로 나뉜 MP4)은 맞음으로 치지 않는다', () => {
    const got = checkFile('fragmented-1280x720.mp4', SHELTER);
    expect(got.outcomes).toEqual({ format: 'match', resolution: 'match', duration: 'mismatch' });
    expect(got.item('duration')).toMatchObject({ expected: '10초', actual: null });
    expect(got.item('duration')?.fix).toContain('영상 길이를 읽지 못해');
  });

  it('그림에는 길이 항목이 없다. 한 번 길이가 있는 지면에 그림을 내도 길이로는 틀리지 않는다', () => {
    const got = checkFile('board-1920x1080.jpg', BOARD);
    expect(got.items.map((i) => i.key)).toEqual(['format', 'resolution']);
    expect(checkFile('moving-320x180.webp', { file_format: ['webp'], spot_seconds: 10 }).items.map((i) => i.key)).toEqual(['format', 'resolution']);
  });
});

describe('회전 표식이 붙은 영상', () => {
  it('돌려서 보이는 크기로 견준다. 세로 지면에는 맞고, 읽은 크기 옆에 표식을 적는다', () => {
    const got = checkFile('phone-1920x1080-turn90.mp4', TALL_BOARD);
    expect(got.verdict).toBe('pass');
    expect(got.item('resolution')).toMatchObject({
      outcome: 'match',
      expected: '1080x1920',
      actual: '1080x1920 (회전 표식 90도를 반영한 크기. 저장된 크기는 1920x1080)',
      fix: null,
    });
  });

  it('저장된 크기는 규격과 같은데 표식 때문에 돌아가 보이면, 표식을 떼라고 한다', () => {
    const got = checkFile('phone-1920x1080-turn90.mp4', BOARD);
    expect(got.outcomes).toEqual({ format: 'match', resolution: 'mismatch', duration: 'match' });
    expect(got.item('resolution')?.fix).toBe(
      '저장된 크기는 규격과 같은 1920x1080 인데, 회전 표식(90도) 때문에 돌아가 1080x1920 크기로 보입니다. 회전 표식 없이 다시 내보내 주세요.',
    );
  });

  it('180도는 크기가 그대로다. 표식이 있다는 것만 적는다', () => {
    const got = checkFile('tiny-320x180-turn180.mp4', { resolution_px: { width: 320, height: 180 } });
    expect(got.item('resolution')).toMatchObject({ outcome: 'match', actual: '320x180 (회전 표식 180도 있음)' });
  });

  it('표식을 모르면(화면이 읽은 값만 보낸 길) 아무 말도 붙이지 않는다', () => {
    expect(checkCreative(video(15, 1080, 1920), TALL_BOARD).items[1]?.actual).toBe('1080x1920');
  });
});

describe('규격 칸이 빈 지면', () => {
  it('규격이 하나도 없으면 맞다고도 틀리다고도 하지 않는다', () => {
    const got = checkFile('board-1920x1080-15s.mp4', {});
    expect(got.verdict).toBe('no_spec');
    expect(got.items).toEqual([
      { key: 'format', outcome: 'no_spec', expected: null, actual: 'mp4', fix: null },
      { key: 'resolution', outcome: 'no_spec', expected: null, actual: '1920x1080', fix: null },
      { key: 'duration', outcome: 'no_spec', expected: null, actual: '15초', fix: null },
    ]);
  });

  it('있는 칸만 견준다. 빈 칸은 "견줄 규격 없음"으로 남는다', () => {
    const onlySize = checkFile('board-1920x1080-15s.mp4', { resolution_px: { width: 1920, height: 1080 } });
    expect(onlySize.outcomes).toEqual({ format: 'no_spec', resolution: 'match', duration: 'no_spec' });
    expect(onlySize.verdict).toBe('pass');
    const onlyFormat = checkFile('small-960x540.jpg', { file_format: ['png'] });
    expect(onlyFormat.outcomes).toEqual({ format: 'mismatch', resolution: 'no_spec' });
    expect(onlyFormat.verdict).toBe('fail');
  });

  it('꼴이 틀리거나 0 인 규격 값은 규격 없음으로 본다(지어내 견주지 않는다)', () => {
    const got = checkCreative(video(15), { resolution_px: { width: 0, height: 0 }, file_format: 'mp4', spot_seconds: 0 });
    expect(got.items.map((i) => i.outcome)).toEqual(['no_spec', 'no_spec', 'no_spec']);
    expect(checkCreative(video(15), { resolution_px: '1920x1080', file_format: [], spot_seconds: '15' }).verdict).toBe('no_spec');
  });

  it('광고 지면이 아닌 상품(규격 칸이 없다)도 견줄 규격 없음이다', () => {
    expect(checkFile('board-1920x1080.jpg', { service_region: '서울 전역', design_deadline_days: 5 }).verdict).toBe('no_spec');
  });
});

describe('판정 모으기', () => {
  it('안 맞음이 하나라도 있으면 fail, 맞음만 있으면 pass, 견줄 것이 없으면 no_spec', () => {
    expect(verdictOf([{ outcome: 'match' }, { outcome: 'mismatch' }, { outcome: 'no_spec' }])).toBe('fail');
    expect(verdictOf([{ outcome: 'match' }, { outcome: 'no_spec' }])).toBe('pass');
    expect(verdictOf([{ outcome: 'no_spec' }, { outcome: 'no_spec' }])).toBe('no_spec');
    expect(verdictOf([])).toBe('no_spec');
  });
});

describe('응답 짓기', () => {
  const product = { id: 7, name: '합정역 가상 전광판', type: 'ad' as const, subtype: '전광판', spec: BOARD, price_krw: 1_500_000 };

  it('약속의 응답 꼴을 채운다. 저장하지 않았다는 것을 늘 적는다', () => {
    const read = readCreative(fixture('board-1920x1080-15.6s.mp4'));
    if (!read.ok) throw new Error('읽지 못함');
    const body = creativeCheckResponse(product, { facts: read.facts, rotation: read.rotation, readBy: 'server', fileName: 'C:\\시안\\최종 15초.mp4' });
    expect(CreativeCheckResponseSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      product: { id: 7, name: '합정역 가상 전광판', type: 'ad', subtype: '전광판' },
      file: { format: 'mp4', width: 1920, height: 1080, durationSeconds: 15.6, sizeBytes: 7208, name: '최종 15초.mp4' },
      readBy: 'server',
      verdict: 'fail',
      stored: false,
    });
    // 상품의 다른 칸(값 등)은 응답에 싣지 않는다.
    expect(Object.keys(body.product).sort()).toEqual(['id', 'name', 'subtype', 'type']);
  });

  it('화면이 읽은 값만 보낸 길: 파일 이름이 없어도 되고, 누가 읽었는지 적는다', () => {
    const body = creativeCheckResponse(product, { facts: image(1920, 1080), readBy: 'client' });
    expect(body).toMatchObject({ readBy: 'client', verdict: 'pass', file: { name: null }, stored: false });
  });

  it('서버로 올라온 파일은 머리를 읽기 전에 크기부터 본다', () => {
    // 머리는 멀쩡한 PNG 지만 4MB 를 1바이트 넘는다.
    const big = new Uint8Array(CREATIVE_LIMITS.fileMaxBytes + 1);
    big.set(tinyPng(1920, 1080));
    expect(readUploadedCreative(big)).toEqual({ ok: false, problem: 'too_large' });
    expect(readUploadedCreative(fixture('board-1920x1080.jpg'))).toMatchObject({ ok: true, facts: { format: 'jpg' } });
    expect(readUploadedCreative(fixture('cut-tail.png'))).toEqual({ ok: false, problem: 'unreadable' });
  });

  it('읽지 못한 까닭마다 오류 코드와 사람이 읽는 말이 있다', () => {
    const status = (problem: keyof typeof CREATIVE_PROBLEM_CODES) => API_ERRORS[CREATIVE_PROBLEM_CODES[problem]];
    expect([status('empty'), status('unsupported'), status('unreadable'), status('too_large')]).toEqual([400, 415, 422, 413]);
    for (const message of Object.values(CREATIVE_PROBLEM_MESSAGES)) expect(message.length).toBeGreaterThan(5);
    expect(CREATIVE_PROBLEM_MESSAGES.too_large).toContain('4MB');
  });
});
