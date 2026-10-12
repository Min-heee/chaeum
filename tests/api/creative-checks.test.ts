// 시안 검사 경로(POST /api/creative-checks). 경로 함수를 직접 불러 시험용 DB 의 상품과 견준다.
// 모델을 부르지 않는 도구라 LLM 설정이 필요 없다. 파일은 tests/tools/fixtures/creative 의 작은 단색 그림·영상이다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorBodySchema } from '@/contract/api';
import { CREATIVE_LIMITS, CreativeCheckResponseSchema, type CreativeCheckResponse } from '@/contract/tools/creative';
import { closePool, getPool } from '@/server/db';
import { insertProduct, type ProductDraft } from '@/server/repos/products';
import { POST as creativeChecks } from '../../app/api/creative-checks/route';
import { count, dropWorkspaces, newWorkspace, T0 } from '../integration/helpers';
import { BOARD, fixture, PILLAR, tinyPng } from '../tools/creative-fixtures';
import { call } from './helpers';

let serial = 0;

/** 승인된 초안에서 나온 것처럼 상품 한 줄을 넣는다(원문 → 초안 → 상품). 이름과 값은 지어낸 것이다. */
async function addProduct(workspaceId: string, over: Partial<ProductDraft>): Promise<number> {
  serial += 1;
  const pool = getPool();
  const doc = await pool.query<{ id: string }>(
    'INSERT INTO source_docs (workspace_id, clean_text, content_hash, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [workspaceId, `시안 검사 시험 글 ${serial}`, `creative-test-${serial}`, T0],
  );
  const draft = await pool.query<{ id: string }>(
    `INSERT INTO drafts (workspace_id, source_doc_id, status, created_at, updated_at) VALUES ($1, $2, 'APPROVED', $3, $3) RETURNING id`,
    [workspaceId, doc.rows[0]?.id, T0],
  );
  const product: ProductDraft = {
    type: 'ad', subtype: '전광판', name: `가상 전광판 ${serial}`, price_krw: 1_500_000, list_price_krw: null, vat_included: false,
    spec: {}, options: [{ days: 7, price_krw: 1_500_000 }], ...over,
  };
  return insertProduct(pool, workspaceId, Number(draft.rows[0]?.id), product, T0);
}

/** 상품 번호와 파일 하나를 실은 올리기 본문. */
function upload(productId: number | string | null, bytes: Uint8Array<ArrayBuffer> | null, name = '시안.bin'): FormData {
  const form = new FormData();
  if (productId !== null) form.append(CREATIVE_LIMITS.productField, String(productId));
  if (bytes !== null) form.append(CREATIVE_LIMITS.formField, new File([bytes], name));
  return form;
}

const post = <T = CreativeCheckResponse>(body: unknown, ws: string | null) => call<T>(creativeChecks, 'POST', '/api/creative-checks', { ws, body });

let ws = '';
let otherWs = '';
let board = 0;
let pillar = 0;
let coffee = 0;
let noSpec = 0;
let foreign = 0;

beforeAll(async () => {
  ws = await newWorkspace();
  otherWs = await newWorkspace();
  board = await addProduct(ws, { name: '합정역 가상 전광판', spec: { region: '합정역', ...BOARD } });
  pillar = await addProduct(ws, { subtype: '지하철', name: '홍대입구역 가상 조명 광고', spec: { region: '홍대입구역', ...PILLAR } });
  coffee = await addProduct(ws, {
    type: 'catering', subtype: '커피차', name: '가상 커피차', price_krw: 800_000, options: [{ qty: 100, price_krw: 800_000 }], spec: { service_region: '서울 전역' },
  });
  noSpec = await addProduct(ws, { name: '규격을 안 적은 가상 전광판', spec: { region: '상수역' } });
  foreign = await addProduct(otherWs, { name: '남의 공간의 가상 전광판', spec: BOARD });
});

afterAll(async () => {
  await dropWorkspaces();
  await closePool();
});

describe('파일을 올려 견준다(서버가 파일 머리를 읽는다)', () => {
  it('규격에 맞는 영상: 항목 셋이 모두 맞음이고, 서버가 읽었다고 적는다', async () => {
    const got = await post(upload(board, fixture('board-1920x1080-15s.mp4'), 'C:\\시안\\생일 광고 15초.mp4'), ws);
    expect(got.status).toBe(200);
    const body = CreativeCheckResponseSchema.parse(got.body);
    expect(body).toMatchObject({
      product: { id: board, name: '합정역 가상 전광판', type: 'ad', subtype: '전광판' },
      file: { format: 'mp4', width: 1920, height: 1080, durationSeconds: 15, sizeBytes: 2356, name: '생일 광고 15초.mp4' },
      readBy: 'server',
      verdict: 'pass',
      stored: false,
    });
    expect(body.items).toEqual([
      { key: 'format', outcome: 'match', expected: 'jpg, mp4', actual: 'mp4', fix: null },
      { key: 'resolution', outcome: 'match', expected: '1920x1080', actual: '1920x1080', fix: null },
      { key: 'duration', outcome: 'match', expected: '15초', actual: '15초', fix: null },
    ]);
    expect(got.response.headers.get('cache-control')).toBe('no-store');
  });

  it('규격에 맞는 그림: 길이 항목은 없다', async () => {
    const got = await post(upload(pillar, fixture('pillar-1080x1920.png'), '조명 광고.png'), ws);
    expect(got.status).toBe(200);
    expect(got.body.verdict).toBe('pass');
    expect(got.body.items.map((i) => [i.key, i.outcome])).toEqual([['format', 'match'], ['resolution', 'match']]);
  });

  it('안 맞는 파일: 무엇을 얼마로 고칠지 항목마다 한 줄', async () => {
    const got = await post(upload(board, fixture('board-1920x1080-10s.mp4'), '짧은 영상.mp4'), ws);
    expect(got.status).toBe(200);
    expect(got.body.verdict).toBe('fail');
    expect(got.body.items[2]).toEqual({
      key: 'duration', outcome: 'mismatch', expected: '15초', actual: '10초',
      fix: '영상이 5초 짧습니다(지금 10초). 15초에 맞춰 다시 내보내 주세요. 0.5초까지는 봐줍니다.',
    });

    const small = await post(upload(board, fixture('small-960x540.jpg'), '작은 그림.jpg'), ws);
    expect(small.body.verdict).toBe('fail');
    expect(small.body.items[1]?.fix).toContain('크기만 키우면 됩니다(960x540 → 1920x1080)');

    const turned = await post(upload(pillar, fixture('board-1920x1080.jpg'), '가로 그림.jpg'), ws);
    expect(turned.body.items[1]?.fix).toContain('가로·세로가 뒤바뀐 크기입니다');
  });

  it('확장자를 속인 파일은 내용으로 본다. 브라우저가 붙인 형식 이름도 믿지 않는다', async () => {
    const form = new FormData();
    form.append(CREATIVE_LIMITS.productField, String(board));
    // 이름도, 브라우저가 붙인 형식 이름도 jpg 라고 하지만 내용은 PNG 다.
    form.append(CREATIVE_LIMITS.formField, new File([fixture('png-inside.jpg')], '시안.jpg', { type: 'image/jpeg' }));
    const got = await post(form, ws);
    expect(got.status).toBe(200);
    expect(got.body.file.format).toBe('png');
    expect(got.body.items[0]).toMatchObject({ key: 'format', outcome: 'mismatch', actual: 'png (파일 이름은 .jpg)' });
    expect(got.body.verdict).toBe('fail');
  });

  it('회전 표식이 붙은 영상은 돌려서 보이는 크기로 견주고, 그렇게 했다고 적는다', async () => {
    const got = await post(upload(board, fixture('phone-1920x1080-turn90.mp4'), '세워 찍은 영상.mp4'), ws);
    expect(got.body.file).toMatchObject({ width: 1080, height: 1920 });
    expect(got.body.items[1]).toMatchObject({ outcome: 'mismatch', actual: '1080x1920 (회전 표식 90도를 반영한 크기. 저장된 크기는 1920x1080)' });
    expect(got.body.items[1]?.fix).toContain('회전 표식 없이 다시 내보내 주세요');
  });

  it('규격 칸이 빈 지면과 광고 지면이 아닌 상품: 견줄 규격 없음(맞다고 하지 않는다)', async () => {
    for (const productId of [noSpec, coffee]) {
      const got = await post(upload(productId, fixture('board-1920x1080.jpg'), '그림.jpg'), ws);
      expect(got.status).toBe(200);
      expect(got.body.verdict).toBe('no_spec');
      expect(got.body.items.every((i) => i.outcome === 'no_spec' && i.expected === null && i.fix === null)).toBe(true);
      expect(got.body.items[1]?.actual).toBe('1920x1080');
    }
  });
});

describe('읽은 값만 보내 견준다(서버는 파일을 보지 못한다)', () => {
  const facts = { format: 'mp4', width: 1920, height: 1080, sizeBytes: 180_000_000, durationSeconds: 15.02 };

  it('큰 영상은 파일 없이 읽은 값만 보낸다. 응답이 누가 읽었는지 적는다', async () => {
    const got = await post({ productId: board, facts, fileName: '생일 광고 원본.mp4' }, ws);
    expect(got.status).toBe(200);
    const body = CreativeCheckResponseSchema.parse(got.body);
    expect(body).toMatchObject({ readBy: 'client', verdict: 'pass', stored: false, file: { ...facts, name: '생일 광고 원본.mp4' } });
    expect(body.items[2]).toMatchObject({ key: 'duration', outcome: 'match', actual: '15.02초' });
  });

  it('값이 규격과 다르면 같은 고칠 점이 나온다', async () => {
    const got = await post({ productId: board, facts: { ...facts, width: 3840, height: 2160, durationSeconds: 30 } }, ws);
    expect(got.body.verdict).toBe('fail');
    expect(got.body.file.name).toBeNull();
    expect(got.body.items.map((i) => i.outcome)).toEqual(['match', 'mismatch', 'mismatch']);
    expect(got.body.items[1]?.fix).toBe('비율은 같습니다. 크기만 줄이면 됩니다(3840x2160 → 1920x1080).');
  });

  it('꼴이 틀린 요청은 400', async () => {
    const bad: unknown[] = [
      { productId: board },
      { productId: board, facts: { ...facts, format: 'gif' } },
      { productId: board, facts: { ...facts, width: 0 } },
      { productId: board, facts: { ...facts, sizeBytes: CREATIVE_LIMITS.declaredMaxBytes + 1 } },
      { productId: String(board), facts },
      { productId: board, facts, extra: true },
      '{"productId":',
    ];
    for (const body of bad) {
      const got = await post<unknown>(body, ws);
      expect(got.status, JSON.stringify(body)).toBe(400);
      expect(ApiErrorBodySchema.parse(got.body).code).toBe('BAD_INPUT');
    }
  });
});

describe('견줄 수 없는 요청', () => {
  it('없는 상품, 남의 공간의 상품은 404. 공간 헤더가 없으면 본보기 공간에서 찾는다', async () => {
    const file = () => upload(board, fixture('board-1920x1080.jpg'), '그림.jpg');
    const missing = await post<unknown>(upload(999_999_999, fixture('board-1920x1080.jpg')), ws);
    expect(missing.status).toBe(404);
    expect(ApiErrorBodySchema.parse(missing.body).code).toBe('NOT_FOUND');

    expect((await post<unknown>(upload(foreign, fixture('board-1920x1080.jpg')), ws)).status).toBe(404);
    expect((await post<unknown>(file(), otherWs)).status).toBe(404);
    // 헤더 없이 부르면 본보기 공간의 상품만 본다. 내 공간의 상품 번호는 거기에 없다.
    expect((await post<unknown>(file(), null)).status).toBe(404);
    expect((await post<unknown>({ productId: board, facts: { format: 'jpg', width: 1, height: 1, sizeBytes: 1, durationSeconds: null } }, null)).status).toBe(404);
  });

  it('받지 않는 형식은 415. 이름이 png 여도 내용이 GIF·글자면 받지 않는다', async () => {
    for (const name of ['gif-inside.png', 'text-inside.png', 'quicktime-inside.mp4']) {
      const got = await post<unknown>(upload(board, fixture(name), name), ws);
      expect(got.status, name).toBe(415);
      expect(ApiErrorBodySchema.parse(got.body).code).toBe('UNSUPPORTED_FILE');
    }
  });

  it('잘린 파일은 422. 머리에 크기가 적혀 있어도 값을 내지 않는다', async () => {
    for (const name of ['cut-head.png', 'cut-tail.png', 'cut-tail.jpg', 'cut-tail.webp', 'cut-tail.mp4', 'cut-tail-faststart.mp4', 'sound-only.mp4']) {
      const got = await post<unknown>(upload(board, fixture(name), name), ws);
      expect(got.status, name).toBe(422);
      const body = ApiErrorBodySchema.parse(got.body);
      expect(body.code).toBe('UNREADABLE_FILE');
      expect(body.message).toContain('짐작해 내지는 않습니다');
    }
  });

  it('4MB 를 넘는 파일과 한도를 넘는 요청은 413', async () => {
    // 머리는 멀쩡한 PNG 지만 파일 상한을 1바이트 넘는다. 요청 본문은 한도 안이다.
    const big = new Uint8Array(CREATIVE_LIMITS.fileMaxBytes + 1);
    big.set(tinyPng(1920, 1080));
    const overFile = await post<unknown>(upload(board, big, '큰 그림.png'), ws);
    expect(overFile.status).toBe(413);
    expect(ApiErrorBodySchema.parse(overFile.body)).toMatchObject({ code: 'FILE_TOO_LARGE' });

    const overRequest = await post<unknown>(upload(board, new Uint8Array(CREATIVE_LIMITS.requestMaxBytes + 1), '아주 큰 파일.mp4'), ws);
    expect(overRequest.status).toBe(413);
  });

  it('빈 파일, 상품 번호 없음, 파일 없음, 파일 둘은 400', async () => {
    const two = upload(board, fixture('board-1920x1080.jpg'), '하나.jpg');
    two.append(CREATIVE_LIMITS.formField, new File([fixture('small-960x540.jpg')], '둘.jpg'));
    const notFile = upload(board, null);
    notFile.append(CREATIVE_LIMITS.formField, '파일이 아니라 글자');
    const cases: Array<[string, FormData]> = [
      ['빈 파일', upload(board, new Uint8Array(), '빈 파일.png')],
      ['상품 번호 없음', upload(null, fixture('board-1920x1080.jpg'))],
      ['상품 번호가 수가 아님', upload('abc', fixture('board-1920x1080.jpg'))],
      ['상품 번호가 0', upload(0, fixture('board-1920x1080.jpg'))],
      ['파일 없음', upload(board, null)],
      ['파일 둘', two],
      ['파일 칸에 글자', notFile],
    ];
    for (const [label, form] of cases) {
      const got = await post<unknown>(form, ws);
      expect(got.status, label).toBe(400);
      expect(ApiErrorBodySchema.parse(got.body).code).toBe('BAD_INPUT');
    }
  });
});

describe('저장하지 않는다', () => {
  it('검사를 몇 번 해도 어느 표에도 줄이 늘지 않는다', async () => {
    const tables = ['source_docs', 'drafts', 'products', 'product_texts', 'jobs', 'llm_calls', 'draft_events', 'workspaces'];
    const snapshot = async () => Promise.all(tables.map((table) => count(table)));
    const before = await snapshot();
    await post(upload(board, fixture('board-1920x1080-15s.mp4'), '영상.mp4'), ws);
    await post(upload(board, fixture('cut-tail.png'), '잘린 그림.png'), ws);
    await post({ productId: pillar, facts: { format: 'png', width: 1080, height: 1920, sizeBytes: 10_389, durationSeconds: null } }, ws);
    // 공간 헤더 없이 불러도 새 공간이 생기지 않는다(읽기만 하는 경로다).
    await post(upload(board, fixture('board-1920x1080.jpg'), '그림.jpg'), null);
    expect(await snapshot()).toEqual(before);
  });
});
