// 파일에서 읽은 사실을 지면의 규격 칸과 견준다. 규격은 본체가 채운 상품의 spec 을 그대로 읽는다(다시 뽑지 않는다).
//   형식   file_format 목록에 드는가
//   해상도 resolution_px 와 가로·세로가 꼭 같은가. 다르면 비율만 같은지, 가로·세로가 뒤바뀐 것인지, 비율부터 다른지 갈라 고칠 점을 적는다
//   길이   spot_seconds 와 영상 트랙의 길이가 같은가(0.5초까지 봐준다). 영상에만 있는 항목이다. 소리가 더 긴 파일은 그렇다고 적기만 한다
// 규격 칸이 비었으면 "견줄 규격 없음"이다. 맞다고도 틀리다고도 하지 않는다.
// 파일에서 값을 읽지 못한 항목은 맞음으로 치지 않는다(안 맞음으로 내고, 읽지 못했다고 고칠 점에 적는다).
import { FIELD_SCHEMAS } from '@/contract/fields';
import {
  CREATIVE_FORMAT_ALIASES,
  CREATIVE_RULES,
  CREATIVE_SPEC_FIELDS,
  type CreativeCheckItem,
  type CreativeFacts,
  type CreativeVerdict,
} from '@/contract/tools/creative';
import type { Rotation } from './mp4';

type Spec = Record<string, unknown>;

/** 읽은 사실 말고 파일에 대해 아는 것. 둘 다 결과를 바꾸지 않고, 사람이 읽는 글에만 쓰인다. */
export interface CreativeAbout {
  /** 올린 파일 이름. 확장자가 내용과 다른지만 본다(형식을 정하는 데는 쓰지 않는다). */
  fileName?: string | null;
  /** 영상의 회전 표식(도). 90·270 이면 사실의 가로·세로는 이미 바꿔 놓은 값이다. 모르면 비운다. */
  rotation?: Rotation;
  /** 파일 전체의 길이(초). 영상 트랙보다 길 때만 온다. 견주는 것은 영상 트랙의 길이이고, 이 값은 읽은 값 옆에 적기만 한다. */
  wholeSeconds?: number;
}

// ── 형식 ───────────────────────────────────────────────────

/** 형식 이름을 견줄 꼴로: 소문자, 앞의 점을 떼고, "jpeg" 는 "jpg" 로. */
const formatName = (name: string): string => {
  const plain = name.trim().toLowerCase().replace(/^\./, '');
  return CREATIVE_FORMAT_ALIASES[plain] ?? plain;
};

/** 규격의 형식 목록. 칸이 없거나 빈 목록이면 null. */
function allowedFormats(spec: Spec): string[] | null {
  const parsed = FIELD_SCHEMAS.file_format.safeParse(spec[CREATIVE_SPEC_FIELDS.format]);
  if (!parsed.success) return null;
  const names = [...new Set(parsed.data.map(formatName).filter((name) => name.length > 0))];
  return names.length > 0 ? names : null;
}

/** 파일 이름 끝의 확장자(견줄 꼴로). 없으면 null. */
function extensionOf(fileName: string | null | undefined): string | null {
  const found = /\.([A-Za-z0-9]{1,5})$/.exec(fileName?.trim() ?? '');
  return found?.[1] ? formatName(found[1]) : null;
}

function checkFormat(facts: CreativeFacts, spec: Spec, fileName: string | null | undefined): CreativeCheckItem {
  const allowed = allowedFormats(spec);
  const named = extensionOf(fileName);
  // 이름의 확장자와 내용이 다르면 내용이 기준이다. 다르다는 것은 숨기지 않고 적는다.
  const disguised = named !== null && named !== facts.format;
  const actual = disguised ? `${facts.format} (파일 이름은 .${named})` : facts.format;
  if (!allowed) return { key: 'format', outcome: 'no_spec', expected: null, actual, fix: null };
  const expected = allowed.join(', ');
  if (allowed.includes(facts.format)) return { key: 'format', outcome: 'match', expected, actual, fix: null };
  const renamed = disguised ? ` 파일 이름은 .${named} 이지만 내용은 ${facts.format} 입니다. 이름만 바꿔서는 형식이 바뀌지 않습니다.` : '';
  const fix = `이 지면은 ${expected} 파일만 받습니다. 지금 파일은 ${facts.format} 입니다. 받는 형식으로 다시 내보내 주세요.${renamed}`;
  return { key: 'format', outcome: 'mismatch', expected, actual, fix };
}

// ── 해상도 ─────────────────────────────────────────────────

const sizeText = (width: number, height: number): string => `${width}x${height}`;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** 비율을 "16:9" 꼴로. 약분해도 수가 크면(683:384) 소수로 적는다("1.78:1"). */
export function ratioText(width: number, height: number): string {
  const d = gcd(width, height);
  const [a, b] = [width / d, height / d];
  if (a <= 99 && b <= 99) return `${a}:${b}`;
  return width >= height ? `${(width / height).toFixed(2)}:1` : `1:${(height / width).toFixed(2)}`;
}

/**
 * 비율이 같은가. 가로×세로를 엇갈려 곱한 값이 같으면 꼭 같은 비율이다.
 * 853x480 처럼 16:9 를 반올림한 크기는 꼭 같지 않으므로, 원본에서 1px 안쪽으로만 어긋나면 같은 비율로 본다
 * (|w − h×W÷H| < 1 또는 |h − w×H÷W| < 1 을 나눗셈 없이 적은 것이다).
 */
export function ratioMatch(width: number, height: number, specWidth: number, specHeight: number): 'exact' | 'rounded' | 'different' {
  const gap = Math.abs(width * specHeight - height * specWidth);
  if (gap === 0) return 'exact';
  return gap < Math.max(specWidth, specHeight) ? 'rounded' : 'different';
}

const turned = (rotation: Rotation | undefined): rotation is 90 | 270 => rotation === 90 || rotation === 270;

/** 회전 표식이 있을 때 읽은 크기 옆에 붙이는 말. 표식이 없으면 빈 글자. */
function rotationNote(width: number, height: number, rotation: Rotation | undefined): string {
  if (turned(rotation)) return ` (회전 표식 ${rotation}도를 반영한 크기. 저장된 크기는 ${sizeText(height, width)})`;
  return rotation === 180 ? ' (회전 표식 180도 있음)' : '';
}

function resolutionFix(width: number, height: number, w: number, h: number, rotation: Rotation | undefined): string {
  const now = sizeText(width, height);
  const goal = sizeText(w, h);
  // 저장된 크기는 규격과 같은데 회전 표식 때문에 돌아가 보이는 영상. 표식만 떼면 된다.
  if (turned(rotation) && width === h && height === w) {
    return `저장된 크기는 규격과 같은 ${goal} 인데, 회전 표식(${rotation}도) 때문에 돌아가 ${now} 크기로 보입니다. 회전 표식 없이 다시 내보내 주세요.`;
  }
  const ratio = ratioMatch(width, height, w, h);
  if (ratio !== 'different') {
    const same = ratio === 'exact' ? '비율은 같습니다.' : '비율은 거의 같습니다(1px 안쪽 차이).';
    return width > w || height > h
      ? `${same} 크기만 줄이면 됩니다(${now} → ${goal}).`
      : `${same} 크기만 키우면 됩니다(${now} → ${goal}). 키우면 흐려질 수 있으니 원본이 있으면 원본에서 다시 내보내 주세요.`;
  }
  if (width === h && height === w) return `가로·세로가 뒤바뀐 크기입니다(지금 ${now}, 규격 ${goal}). 방향을 맞춰 다시 만들어 주세요.`;
  return `비율이 다릅니다(지금 ${now} = ${ratioText(width, height)}, 규격 ${goal} = ${ratioText(w, h)}). 크기만 바꾸면 찌그러지니 규격 크기에 맞춰 다시 만들어 주세요.`;
}

function checkResolution(facts: CreativeFacts, spec: Spec, rotation: Rotation | undefined): CreativeCheckItem {
  const parsed = FIELD_SCHEMAS.resolution_px.safeParse(spec[CREATIVE_SPEC_FIELDS.resolution]);
  const want = parsed.success && parsed.data.width > 0 && parsed.data.height > 0 ? parsed.data : null;
  const { width, height } = facts;
  const actual = width !== null && height !== null ? `${sizeText(width, height)}${rotationNote(width, height, rotation)}` : null;
  if (!want) return { key: 'resolution', outcome: 'no_spec', expected: null, actual, fix: null };
  const expected = sizeText(want.width, want.height);
  if (width === null || height === null) {
    const fix = `파일에서 가로·세로를 읽지 못해 맞는지 확인하지 못했습니다. 이 지면의 규격은 ${expected} 입니다.`;
    return { key: 'resolution', outcome: 'mismatch', expected, actual, fix };
  }
  if (width === want.width && height === want.height) return { key: 'resolution', outcome: 'match', expected, actual, fix: null };
  return { key: 'resolution', outcome: 'mismatch', expected, actual, fix: resolutionFix(width, height, want.width, want.height, rotation) };
}

// ── 길이 ───────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;
const secondsText = (n: number): string => `${round2(n)}초`;

function checkDuration(facts: CreativeFacts, spec: Spec, wholeSeconds: number | undefined): CreativeCheckItem {
  const parsed = FIELD_SCHEMAS.spot_seconds.safeParse(spec[CREATIVE_SPEC_FIELDS.duration]);
  const want = parsed.success && parsed.data > 0 ? parsed.data : null;
  const got = facts.durationSeconds === null ? null : round2(facts.durationSeconds);
  // 소리 같은 다른 트랙이 영상보다 길면 숨기지 않고 적는다. 맞는지는 영상 트랙의 길이로만 본다.
  const longer = got !== null && wholeSeconds !== undefined && wholeSeconds > got ? ` (영상 트랙의 길이. 파일 전체는 ${secondsText(wholeSeconds)}: 소리 같은 다른 트랙이 영상보다 깁니다)` : '';
  const actual = got === null ? null : `${secondsText(got)}${longer}`;
  if (want === null) return { key: 'duration', outcome: 'no_spec', expected: null, actual, fix: null };
  const expected = secondsText(want);
  if (got === null) {
    const fix = `영상 길이를 읽지 못해 맞는지 확인하지 못했습니다. 이 지면의 한 번 길이는 ${expected}입니다.`;
    return { key: 'duration', outcome: 'mismatch', expected, actual, fix };
  }
  const tolerance = CREATIVE_RULES.durationToleranceSeconds;
  const gap = round2(Math.abs(got - want));
  if (gap <= tolerance) return { key: 'duration', outcome: 'match', expected, actual, fix: null };
  const fix =
    got > want
      ? `영상이 ${secondsText(gap)} 깁니다(지금 ${secondsText(got)}). ${expected}로 잘라 다시 내보내 주세요. ${secondsText(tolerance)}까지는 봐줍니다.`
      : `영상이 ${secondsText(gap)} 짧습니다(지금 ${secondsText(got)}). ${expected}에 맞춰 다시 내보내 주세요. ${secondsText(tolerance)}까지는 봐줍니다.`;
  return { key: 'duration', outcome: 'mismatch', expected, actual, fix };
}

// ── 모으기 ─────────────────────────────────────────────────

/** 안 맞는 항목이 하나라도 있으면 fail, 없고 맞는 항목이 하나는 있으면 pass, 견줄 규격이 하나도 없으면 no_spec. */
export function verdictOf(items: readonly Pick<CreativeCheckItem, 'outcome'>[]): CreativeVerdict {
  if (items.some((item) => item.outcome === 'mismatch')) return 'fail';
  return items.some((item) => item.outcome === 'match') ? 'pass' : 'no_spec';
}

/**
 * 사실과 상품의 규격 칸(spec)을 견준다. 항목의 순서는 약속의 CREATIVE_CHECKS(형식, 해상도, 길이)다. 그림이면 길이 항목은 내지 않는다.
 * about 은 사람이 읽는 글에만 쓰인다: 파일 이름의 확장자가 내용과 다르면 그렇게 적고, 회전 표식이 있으면 읽은 크기 옆에 적는다.
 */
export function checkCreative(facts: CreativeFacts, spec: Spec, about: CreativeAbout = {}): { items: CreativeCheckItem[]; verdict: CreativeVerdict } {
  const items = [checkFormat(facts, spec, about.fileName), checkResolution(facts, spec, about.rotation)];
  if (facts.format === 'mp4') items.push(checkDuration(facts, spec, about.wholeSeconds));
  return { items, verdict: verdictOf(items) };
}
