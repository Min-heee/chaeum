import { describe, expect, it } from 'vitest';
import { cacheKey, canonicalJson } from './cache-key';
import { cacheKeyFor } from './keys';
import { buildContentRequestV1 } from './prompts/content.v1';
import { buildExtractRequestV1 } from './prompts/extract.v1';

const base = {
  task: 'extract', model: 'm-1', promptVersion: 'extract-v1', schemaVersion: 's-1',
  system: '원문에서 칸을 찾아 적는다.', wireSchema: { type: 'object', properties: { type: { type: 'string' } } }, effort: 'low',
  input: { text: '가나다' },
};

describe('입력 정리', () => {
  it('키를 적은 순서가 달라도 같은 글이 된다', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it('목록의 순서는 지킨다', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
  });
  it('undefined 인 키는 없는 것과 같다', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
  it('풀어쓴 한글과 모아쓴 한글은 같은 글이다', () => {
    expect(canonicalJson({ t: '가'.normalize('NFD') })).toBe(canonicalJson({ t: '가' }));
  });
});

describe('장부 키', () => {
  it('64자 16진수이고 같은 요청이면 같다', () => {
    expect(cacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey(base)).toBe(cacheKey({ ...base, input: { text: '가나다' } }));
  });
  it('값이 고정돼 있다(계산법을 바꾸면 녹화본이 전부 못 쓰게 되므로 알아채야 한다)', () => {
    expect(cacheKey(base)).toMatchInlineSnapshot(`"eca0e1ce5dc427e2c9e5dc18aeb1b7afdc0daa9e423dba3daf16862dbd45dd25"`);
  });
  it.each([
    ['task', { task: 'content' }],
    ['model', { model: 'm-2' }],
    ['promptVersion', { promptVersion: 'extract-v2' }],
    ['schemaVersion', { schemaVersion: 's-2' }],
    ['system', { system: '원문에서 칸을 찾아 적는다. 없는 값은 채우지 않는다.' }],
    ['wireSchema', { wireSchema: { type: 'object', properties: { type: { type: 'string', enum: ['ad'] } } } }],
    ['effort', { effort: 'medium' }],
    ['input', { input: { text: '가나다.' } }],
  ])('%s 가 바뀌면 키가 바뀐다', (_name, change) => {
    expect(cacheKey({ ...base, ...change })).not.toBe(cacheKey(base));
  });
  it('조각의 경계를 옮겨도 같은 키가 되지 않는다', () => {
    expect(cacheKey({ ...base, task: 'ab', model: 'c' })).not.toBe(cacheKey({ ...base, task: 'a', model: 'bc' }));
  });
});

describe('요청의 키', () => {
  it('같은 원문이면 같고, 원문이나 모델이 다르면 다르다', () => {
    const a = buildExtractRequestV1('강남역 전광판 1주 150만원');
    expect(cacheKeyFor(a, 'm-1')).toBe(cacheKeyFor(buildExtractRequestV1('강남역 전광판 1주 150만원'), 'm-1'));
    expect(cacheKeyFor(a, 'm-1')).not.toBe(cacheKeyFor(buildExtractRequestV1('강남역 전광판 1주 160만원'), 'm-1'));
    expect(cacheKeyFor(a, 'm-1')).not.toBe(cacheKeyFor(a, 'm-2'));
  });
  it('버전 이름이 같아도 시스템 글이 바뀌면 키가 바뀐다(옛 녹화가 새 프롬프트의 답으로 나가지 않게)', () => {
    const a = buildExtractRequestV1('가');
    expect(cacheKeyFor({ ...a, system: `${a.system}\n- 새 규칙 하나.` }, 'm')).not.toBe(cacheKeyFor(a, 'm'));
  });
  it('최대 토큰 수는 키에 들지 않는다', () => {
    const a = buildExtractRequestV1('가');
    expect(cacheKeyFor({ ...a, maxTokens: 1 }, 'm')).toBe(cacheKeyFor(a, 'm'));
  });
  it('글 만들기: 다시 쓰라는 까닭이 붙으면 키가 달라진다(같은 녹화를 또 받지 않게)', () => {
    const input = { type: 'ad' as const, subtype: '전광판', name: '하늘빛 전광판', region: '강남역', glossary: [], placeholders: ['price' as const] };
    expect(cacheKeyFor(buildContentRequestV1(input), 'm')).toBe(cacheKeyFor(buildContentRequestV1({ ...input }), 'm'));
    expect(cacheKeyFor(buildContentRequestV1(input, 'DIGIT_FOUND'), 'm')).not.toBe(cacheKeyFor(buildContentRequestV1(input), 'm'));
  });
});
