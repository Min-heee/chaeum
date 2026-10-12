// 모으기의 판단 코드. 순수 함수만 둔다(시계·난수·DB·네트워크 없음). 약속은 src/contract/tools/collect.ts 에 있다.
//   checkImportRow     수집기가 보낸 줄 하나의 꼴을 다시 보고, 글자를 정리하고, 중복 열쇠와 표시를 낸다
//   itemToSourceText   모은 줄을 초안의 "원문"이 되는 글로 적는다
//   itemToExtraction   그 글에서 본체의 뽑기 결과 꼴을 만든다(값은 본체의 맞추기가 raw 를 읽어 맞춘다)
//   adSubtypeOf        자료의 매체 종류를 본체의 광고 갈래에 맞춰 본다
import { LIMITS } from '@/contract/api';
import { cleanShortText, EDIT_LIMITS, SUBTYPES, type ExtractedField, type Extraction, type FieldKey } from '@/contract/fields';
import {
  COLLECT_LIMITS,
  COLLECTOR_FLAGS,
  collectDedupeKey,
  ImportRowSchema,
  serverFlagsOf,
  type CollectDraftApi,
  type CollectedItem,
  type CollectFlag,
  type ImportRow,
} from '@/contract/tools/collect';

// ── 받은 줄 하나 다시 보기 ─────────────────────────────────

/** 꼴 검사를 지난 줄. 없는 값은 전부 null 이다. */
export interface CheckedRow {
  line: number;
  kind: string | null;
  name: string | null;
  region: string | null;
  address: string | null;
  subway_line: string | null;
  station: string | null;
  media_type: string | null;
  width_m: number | null;
  height_m: number | null;
  quantity: number | null;
  lat: number | null;
  lng: number | null;
  operator: string | null;
  raw: Record<string, string | number | boolean | null>;
}

export type RowCheck =
  | { ok: true; row: CheckedRow; dedupeKey: string; flags: CollectFlag[] }
  | { ok: false; message: string };

const TEXT_KEYS = ['kind', 'name', 'region', 'address', 'subway_line', 'station', 'media_type', 'operator'] as const;

const TEXT_RULE = `1~${COLLECT_LIMITS.textMaxChars}자의 글자`;

/** 줄의 칸 이름 → 사람이 읽는 이름과 받는 꼴. 오류 글에 쓴다. */
const ROW_RULES: Record<keyof ImportRow, { label: string; rule: string }> = {
  line: { label: '줄 번호(line)', rule: '1 이상의 정수' },
  kind: { label: '종류(kind)', rule: TEXT_RULE },
  name: { label: '이름(name)', rule: TEXT_RULE },
  region: { label: '지역(region)', rule: TEXT_RULE },
  address: { label: '주소(address)', rule: TEXT_RULE },
  subway_line: { label: '호선(subway_line)', rule: TEXT_RULE },
  station: { label: '역(station)', rule: TEXT_RULE },
  media_type: { label: '매체 종류(media_type)', rule: TEXT_RULE },
  width_m: { label: '가로(width_m)', rule: '0보다 큰 수(m 단위)' },
  height_m: { label: '세로(height_m)', rule: '0보다 큰 수(m 단위)' },
  quantity: { label: '수량(quantity)', rule: '0 이상의 정수' },
  lat: { label: '위도(lat)', rule: '-90~90의 수' },
  lng: { label: '경도(lng)', rule: '-180~180의 수' },
  operator: { label: '운영 기관(operator)', rule: TEXT_RULE },
  raw: { label: '원래 줄(raw)', rule: '칸 이름 → 글자·수·참거짓·null 의 묶음' },
  flags: { label: '표시(flags)', rule: `${COLLECTOR_FLAGS.join(', ')} 가운데 고른 목록` },
};

/** DB 가 받지 못하는 글자(NUL, 짝 없는 대리 글자)를 뺀다. 원래 줄은 그 밖에는 손대지 않는다. */
function storable(text: string): string {
  return text.replace(/\u0000/g, '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
}

const chars = (text: string): number => [...text].length;
const shortKey = (key: string): string => (chars(key) > 30 ? `${[...key].slice(0, 30).join('')}…` : key);

/**
 * 수집기가 보낸 줄 하나를 서버가 다시 본다(수집기를 믿지 않는다).
 * - 꼴은 약속의 ImportRowSchema 그대로다. 표에 없는 칸 이름, 글자로 온 수, 빈 글자는 받지 않는다.
 * - 글자 칸은 제어 글자를 빼고 빈칸을 하나로 줄인다. 그러고 나서 빈 글자면 없는 값이다.
 * - 중복을 가를 값(이름·위치·역·호선·매체 종류·크기)이 하나도 없는 줄은 받지 않는다. 그런 줄끼리 전부 한 건으로 합쳐지기 때문이다.
 * 오류 글에는 어느 칸이 왜 틀렸는지만 적고, 들어온 값은 싣지 않는다(칸 이름만 싣는다).
 */
export function checkImportRow(input: unknown): RowCheck {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: '줄이 칸 이름과 값의 묶음이 아닙니다.' };
  }
  const parsed = ImportRowSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.code === 'unrecognized_keys') {
      const keys = issue.keys.slice(0, 3).map(shortKey).join(', ');
      return { ok: false, message: `표에 없는 칸 이름이 있습니다: ${keys}${issue.keys.length > 3 ? ' 등' : ''}.` };
    }
    const rule = ROW_RULES[String(issue?.path[0] ?? '') as keyof ImportRow] as { label: string; rule: string } | undefined;
    if (!rule) return { ok: false, message: '줄의 꼴이 틀렸습니다.' };
    return { ok: false, message: `${rule.label} 칸의 꼴이 틀렸습니다. ${rule.rule}여야 합니다.` };
  }
  const data = parsed.data;

  const raw: CheckedRow['raw'] = {};
  for (const [key, value] of Object.entries(data.raw)) raw[storable(key)] = typeof value === 'string' ? storable(value) : value;
  if (JSON.stringify(raw).length > COLLECT_LIMITS.rawMaxChars) {
    return { ok: false, message: `원래 줄(raw)이 너무 깁니다. JSON 글로 ${COLLECT_LIMITS.rawMaxChars.toLocaleString('ko-KR')}자까지 받습니다.` };
  }

  const textOf = (value: string | null | undefined): string | null => {
    const cleaned = value === null || value === undefined ? '' : cleanShortText(value);
    return cleaned === '' ? null : cleaned;
  };
  const row: CheckedRow = {
    line: data.line,
    kind: null, name: null, region: null, address: null, subway_line: null, station: null, media_type: null, operator: null,
    width_m: data.width_m ?? null,
    height_m: data.height_m ?? null,
    quantity: data.quantity ?? null,
    lat: data.lat ?? null,
    lng: data.lng ?? null,
    raw,
  };
  for (const key of TEXT_KEYS) row[key] = textOf(data[key]);

  const dedupeKey = collectDedupeKey(row);
  if (dedupeKey.replace(/\|/g, '') === '') {
    return { ok: false, message: '이 줄을 다른 줄과 가를 값(이름, 주소·지역, 역, 호선, 매체 종류, 크기)이 하나도 없습니다.' };
  }
  const collectorFlags = COLLECTOR_FLAGS.filter((flag) => data.flags?.includes(flag));
  return { ok: true, row, dedupeKey, flags: [...collectorFlags, ...serverFlagsOf(row)] };
}

// ── 줄 → 초안의 재료 ───────────────────────────────────────

/** 원문 글의 이름표. 줄은 "이름표: 값" 꼴이고 값은 한 줄이다. */
export const SOURCE_LABELS = {
  kind: '종류',
  name: '이름',
  region: '지역',
  address: '주소',
  subwayLine: '호선',
  station: '역',
  mediaType: '매체 종류',
  size: '크기',
  quantity: '수량',
  coords: '좌표',
  operator: '운영 기관',
} as const;

/** 원래 줄의 칸을 옮겨 적을 때의 앞머리. 위의 이름표와 겹치지 않는다. */
const RAW_PREFIX = '원래 칸 ';
const RAW_CUT_NOTE = '(원래 칸의 나머지는 글이 길어 줄였습니다. 모으기 화면에서 전부 볼 수 있습니다.)';

/** 값을 한 줄로. 글자 꼴을 맞추고(원문 정리와 같은 NFKC) 줄바꿈·이어진 빈칸을 빈칸 하나로 줄인다. */
const oneLine = (value: string): string => value.normalize('NFKC').replace(/\s+/g, ' ').trim();

/**
 * 갈래 맞추기. 매체 종류(없으면 종류)에 적힌 말로 본체의 광고 갈래 셋 가운데 하나를 고른다.
 * - 전광판: "전광판", "LED"   - 지하철: "지하철", "스크린도어", "승강장", "역사"   - 버스: "버스"
 * - 두 갈래의 말이 함께 있거나 하나도 없으면 고르지 않고 자료의 말을 그대로 돌려준다(그러면 "종류·갈래 불일치"로 사람이 본다).
 *   자료의 말이 갈래 칸에 넣기에 너무 길면 null 이다.
 */
export function adSubtypeOf(mediaType: string | null, kind: string | null): string | null {
  const words: [(typeof SUBTYPES.ad)[number], RegExp][] = [
    ['전광판', /전광판|led/],
    ['지하철', /지하철|스크린도어|승강장|역사/],
    ['버스', /버스/],
  ];
  for (const source of [mediaType, kind]) {
    if (!source) continue;
    const text = source.normalize('NFKC').toLowerCase();
    const hits = words.filter(([, re]) => re.test(text)).map(([subtype]) => subtype);
    if (hits.length === 1) return hits[0] ?? null;
    if (hits.length > 1) break;
  }
  const asIs = oneLine(mediaType ?? kind ?? '');
  return asIs !== '' && chars(asIs) <= EDIT_LIMITS.subtypeMaxChars ? asIs : null;
}

/**
 * 모은 줄을 초안의 "원문"이 되는 글로 적는다.
 * 첫 줄에 번호 셋(모은 줄의 번호, 출처, 출처 파일 안의 줄)을 적어 줄마다 글이 다르게 한다.
 * 값이 있는 칸만 "이름표: 값" 한 줄씩 적고, 끝에 원래 줄의 칸을 옮겨 적는다(본체의 글 길이 상한까지만).
 */
export function itemToSourceText(item: CollectedItem): string {
  const lines: string[] = [
    `[모은 줄 #${item.id}] 출처 ${item.sourceId} · ${item.line}번째 줄`,
    `자료: ${oneLine(item.sourceName)}`,
    '설치 현황 자료의 한 줄입니다. 값(가격)·운영 시간·유동인구·기간 옵션은 이 자료에 없습니다.',
  ];
  const add = (label: string, value: string | null) => {
    const text = value === null ? '' : oneLine(value);
    if (text !== '') lines.push(`${label}: ${text}`);
  };
  add(SOURCE_LABELS.kind, item.kind);
  add(SOURCE_LABELS.name, item.name);
  add(SOURCE_LABELS.region, item.region);
  add(SOURCE_LABELS.address, item.address);
  add(SOURCE_LABELS.subwayLine, item.subwayLine);
  add(SOURCE_LABELS.station, item.station);
  add(SOURCE_LABELS.mediaType, item.mediaType);
  if (item.widthM !== null && item.heightM !== null) add(SOURCE_LABELS.size, `${item.widthM}x${item.heightM}m`);
  if (item.quantity !== null) add(SOURCE_LABELS.quantity, String(item.quantity));
  if (item.lat !== null && item.lng !== null) add(SOURCE_LABELS.coords, `${item.lat}, ${item.lng}`);
  add(SOURCE_LABELS.operator, item.operator);

  // 줄 사이의 줄바꿈까지 센다. 줄였다는 말이 들어갈 자리는 남겨 둔다.
  let used = lines.reduce((sum, line) => sum + chars(line) + 1, 0);
  const budget = LIMITS.textMaxChars - chars(RAW_CUT_NOTE) - 1;
  for (const [key, value] of Object.entries(item.raw)) {
    if (value === null || value === undefined) continue;
    const text = oneLine(String(value));
    if (text === '') continue;
    const line = `${RAW_PREFIX}${oneLine(key)}: ${text}`;
    if (used + chars(line) + 1 > budget) {
      lines.push(RAW_CUT_NOTE);
      break;
    }
    lines.push(line);
    used += chars(line) + 1;
  }
  return lines.join('\n');
}

/**
 * 원문 글에서 본체의 뽑기 결과 꼴을 만든다. 모델을 부르지 않는다.
 * 칸마다 raw 는 글에 그대로 있는 값이고 value 는 null 이다(본체의 맞추기가 raw 를 읽는다). evidence 는 raw 가 든 그 줄.
 * 채우는 칸은 셋이다: name ← 이름, region ← 역(없으면 지역, 없으면 주소), size_m ← 크기. 나머지는 자료에 없어 비운다.
 * 글은 본체가 정리한 것(접수 때의 정리)을 넘긴다. 그래야 raw 가 저장된 원문과 글자까지 같다.
 */
export function itemToExtraction(item: CollectedItem, sourceText: string): Extraction {
  const lines = sourceText.split('\n');
  const read = (label: string): { raw: string; evidence: string } | null => {
    const head = `${label}: `;
    const line = lines.find((l) => l.startsWith(head));
    const raw = line?.slice(head.length).trim();
    return line && raw ? { raw, evidence: line } : null;
  };
  const fields: ExtractedField[] = [];
  const put = (field: FieldKey, found: { raw: string; evidence: string } | null) => {
    if (found) fields.push({ field, raw: found.raw, value: null, evidence: found.evidence });
  };
  put('name', read(SOURCE_LABELS.name));
  put('region', read(SOURCE_LABELS.station) ?? read(SOURCE_LABELS.region) ?? read(SOURCE_LABELS.address));
  put('size_m', read(SOURCE_LABELS.size));
  return { type: 'ad', subtype: adSubtypeOf(item.mediaType, item.kind), fields };
}

// 내보낸 것이 약속의 꼴과 같은지 타입 검사가 본다.
export const collectDraftApi: CollectDraftApi = { itemToSourceText, itemToExtraction };
