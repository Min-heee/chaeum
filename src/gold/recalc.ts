// 검산. 원문에 적을 표기(show)를 다시 읽어 표준 값으로 바꾼다.
// 정답을 만드는 쪽과 다른 길로 계산해서, 표기와 정답 값이 어긋나면 시험이 잡는다.
// 맞추기 코어(src/core)와는 따로 둔 작은 함수다. 정답 도구만 쓴다.
import { fieldDef, type FieldValue, type Hours } from '@/contract/fields';
import type { SurfaceHint } from './spec';

const pad = (n: number) => String(n).padStart(2, '0');

/** "1,500,000" "150만" "3,000만" "1.2억" 같은 수를 읽는다. */
export function readNumber(text: string): number {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*(억|만|천)?/.exec(text);
  if (!m) throw new Error(`수를 못 읽음: ${text}`);
  const n = Number((m[1] as string).replace(/,/g, ''));
  const unit = m[2] === '억' ? 100_000_000 : m[2] === '만' ? 10_000 : m[2] === '천' ? 1_000 : 1;
  return Math.round(n * unit);
}

/** 금액. bare 는 만원 단위 숫자만 적은 꼴("150")이다. */
export function readMoney(show: string, form: string): number {
  const n = readNumber(show);
  return form === 'money:bare' ? n * 10_000 : n;
}

/** "7일" "2주" "1개월" "한 달" → 일수 */
export function readDays(show: string): number {
  if (/한\s*달/.test(show)) return 30;
  const m = /(\d+)\s*(일|주일|주|개월)/.exec(show);
  if (!m) throw new Error(`기간을 못 읽음: ${show}`);
  const n = Number(m[1]);
  if (m[2] === '일') return n;
  if (m[2] === '개월') return n * 30;
  return n * 7;
}

/** "05시~25시" "06:00~24:00" "오전 10시~오후 2시" "24시간" → 시작·끝·다음 날 여부 */
export function readHours(show: string): Hours {
  if (/24\s*시간/.test(show)) return { open: '00:00', close: '00:00', nextDay: true };
  const m = /(오전|오후)?\s*(\d{1,2})(?::(\d{2}))?\s*시?\s*[~\-–]\s*(오전|오후)?\s*(\d{1,2})(?::(\d{2}))?\s*시?/.exec(show);
  if (!m) throw new Error(`시간을 못 읽음: ${show}`);
  const hour = (ampm: string | undefined, h: string) => {
    let n = Number(h);
    if (ampm === '오후' && n < 12) n += 12;
    if (ampm === '오전' && n === 12) n = 0;
    return n;
  };
  const openH = hour(m[1], m[2] as string);
  const openM = Number(m[3] ?? 0);
  let closeH = hour(m[4], m[5] as string);
  const closeM = Number(m[6] ?? 0);
  let nextDay = false;
  if (closeH >= 24) {
    closeH -= 24;
    nextDay = true;
  } else if (closeH * 60 + closeM <= openH * 60 + openM) {
    nextDay = true;
  }
  return { open: `${pad(openH)}:${pad(openM)}`, close: `${pad(closeH)}:${pad(closeM)}`, nextDay };
}

/** "월 250만 명" → 하루 값. 월은 30, 주는 7, 연은 365 로 나눠 반올림한다. */
export function readFootfall(show: string): number {
  const n = readNumber(show);
  const head = show.trim();
  if (/^(월|한\s*달)/.test(head)) return Math.round(n / 30);
  if (/^주/.test(head)) return Math.round(n / 7);
  if (/^연/.test(head)) return Math.round(n / 365);
  return n;
}

/** 크기 표기에서 수 둘과 단위를 읽는다. */
function readPair(show: string): { a: number; b: number; unit: string } {
  const nums = [...show.matchAll(/\d+(?:\.\d+)?/g)].map((x) => Number(x[0]));
  const unit = /mm/i.test(show) ? 'mm' : /cm/i.test(show) ? 'cm' : /px/i.test(show) ? 'px' : /m/i.test(show) ? 'm' : '';
  if (nums.length !== 2) throw new Error(`수 둘을 못 읽음: ${show}`);
  return { a: nums[0] as number, b: nums[1] as number, unit };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 옵션 목록. "1주 150만원 / 2주 280만원" */
function readOptions(show: string, form: string, key: 'days' | 'qty') {
  return show.split(' / ').map((part) => {
    const i = part.lastIndexOf(' ');
    const head = part.slice(0, i);
    const money = readMoney(part.slice(i + 1), form);
    return key === 'days' ? { days: readDays(head), price_krw: money } : { qty: readNumber(head), price_krw: money };
  });
}

/** 표기 하나를 표준 값으로. */
export function recalc(hint: SurfaceHint): FieldValue {
  const kind = fieldDef(hint.field).kind;
  switch (kind) {
    case 'text':
      return hint.show;
    case 'money':
      return readMoney(hint.show, hint.form);
    case 'bool':
      if (/포함/.test(hint.show)) return true;
      if (/별도/.test(hint.show)) return false;
      throw new Error(`부가세 표기를 못 읽음: ${hint.show}`);
    case 'count':
      return readNumber(hint.show);
    case 'days':
      return readDays(hint.show);
    case 'footfall':
      return readFootfall(hint.show);
    case 'size_m': {
      const { a, b, unit } = readPair(hint.show);
      const div = unit === 'mm' ? 1000 : unit === 'cm' ? 100 : 1;
      return { width: round2(a / div), height: round2(b / div) };
    }
    case 'size_mm': {
      const { a, b, unit } = readPair(hint.show);
      const mul = unit === 'cm' ? 10 : unit === 'm' ? 1000 : 1;
      return { width: Math.round(a * mul), height: Math.round(b * mul) };
    }
    case 'resolution': {
      const { a, b } = readPair(hint.show);
      return { width: a, height: b };
    }
    case 'hours':
      return readHours(hint.show);
    case 'period_options':
      return readOptions(hint.show, hint.form, 'days') as FieldValue;
    case 'quantity_options':
      return readOptions(hint.show, hint.form, 'qty') as FieldValue;
    case 'formats':
      return hint.show
        .split(/[,/\s]+/)
        .map((x) => x.replace(/^\./, '').toLowerCase())
        .filter(Boolean)
        .sort();
  }
}
