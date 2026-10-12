// 운영 시간 맞추기. "05시~25시" → { open: "05:00", close: "01:00", nextDay: true }
import type { NormalizeResult } from '@/contract/core-api';
import type { Hours } from '@/contract/fields';
import { plain, read, unread } from '../text';

const DAY = 24 * 60;
const ALL_DAY = /24\s*시간|24\s*h(?:ours?|rs?)?(?![a-z])|24\/7|하루\s*종일|종일|全天|all\s*day/g;
const RANGE_SEP = /\s*(?:~|∼|〜|–|—|-|부터|에서|(?<![a-z])to(?![a-z])|until|至|到)\s*/;
const HAS_TIME = /\d|자정|정오|midnight|noon|午夜|中午/;
const NEXT_DAY = /익일|다음\s*날|翌日|次日|next\s*day/;
const AM = /오전|아침|새벽|(?<![a-z])a\.?m\.?(?![a-z])|上午|凌晨|早上/;
const PM = /오후|저녁|낮|(?<![a-z])p\.?m\.?(?![a-z])|下午/;
const NIGHT = /밤|심야|晚上/;
/** 시각이라는 표시. 숫자만 둘("10-18")이면 시각인지 알 수 없다. */
const TIME_MARK = /시|:|点|點|时|時|[ap]\.?m|자정|정오|midnight|noon|오전|오후|午/;

interface Side {
  /** 하루의 몇 분째인가(오전·오후를 반영한 뒤). 끝 쪽은 24시를 넘을 수 있다. */
  minutes: number;
  /** 원문에 적힌 시 그대로 */
  hour: number;
  marker: 'am' | 'pm' | null;
  /** 오전·오후 없이도 뜻이 하나인 표기인가("06:00", "05시", "18시", "자정") */
  clear: boolean;
  nextDay: boolean;
}

function readSide(s: string, isEnd: boolean): Side | null {
  const nextDay = NEXT_DAY.test(s);
  if (/자정|midnight|午夜/.test(s)) {
    if (/\d/.test(s)) return null;
    return { minutes: isEnd ? DAY : 0, hour: isEnd ? 24 : 0, marker: null, clear: true, nextDay };
  }
  if (/정오|noon|中午/.test(s)) {
    if (/\d/.test(s)) return null;
    return { minutes: 12 * 60, hour: 12, marker: null, clear: true, nextDay };
  }

  const m =
    /(\d{1,2})\s*:\s*(\d{2})/.exec(s) ??
    /(\d{1,2})\s*(?:시|点|點|时|時)\s*(?:(\d{1,2})\s*(?:분|分)|(반|半))?/.exec(s) ??
    /(\d{1,2})/.exec(s);
  if (!m) return null;
  // 읽은 시각 말고 다른 숫자가 남으면 뜻을 모른다.
  if (/\d/.test(s.replace(m[0], ''))) return null;

  const hour = Number(m[1]);
  const minute = m[3] ? 30 : Number(m[2] ?? 0);
  if (minute >= 60) return null;
  const colon = m[0].includes(':');
  const clear = colon || /^0\d/.test(m[1]!) || hour >= 13 || hour === 0;

  let h = hour;
  let marker: Side['marker'] = null;
  if (AM.test(s)) {
    if (hour > 12) return null;
    if (hour === 12) h = 0;
    marker = 'am';
  } else if (PM.test(s)) {
    if (hour < 12) h = hour + 12;
    marker = 'pm';
  } else if (NIGHT.test(s)) {
    // 밤 12시는 자정, 밤 10시는 22시, 밤 1시는 새벽 1시.
    if (hour === 12) h = isEnd ? 24 : 0;
    else if (hour >= 6 && hour < 12) h = hour + 12;
    marker = h >= 12 ? 'pm' : 'am';
  }
  return { minutes: h * 60 + minute, hour, marker, clear: clear || marker !== null, nextDay };
}

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * 시작~끝을 읽는다. 끝이 시작보다 이르거나 24시를 넘으면 다음 날이다.
 * - "24시간" 은 00:00~00:00 다음 날.
 * - "오후 2시~6시" 는 끝도 오후로 읽는다.
 * - "9시~6시", "오전 10시~6시" 처럼 뜻이 둘인 표기는 못 읽은 것으로 둔다.
 */
export function normalizeHours(raw: string): NormalizeResult<Hours> {
  const full = plain(raw);
  const allDay = full.search(ALL_DAY) >= 0;
  const t = full.replace(ALL_DAY, ' ');
  if (allDay && !HAS_TIME.test(t)) return read({ open: '00:00', close: '00:00', nextDay: true });

  const parts = t.split(RANGE_SEP).filter((p) => HAS_TIME.test(p));
  if (parts.length !== 2 || !TIME_MARK.test(t)) return unread();
  const start = readSide(parts[0]!, false);
  const end = readSide(parts[1]!, true);
  if (!start || !end) return unread();
  if (start.minutes >= DAY) return unread();
  // "1시~5시"는 새벽인지 낮인지 알 수 없다(오전·오후 표시도, "01시" 같은 표기도 없을 때).
  if (!start.clear && !end.clear && start.hour >= 1 && start.hour <= 5) return unread();

  let endAt = end.minutes;
  if (!end.clear) {
    if (start.marker === 'pm') {
      // "오후 2시~6시" → 18시. "오후 6시~12시" → 자정. "오후 10시~2시" → 다음 날 2시.
      if (endAt + 12 * 60 > start.minutes) endAt += 12 * 60;
    } else if (endAt <= start.minutes) {
      // 오후 6시인지 다음 날 새벽 6시인지 알 수 없다.
      if (start.marker === 'am' || !start.clear) return unread();
    }
  }
  if (end.nextDay && endAt < DAY) endAt += DAY;
  else if (endAt <= start.minutes) endAt += DAY;
  if (endAt >= 2 * DAY) return unread();

  const hours: Hours = { open: hhmm(start.minutes), close: hhmm(endAt % DAY), nextDay: endAt >= DAY };
  // "24시간"이라 적고 다른 시간대를 함께 적었으면 어느 쪽인지 모른다.
  if (allDay && !(hours.open === hours.close && hours.nextDay)) return unread();
  return read(hours);
}
