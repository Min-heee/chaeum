// 규칙만으로 뽑기. LLM 없이 정규식으로 원문 표현(raw)과 근거 줄(evidence)을 찾는다.
// 값은 내지 않는다(value 는 전부 null). 값은 맞추기가 raw 를 읽어 만든다.
// 못 찾은 칸은 비워 둔다. 비슷해 보이는 것을 억지로 채우지 않는다.
import { FIELDS_BY_TYPE, type ExtractedField, type Extraction, type FieldKey, type ProductType } from '@/contract/fields';
import { PER_ANY } from '../normalize/footfall';
import { COUNTER_AFTER, WON_AFTER, WON_BEFORE } from '../normalize/money';
import { normalizePeriodOptions, normalizeQuantityOptions } from '../normalize/period';
import { findNumberChunks } from '../numbers';
import { guessSubtype, guessType } from './classify';

interface Span {
  start: number;
  end: number;
}
interface Hit {
  raw: string;
  evidence: string;
}
/** 줄의 한 자리(at)에서 값이 될 구간을 고른다. */
type Picker = (at: number) => Span | null;

// ── 값의 꼴 ────────────────────────────────────────────────

const N = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;
const LEN_UNIT = '(?:mm|cm|m|미터|센티|밀리)';
const SIDE_WORD = '(?:가로|세로|폭|높이|너비|W|H)';
const SIZE = new RegExp(
  String.raw`(?:${SIDE_WORD}\s?)?${N}\s?${LEN_UNIT}?\s?(?:[x×*]|by|,?\s?${SIDE_WORD})\s?(?:${SIDE_WORD}\s?)?${N}(?![\d.])(?:\s?${LEN_UNIT}(?![a-z]))?(?:\s?\(\s?(?:단위\s?[:：]?\s?)?${LEN_UNIT}\s?\))?(?!\s?(?:px|픽셀))`,
  'i',
);
const HEAD_UNIT = new RegExp(String.raw`\(\s?(?:단위\s?[:：]?\s?)?${LEN_UNIT}\s?\)`, 'i');
const RESOLUTION = /(?<![\d.])\d{3,5}\s?[x×*]\s?\d{3,5}(?![\d.])(?:\s?(?:px|픽셀|pixels?))?/i;

const MERIDIEM = String.raw`(?:오전|오후|새벽|밤|아침|저녁|낮|익일|다음\s?날)`;
const CLOCK = String.raw`\d{1,2}\s?시(?:\s?\d{1,2}\s?분|\s?반)?|\d{1,2}:\d{2}`;
const TIME_RANGE = new RegExp(
  String.raw`(?:${MERIDIEM}\s?)*(?:${CLOCK}|\d{1,2})\s?(?:~|-|–|〜|부터)\s?(?:${MERIDIEM}\s?)*(?:${CLOCK}|자정|정오)(?:\s?까지)?|24\s?시간(?!\s?(?:전|이내|이전))`,
);

const DURATION_NEAR = /(?:최소\s?)?(?:\d+\s?(?:영업일|주일|주|일|개월|달)|일주일|한\s?달|보름)(?:\s?(?:전|이전|이내|前))?(?:\s?까지)?/g;
const EXT = String.raw`\.?(?:jpe?g|png|gif|psd|ai|eps|pdf|mp4|mov|avi|wmv|tiff?)(?![a-z0-9])`;
const EXT_LIST = new RegExp(String.raw`(?<![a-z0-9])${EXT}(?:\s?(?:[,/·|]|및|또는|이나|나|or|and|和)?\s?${EXT})*`, 'i');
const PLAYS = /(?:(?:1일|하루|일일|일)\s?)?(?:약\s?|최소\s?)?(?!1\s?회)\d[\d,]*\s?회(?:\s?이상)?/;
// 뒤집는 말("포함되어 있지 않습니다", "포함 여부 문의")까지 잡는다. 앞만 자르면 뜻이 반대가 된다.
const VAT =
  /(?:부가세|부가가치세|vat|v\.a\.t\.?|세금|增值税)\s?(?:는|은|가|이)?\s?(?:별도|포함|미포함|불포함|제외)(?:[^\n,.()]{0,12}(?:않|아님|아닙|안\s?[됨되돼]|여부)[가-힣]*)?|(?:vat|tax)\s?(?:not\s+included|included|excluded|incl\.?|excl\.?)|\+\s?vat|不含税|含税/i;
/** 문장의 끝. 날짜 수와 글자 값은 문장을 넘어가 찾지 않는다. */
const SENTENCE_END = /[.!?](?=\s|$)|。/g;
/** 날짜 수 칸들의 이름표. 이름표와 기간 사이에 다른 칸의 이름표가 끼면 그 기간은 남의 것이다. */
const DAYS_LABELS = /예약|booking|预约|预订|환불|refund|退款|소재|artwork|素材|시안|디자인|도안|제작|납기/gi;

const PERIOD_KEY = String.raw`\d+\s?(?:주일|주간|주|일간|일|개월|달)|일주일|한\s?달|보름`;
const QUANTITY_KEY = String.raw`\d[\d,]*\s?(?:잔|인분|인|명|개|세트)`;

/** "역"으로 끝나지만 역 이름이 아닌 말. */
const NOT_STATION = /(?:지역|전역|권역)$/;
/** 상품 소개가 아닌 글에 흔한 말. */
const NOT_PRODUCT_CUE = /잔금|입금\s?(?:확인|부탁|요청|바랍니다)|세금\s?계산서|미수금|정산\s?(?:안내|요청)|휴무|연휴/;

// ── 뽑기 ───────────────────────────────────────────────────

class Reader {
  constructor(private readonly text: string) {}

  private lineStart(i: number): number {
    return this.text.lastIndexOf('\n', i - 1) + 1;
  }
  private lineEnd(i: number): number {
    const end = this.text.indexOf('\n', i);
    return end < 0 ? this.text.length : end;
  }
  private window(at: number): string {
    return this.text.slice(at, this.lineEnd(at));
  }

  /** 구간을 raw 로, 그 구간이 걸친 줄 전체를 근거로 낸다. */
  hit(span: Span): Hit | null {
    const raw = this.text.slice(span.start, span.end).trim();
    if (!raw) return null;
    return { raw, evidence: this.text.slice(this.lineStart(span.start), this.lineEnd(span.end)).trim() };
  }

  /**
   * 이름표(label) 뒤에서 값이 시작될 자리들.
   * strict: 글자 칸용. 이름표가 줄 머리에 있거나 뒤에 ":" 나 "은/는"이 올 때만 받는다
   * ("위치가 좋아서"의 "위치"를 이름표로 읽지 않으려고).
   */
  private *spots(label: RegExp, strict: boolean): Generator<number> {
    for (const m of this.text.matchAll(label)) {
      const end = m.index + m[0].length;
      const head = this.text.slice(this.lineStart(m.index), m.index);
      const tail = this.window(end);
      const sep = /^\s*[\]】>)」]?\s*(?:[:：=|\t]|[-–]\s|(?:은|는)\s)\s*/.exec(tail);
      const gap = /^\s*[\]】>)」]\s*|^\s+/.exec(tail);
      const atHead = /^[\s\-•·*■▶▷○●▪◆□☞✔#>[【<(「\d.)]*$/.test(head);
      if (strict && !sep && !(atHead && (gap || tail.trim() === ''))) continue;
      let at = end + ((sep ?? gap)?.[0].length ?? 0);
      // 이름표만 있는 줄이면 값은 다음 줄에 있다(표를 붙여 넣은 글).
      if (this.window(at).trim() === '') {
        const next = this.lineEnd(at) + 1;
        if (next >= this.text.length || this.window(next).trim() === '') continue;
        at = next;
      }
      yield at;
    }
  }

  labeled(label: RegExp, picker: Picker, strict = false): Hit | null {
    for (const at of this.spots(label, strict)) {
      const span = picker(at);
      const hit = span && this.hit(span);
      if (hit) return hit;
    }
    return null;
  }

  /** 꼴(re)에 맞는 첫 구간. 이름표에서 maxGap 글자 안에, 문장이 끝나기 전에 있어야 한다. */
  byPattern(re: RegExp, maxGap: number): Picker {
    return (at) => {
      const w = this.window(at);
      const m = re.exec(w);
      if (!m || m.index > maxGap || /[.!?。]\s/.test(w.slice(0, m.index))) return null;
      return { start: at + m.index, end: at + m.index + m[0].length };
    };
  }

  /** 글 전체에서 꼴에 맞는 첫 구간. */
  anywhere(re: RegExp, accept: (m: RegExpExecArray, after: string) => boolean = () => true): Hit | null {
    for (const m of this.text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
      if (accept(m, this.text.slice(m.index + m[0].length))) return this.hit({ start: m.index, end: m.index + m[0].length });
    }
    return null;
  }

  /** 금액으로 보이는 구간들. 단위 없는 숫자도 넣되 "1주", "10%" 같은 것은 뺀다. */
  moneySpans(at: number): (Span & { priced: boolean })[] {
    const low = this.window(at).toLowerCase();
    const out: (Span & { priced: boolean })[] = [];
    for (const c of findNumberChunks(low)) {
      const after = WON_AFTER.exec(low.slice(c.end));
      const before = WON_BEFORE.exec(low.slice(0, c.start));
      if (!after && !before && (COUNTER_AFTER.test(low.slice(c.end)) || /[a-z#]$/.test(low.slice(0, c.start)))) continue;
      out.push({
        start: at + c.start - (before?.[0].length ?? 0),
        end: at + c.end + (after?.[0].length ?? 0),
        priced: Boolean(after || before || c.hasUnit),
      });
    }
    return out;
  }

  /** 이름표 바로 뒤의 금액. 단위 없는 숫자는 이름표에 바짝 붙었을 때만 받는다. */
  money: Picker = (at) => {
    const first = this.moneySpans(at)[0];
    if (!first) return null;
    const gap = first.start - at;
    if (gap > (first.priced ? 14 : 6) || /[.!?。]\s/.test(this.text.slice(at, first.start))) return null;
    return first;
  };

  /** 글자 값: 구분 표시나 문장 끝까지. "입니다" 같은 끝말은 뗀다. */
  words: Picker = (at) => {
    const w = this.window(at);
    // 쉼표는 뒤에 다른 항목("크기는 …", "가격: …")이 이어질 때만 끝으로 본다. "서울, 경기 일부"는 한 값이다.
    const cut = /\t|\s[/|]\s|,\s(?=[^,]*(?:[:：]|[가-힣][은는]\s))|;|。|\.(?:\s|$)|\s{2,}/.exec(w);
    const body = (cut ? w.slice(0, cut.index) : w).replace(/(?:입니다|이에요|예요|이며|이고요?|이구요?|임)?[\s.!~]*$/, '');
    if (body.trim().length === 0 || body.length > 60) return null;
    // 값이 아니라 문장이 이어진 것("… 받지 않고 있어요")은 버린다.
    if (/(?:니다|어요|아요|해요|세요|네요|구요|고요|는데요?)$/.test(body)) return null;
    // "그 밖의 지역은 …" 의 "지역"은 이름표가 아니다.
    if (/(?:그\s?밖의|그\s?외|기타|다른|나머지|일부)\s*\S{0,6}$/.test(this.text.slice(this.lineStart(at), at).replace(/\s*(?:[:：=|]|[은는])\s*$/, ''))) return null;
    return { start: at, end: at + body.length };
  };

  /** 크기. 단위가 이름표 쪽에 적혔으면("크기(mm): 90x130") 그것까지 넣는다. */
  size: Picker = (at) => {
    const w = this.window(at);
    const m = SIZE.exec(w);
    if (!m || m.index > 25) return null;
    const head = new RegExp(LEN_UNIT, 'i').test(m[0].replace(/[x×*]/gi, ' ')) ? null : HEAD_UNIT.exec(w.slice(0, m.index));
    return { start: at + (head ? head.index : m.index), end: at + m.index + m[0].length };
  };

  /** 유동인구: 이름표 앞뒤의 "월", "일 평균" 같은 기준 말부터 수까지를 한 표현으로 잡는다. */
  footfall(): Hit | null {
    for (const m of this.text.matchAll(/유동\s?인구|통행량|통행\s?인구|이용객|승하차|footfall|traffic|人流量?|客流量?/gi)) {
      const at = m.index + m[0].length;
      const after = this.window(at).toLowerCase();
      const chunk = findNumberChunks(after).find((c) => {
        const rest = after.slice(c.end);
        if (/^\s?년/.test(rest)) return false;
        return c.hasUnit || /^\s?(?:명|人|people)/.test(rest) || (c.value ?? 0) >= 1000;
      });
      if (!chunk || chunk.start > 25) continue;
      const people = /^\s?(?:명|人)/.exec(after.slice(chunk.end));
      // 기준 말은 이름표 조금 앞에서부터 찾는다. 낱말 가운데를 자르지 않게 띄어쓰기에 맞춘다.
      let from = Math.max(this.lineStart(m.index), m.index - 12);
      if (from > this.lineStart(m.index)) from += this.text.slice(from, m.index).search(/\s|$/);
      const lead = this.text.slice(from, at + chunk.start).toLowerCase();
      const per = new RegExp(PER_ANY).exec(lead);
      return this.hit({
        start: per ? from + per.index : at + chunk.start,
        end: at + chunk.end + (people?.[0].length ?? 0),
      });
    }
    return null;
  }

  /**
   * 날짜 수: 이름표와 같은 문장에서 가까운 기간 표현. 이름표 뒤쪽을 먼저 보고, 없을 때만 앞쪽을 본다.
   * 뺀다: 범위("3~5일"), 값표의 기간("1주 150만원"), 사이에 다른 칸의 이름표가 낀 기간("예약은 10일 전, 소재는 3일 전").
   */
  daysNear(label: RegExp, must: RegExp | null = null): Hit | null {
    for (const m of this.text.matchAll(label)) {
      const ls = this.lineStart(m.index);
      const line = this.text.slice(ls, this.lineEnd(m.index));
      const labelStart = m.index - ls;
      const labelEnd = labelStart + m[0].length;
      // 이름표가 든 문장만 본다.
      let from = 0;
      let to = line.length;
      for (const e of line.matchAll(SENTENCE_END)) {
        if (e.index < labelStart) from = e.index + 1;
        else if (e.index >= labelEnd) {
          to = e.index;
          break;
        }
      }
      if (must && !must.test(line.slice(from, to))) continue;
      const own = (s: string) => s.replace(label, ' ');
      let best: { span: Span; distance: number; after: boolean } | null = null;
      for (const d of line.slice(from, to).matchAll(DURATION_NEAR)) {
        const start = from + d.index;
        const end = start + d[0].length;
        if (/[\d.~∼〜\-–]\s?$/.test(line.slice(0, start)) || /^\s?[:：]?\s?[\d₩~∼〜]/.test(line.slice(end))) continue;
        const after = start >= labelEnd;
        const gap = after ? line.slice(labelEnd, start) : line.slice(end, labelStart);
        if (gap.length > 30 || own(gap).search(DAYS_LABELS) >= 0) continue;
        const better = !best || (after && !best.after) || (after === best.after && gap.length < best.distance);
        if (better) best = { span: { start: ls + start, end: ls + end }, distance: gap.length, after };
      }
      const hit = best && this.hit(best.span);
      if (hit) return hit;
    }
    return null;
  }

  /** 값표: 기간(수량) 바로 뒤에 금액이 오는 짝을 모두 모은다. */
  optionPairs(keySource: string): Span[] {
    const re = new RegExp(String.raw`(?<![\d.,])(?:${keySource})\s?(?:기준|에|은|는)?\s?[:：=\-–→|\t]?\s?`, 'g');
    const pairs: Span[] = [];
    for (const m of this.text.matchAll(re)) {
      // 값표의 줄이 아닌 것: "추가 1인당 5천원"(낱개 값), "1~2주"(범위). "1잔당"은 금액이 바로 붙지 않아 아래에서 빠진다.
      if (/(?:추가|초과)\s?$|\d\s?[~∼〜\-–—]\s?$/.test(this.text.slice(Math.max(0, m.index - 8), m.index))) continue;
      const at = m.index + m[0].length;
      const amount = this.moneySpans(at)[0];
      if (amount && amount.start === at) pairs.push({ start: m.index, end: amount.end });
    }
    return pairs;
  }

  /** 짝들을 한 표현으로 묶는다. 근거는 첫 짝의 줄부터 마지막 짝의 줄까지(너무 길면 첫 줄만). */
  joinPairs(pairs: Span[]): Hit | null {
    const first = pairs[0];
    const last = pairs[pairs.length - 1];
    if (!first || !last) return null;
    const raw = pairs.map((p) => this.text.slice(p.start, p.end).trim()).join(' / ');
    const whole = this.text.slice(this.lineStart(first.start), this.lineEnd(last.end)).trim();
    const evidence = whole.length <= 300 ? whole : this.hit(first)!.evidence;
    return { raw, evidence };
  }

  /** 값표에서 열쇠가 가장 작은 줄의 금액(대표 판매가). */
  cheapestKeyAmount(pairs: Span[], keyOf: (raw: string) => number | null): Hit | null {
    let best: { span: Span; key: number } | null = null;
    for (const p of pairs) {
      const key = keyOf(this.text.slice(p.start, p.end));
      const amount = this.moneySpans(p.start).find((s) => s.end === p.end);
      if (key !== null && amount && (!best || key < best.key)) best = { span: amount, key };
    }
    return best && this.hit(best.span);
  }

  /** 이름: 이름표가 있으면 그 값, 없으면 꾸밈을 뗀 첫 줄(짧고 인사말이 아닐 때만). */
  name(): Hit | null {
    const labeled = this.labeled(/상품명|매체명|지면명|제품명|품명|상품\s?이름|매체|상품|제품|product\s?name|名称/gi, this.words, true);
    if (labeled) return labeled;
    const m = /\S[^\n]*/.exec(this.text);
    if (!m) return null;
    const lead = /^[\s[\]【】<>■▶★☆◆●○•·*#\-=~|"'“”「」]*/.exec(m[0])![0].length;
    const body = m[0].slice(lead).replace(/(?:\s*(?:상품\s?)?(?:안내|소개|공지|단가표|가격표|견적))?[\s[\]【】<>■★☆◆●○•·*#\-=~|"'“”「」.!]*$/, '');
    if (body.length < 2 || body.length > 40) return null;
    if (/[:：?？]|안녕|감사|문의|니다$|세요$|어요$|해요$/.test(body)) return null;
    return this.hit({ start: m.index + lead, end: m.index + lead + body.length });
  }
}

/** 종류별로 칸을 찾는다. 못 찾은 칸은 넣지 않는다. */
function findFields(type: ProductType, text: string): { hits: Partial<Record<FieldKey, Hit>>; specCount: number } {
  const r = new Reader(text);
  const hits: Partial<Record<FieldKey, Hit>> = {};
  const put = (key: FieldKey, hit: Hit | null) => {
    if (hit) hits[key] = hit;
  };
  let pairs: Span[] = [];
  let keyOf: (raw: string) => number | null = () => null;

  if (type === 'ad') {
    put('region', r.labeled(/위치|장소|주소|소재지|location|位置|地点/gi, r.words, true)
      ?? r.anywhere(/([가-힣A-Za-z0-9]{2,12}역)(?![가-힣])(?:\s?\d{1,2}번\s?출구)?/, (m) => !NOT_STATION.test(m[1]!)));
    put('size_m', r.labeled(/크기|사이즈|규격|size|尺寸/gi, r.size) ?? r.anywhere(SIZE, (m) => /m|미터|센티|밀리/i.test(m[0].replace(/[x×*]/gi, ' '))));
    put('resolution_px', r.labeled(/해상도|resolution|分辨率|픽셀/gi, r.byPattern(RESOLUTION, 20))
      ?? r.anywhere(RESOLUTION, (_, after) => !/^\s?(?:mm|cm|m|미터|센티|밀리)/i.test(after)));
    put('hours', r.labeled(/(?:운영|송출|가동|방영|점등|노출)\s?시간|operating\s?hours|运营时间|播放时间/gi, r.byPattern(TIME_RANGE, 30)) ?? r.anywhere(TIME_RANGE));
    put('spot_seconds', r.labeled(/1회|회당|구좌|(?:소재|송출|광고)\s?길이|초수|spot|时长/gi, r.byPattern(/\d+\s?(?:초|sec|秒)/i, 12)) ?? onlyOne(text, /\d+\s?초/g, r));
    put('plays_per_day', r.labeled(/(?:송출|노출)\s?횟수|송출|노출|播放次数/gi, r.byPattern(PLAYS, 20))
      ?? r.anywhere(/(?:1일|하루|일일|일)\s?(?:약\s?|최소\s?)?\d[\d,]*\s?회(?:\s?이상)?/));
    put('footfall_per_day', r.footfall());
    pairs = r.optionPairs(PERIOD_KEY);
    put('period_options', r.joinPairs(pairs));
    keyOf = (raw) => normalizePeriodOptions(raw).value?.[0]?.days ?? null;
    put('material_deadline_days', r.daysNear(/소재|artwork|素材/gi, /마감|접수|제출|전달|입고|전까지|deadline|截止/i));
    put('file_format', r.labeled(/(?:파일|소재)\s?(?:형식|포맷|확장자)|형식|포맷|확장자|format|格式/gi, r.byPattern(EXT_LIST, 20))
      ?? r.anywhere(EXT_LIST, (m) => /jpe?g|png|mp4|mov|pdf|psd/i.test(m[0])));
    put('refund_full_days', r.daysNear(/전액\s?환불|100\s?%\s?환불|full\s?refund|全额退款/gi));
    put('booking_deadline_days', r.daysNear(/예약(?!금)|신청\s?마감|booking|预约|预订/gi, /마감|전까지|전에|이전|최소|deadline|提前/i));
  } else if (type === 'catering') {
    put('service_region', r.labeled(/출장\s?(?:가능\s?)?지역|(?:서비스|가능|운영)\s?지역|지역|service\s?area|服务地区|服务范围/gi, r.words, true));
    pairs = r.optionPairs(QUANTITY_KEY);
    put('quantity_options', r.joinPairs(pairs));
    keyOf = (raw) => normalizeQuantityOptions(raw).value?.[0]?.qty ?? null;
    put('service_hours', r.labeled(/(?:운영|이용|서비스|진행|영업)\s?시간|operating\s?hours|运营时间/gi, r.byPattern(TIME_RANGE, 30)) ?? r.anywhere(TIME_RANGE));
    put('design_deadline_days', r.daysNear(/시안|디자인|도안|design|设计稿/gi, /마감|접수|전달|확정|제출|전까지|전에/));
  } else {
    put('size_mm', r.labeled(/크기|사이즈|규격|size|尺寸/gi, r.size) ?? r.anywhere(SIZE, (m) => /m|미터|센티|밀리/i.test(m[0].replace(/[x×*]/gi, ' '))));
    put('material', r.labeled(/재질|용지|원단|소재|material|材质/gi, r.words, true));
    put('lead_time_days', r.daysNear(/제작\s?(?:기간|소요|일정)|소요\s?기간|작업\s?기간|납기|제작|lead\s?time|制作周期|工期/gi, /기간|소요|납기|걸|이내|영업일|lead|周期|工期/i));
    put('min_order_qty', r.labeled(/최소\s?(?:주문|제작)?\s?수량|최소\s?주문|MOQ|minimum\s?order|起订量/gi, r.byPattern(/\d[\d,]*\s?(?:개|장|부|매|세트|ea|pcs|个)?(?:\s?(?:이상|부터))?/i, 12))
      ?? r.anywhere(/\d[\d,]*\s?(?:개|장|부|매|세트)\s?(?:이상|부터)(?=\s?(?:주문|제작))/));
  }
  const specCount = Object.keys(hits).filter((k) => !['region', 'service_region', 'material'].includes(k)).length;

  put('name', r.name());
  // 판매가: 뚜렷한 이름표 → 흔한 이름표 → 값표의 가장 짧은 기간(적은 수량) → 글에 금액이 하나뿐일 때 그것.
  put('price_krw',
    r.labeled(/판매가|할인가|특가|행사가|이벤트가|(?:할인|판매)\s?가격|sale\s?price|特价|优惠价/gi, r.money)
      ?? r.labeled(/(?<!정상\s?|기존\s?|원래\s?)(?:가격|금액|비용|단가|광고비|이용료|요금|price|价格|费用)/gi, r.money)
      ?? r.cheapestKeyAmount(pairs, keyOf)
      ?? onlyOne(text, /(?:₩\s?)?\d[\d,.]*\s?(?:[억만천]+\s?)?원/g, r));
  put('list_price_krw', r.labeled(/정가|정상가|정상\s?가격|기존가|기존\s?가격|원래\s?가격|소비자가|list\s?price|原价/gi, r.money));
  put('vat_included', r.anywhere(VAT));
  return { hits, specCount };
}

/** 꼴에 맞는 표현이 글 전체에 한 가지뿐일 때만 그것을 낸다. 둘 이상이면 어느 것인지 모른다. */
function onlyOne(text: string, re: RegExp, r: Reader): Hit | null {
  const found = [...text.matchAll(re)];
  if (new Set(found.map((m) => m[0].replace(/\s/g, ''))).size !== 1) return null;
  return r.hit({ start: found[0]!.index, end: found[0]!.index + found[0]![0].length });
}

/**
 * 정규식만으로 뽑는다.
 * 종류를 못 정하거나, 값·규격이 하나도 안 보이거나, 잔금 안내 같은 글이면 "등록 대상 아님"으로 낸다.
 */
export function rulesExtract(sourceText: string): Extraction {
  const notProduct: Extraction = { type: 'not_product', subtype: null, fields: [] };
  const type = guessType(sourceText);
  if (!type) return notProduct;

  const { hits, specCount } = findFields(type, sourceText);
  const found = specCount + (hits.price_krw ? 1 : 0);
  if (found === 0 || (NOT_PRODUCT_CUE.test(sourceText) && specCount < 3)) return notProduct;

  const fields: ExtractedField[] = [];
  for (const field of FIELDS_BY_TYPE[type]) {
    const hit = hits[field];
    if (hit) fields.push({ field, raw: hit.raw, value: null, evidence: hit.evidence });
  }
  return { type, subtype: guessSubtype(type, sourceText), fields };
}
