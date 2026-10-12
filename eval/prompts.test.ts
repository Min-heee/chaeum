import { describe, expect, it } from 'vitest';
import { EXTRACT_PROMPTS, pickPrompts } from './prompts';

describe('평가가 아는 프롬프트 판', () => {
  it('깃발 없이 돌리면 파이프라인이 쓰는 판(v1)이다', () => {
    const picked = pickPrompts(undefined);
    expect(picked.map((p) => p.name)).toEqual(['current']);
    expect(picked[0]!.build('글').promptVersion).toBe('extract-v1');
  });
  it('판 이름으로 고른다. 판마다 프롬프트 버전 이름이 다르다', () => {
    const versions = pickPrompts('v1, v2, v3, v4').map((p) => p.build('글').promptVersion);
    expect(versions).toEqual(['extract-v1', 'extract-v2', 'extract-v3', 'extract-v4']);
    const all = Object.entries(EXTRACT_PROMPTS).filter(([name]) => name !== 'current').map(([, build]) => build('글').promptVersion);
    expect(new Set(all).size).toBe(all.length);
  });
  it('모르는 판이면 멈춘다', () => {
    expect(() => pickPrompts('v99')).toThrow('모르는 프롬프트 판');
  });
});
