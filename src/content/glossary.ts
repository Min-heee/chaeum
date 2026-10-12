// 용어집에서 이 상품에 해당하는 줄을 고르고, 글에 꼭 있어야 하는 표기를 정한다.
import type { ContentApi, GlossaryEntry, Lang } from '@/contract/content';
import { TYPE_LABELS } from '@/contract/fields';

/** 견줄 때의 꼴. 전각·합친 글자를 보통 꼴로 바꾸고 소문자로 만든다. */
const norm = (s: string): string => s.normalize('NFKC').toLowerCase();

/**
 * 글 안에 한국어 낱말(ko)이 들어 있는 용어집 줄을 찾는다. 글에 나온 순서대로 돌려준다.
 * 긴 낱말이 먼저 자리를 차지한다. "커피차"가 있는 글에서 "커피"는 따로 치지 않는다
 * (짧은 낱말이 긴 낱말에 묻혀 있을 뿐이면 그 낱말을 쓴 것이 아니다).
 */
export function entriesIn(text: string | null, glossary: readonly GlossaryEntry[]): GlossaryEntry[] {
  if (!text) return [];
  const hay = norm(text);
  const taken = new Array<boolean>(hay.length).fill(false);
  const found: { entry: GlossaryEntry; at: number }[] = [];
  const seen = new Set<string>();

  const longestFirst = [...glossary].sort((a, b) => norm(b.ko).length - norm(a.ko).length);
  for (const entry of longestFirst) {
    const needle = norm(entry.ko).trim();
    // 같은 낱말이 용어집에 두 번 있으면 앞의 줄만 쓴다.
    if (needle === '' || seen.has(needle)) continue;
    seen.add(needle);
    let firstAt = -1;
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
      let free = true;
      for (let i = at; i < at + needle.length; i += 1) if (taken[i]) free = false;
      if (!free) continue;
      for (let i = at; i < at + needle.length; i += 1) taken[i] = true;
      if (firstAt === -1) firstAt = at;
    }
    if (firstAt !== -1) found.push({ entry, at: firstAt });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.entry);
}

/** 글에 나온 용어의 그 언어 표기. 같은 표기는 한 번만. */
export function termsIn(text: string | null, glossary: readonly GlossaryEntry[], lang: Lang): string[] {
  return unique(entriesIn(text, glossary).map((e) => e[lang]));
}

/** 표기가 글에 들어 있는가. 글 검사와 같은 방식으로 본다(대소문자와 글자 꼴 차이는 봐준다). */
export function includesTerm(text: string, term: string): boolean {
  return norm(text).includes(norm(term));
}

export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/**
 * 상품에 해당하는 용어집 줄만 고른다. 종류 이름("광고 지면")·갈래·이름·지역에 한국어 낱말이 들어 있는 줄이다.
 * 돌려주는 순서는 한국어 낱말의 글자순이다. 용어집 파일의 줄 순서를 바꾸거나 상관없는 줄을 더해도
 * 모델에게 가는 입력이 같아서, 받아 둔 답(장부)이 그대로 맞는다.
 */
export const pickGlossary: ContentApi['pickGlossary'] = (glossary, facts) => {
  const picked = new Map<string, GlossaryEntry>();
  for (const text of [TYPE_LABELS[facts.type], facts.subtype, facts.name, facts.region]) {
    for (const entry of entriesIn(text, glossary)) {
      if (!picked.has(entry.ko)) picked.set(entry.ko, entry);
    }
  }
  return [...picked.values()].sort((a, b) => (a.ko < b.ko ? -1 : a.ko > b.ko ? 1 : 0));
};
