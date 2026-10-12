// 칸 이름으로 알맞은 맞추기를 고른다. 여섯 가지로 안 되는 칸(글자, 참·거짓, 횟수, 형식)도 여기서 맞춘다.
import type { NormalizeResult } from '@/contract/core-api';
import { fieldDef, type FieldKey, type FieldValue } from '@/contract/fields';
import { findNumberChunks, hasNumberRange } from '../numbers';
import { asInt, plain, read, unread } from '../text';
import { normalizeDays } from './days';
import { normalizeFootfall } from './footfall';
import { normalizeHours } from './hours';
import { normalizeMoney, normalizeVat } from './money';
import { normalizePeriodOptions, normalizeQuantityOptions } from './period';
import { normalizeResolution, normalizeSize } from './size';

/** 글자 칸. 앞뒤 공백만 뗀다. */
function normalizeText(raw: string): NormalizeResult<string> {
  const t = raw.trim();
  return t ? read(t) : unread();
}

/** 수 하나만 있을 때 그 수를 낸다. 범위나 수 둘은 못 읽은 것. */
function singleCount(t: string): NormalizeResult<number> {
  if (hasNumberRange(t)) return unread();
  const chunks = findNumberChunks(t);
  if (chunks.length !== 1 || chunks[0]!.value === null) return unread();
  const n = asInt(chunks[0]!.value);
  return n === null ? unread() : read(n);
}

/** "15초" → 15, "1분 30초" → 90(+UNIT_CONVERTED). "15초 또는 30초"는 못 읽은 것. */
function normalizeSeconds(raw: string): NormalizeResult<number> {
  const t = plain(raw);
  if (hasNumberRange(t)) return unread();
  const parts = [...t.matchAll(/(\d+)\s*(분|min(?:utes?)?|초|sec(?:onds?)?|s|秒|分钟)(?![a-z])/g)];
  if (parts.length === 0) return /^\d+$/.test(t) ? read(Number(t)) : unread();
  const kinds = parts.map((p) => (/^(분|min|分钟)/.test(p[2]!) ? 'm' : 's')).join('');
  // 더하는 것은 "1분 30초" 꼴뿐이다. "15초/30초"는 둘 중 하나를 고르라는 말이라 더하지 않는다.
  if (kinds !== 's' && kinds !== 'm' && kinds !== 'ms') return unread();
  let rest = t;
  let seconds = 0;
  for (const [i, p] of parts.entries()) {
    seconds += Number(p[1]) * (kinds[i] === 'm' ? 60 : 1);
    rest = rest.replace(p[0], ' ');
  }
  if (/\d/.test(rest)) return unread();
  return read(seconds, kinds.includes('m') ? ['UNIT_CONVERTED'] : []);
}

/** 하루 기준이 아니라는 표시. 낱글자 "주"는 앞뒤가 비었을 때만 본다("주말"을 걸지 않으려고). */
const NOT_PER_DAY = /시간|분|간격|월|주간|매주|주당|(?<![가-힣a-z])[주연년](?![가-힣a-z])|\d\s*주|hour|\/\s*h|min|week|month|小时|分钟|每周|每月/;
const PLAY_UNIT = /^\s*(?:회|번|times?|plays?|次)/;

/**
 * "하루 100회 이상" → 100. 횟수 단위(회·번)가 붙은 수 하나만 읽는다.
 * 시간당·주·월 기준과 "20분 간격"은 하루로 바꿀 근거가 없어 못 읽은 것으로 둔다.
 */
function normalizePlaysPerDay(raw: string): NormalizeResult<number> {
  const full = plain(raw);
  if (NOT_PER_DAY.test(full) || hasNumberRange(full)) return unread();
  const t = full.replace(/1\s*일|하루|일일|매일|daily|per\s*day|\/\s*일/g, ' ');
  const chunks = findNumberChunks(t);
  if (chunks.length !== 1 || chunks[0]!.value === null) return unread();
  if (!PLAY_UNIT.test(t.slice(chunks[0]!.end))) return unread();
  const n = asInt(chunks[0]!.value);
  return n === null ? unread() : read(n);
}

const KNOWN_FORMATS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'psd', 'ai', 'eps', 'pdf', 'svg',
  'mp4', 'mov', 'avi', 'wmv', 'mkv', 'webm', 'mp3', 'wav', 'zip', 'hwp', 'ppt', 'pptx', 'indd',
]);

/** 같은 형식의 다른 이름은 하나로 합친다. */
const SAME_FORMAT: Record<string, string> = { jpeg: 'jpg', tiff: 'tif' };

/**
 * "JPG, PNG / .mp4" → ["jpg", "mp4", "png"]. 아는 확장자만 고른다. 하나도 없으면 못 읽은 것.
 * "wav 불가"처럼 안 받는 형식이 섞인 글은 어느 것이 되는지 가르지 않고 못 읽은 것으로 둔다.
 */
function normalizeFormats(raw: string): NormalizeResult<string[]> {
  const t = plain(raw);
  if (/불가|안\s?[됨돼되받]|제외|못\s?받|(?<![a-z])not?(?![a-z])|不可|不支持/.test(t)) return unread();
  // "AI가 만든"의 ai 는 형식이 아니다. 뒤에 한글이 바로 붙은 낱말은 뺀다("AI 또는 PDF"는 받는다).
  const words = [...t.matchAll(/[a-z0-9]+(?![a-z0-9])(?!(?:가|는|를|로\s?만든|로\s?생성))/g)].map((m) => m[0]);
  const found = [...new Set(words.filter((w) => KNOWN_FORMATS.has(w)).map((w) => SAME_FORMAT[w] ?? w))].sort();
  return found.length > 0 ? read(found) : unread();
}

export function normalizeField(field: FieldKey, raw: string): NormalizeResult<FieldValue> {
  switch (fieldDef(field).kind) {
    case 'text':
      return normalizeText(raw);
    case 'money':
      return normalizeMoney(raw);
    case 'bool':
      return normalizeVat(raw);
    case 'days':
      return normalizeDays(raw);
    case 'footfall':
      return normalizeFootfall(raw);
    case 'size_m':
      return normalizeSize(raw, 'm');
    case 'size_mm':
      return normalizeSize(raw, 'mm');
    case 'resolution':
      return normalizeResolution(raw);
    case 'hours':
      return normalizeHours(raw);
    case 'period_options':
      return normalizePeriodOptions(raw);
    case 'quantity_options':
      return normalizeQuantityOptions(raw);
    case 'formats':
      return normalizeFormats(raw);
    case 'count':
      if (field === 'spot_seconds') return normalizeSeconds(raw);
      if (field === 'plays_per_day') return normalizePlaysPerDay(raw);
      return singleCount(plain(raw));
  }
}
