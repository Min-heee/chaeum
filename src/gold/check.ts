// 조립된 정답 문서를 기계로 검산한다. 정답은 고치지 않는다. 걸린 것만 알린다.
// 표기 꼴의 이름을 보지 않는다. 설계도의 조각(tokens)이 원문에 있는지, 그 조각을 글자로 되읽은 값이 정답과 같은지,
// 조각을 지우고 남은 글에 값의 낌새(금액·시간·크기·기간)가 있는지를 본다.
// 맞추기 코어(src/core)와는 따로 둔다. 정답 도구만 쓴다.
import type { GoldDoc } from '@/contract/eval-types';
import { fieldDef, type FieldKey } from '@/contract/fields';
import { AD_REGIONS } from './catalog';
import { canon } from './files';
import { recalc } from './recalc';
import type { GoldSpec, SurfaceHint } from './spec';

export interface Finding {
  /** hard: 정답과 원문이 어긋날 수 있다. soft: 기계가 확신하지 못한다. */
  level: 'hard' | 'soft';
  kind: string;
  text: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** 표기가 더 큰 수의 한 토막이 아닌 자리만 찾는다. "7일"이 "17일" 안에 있으면 세지 않는다. */
export function cleanIndexes(text: string, token: string): number[] {
  const out: number[] = [];
  if (token === '') return out;
  const startsNum = /^[0-9]/.test(token);
  const endsNum = /[0-9]$/.test(token);
  for (let i = text.indexOf(token); i >= 0; i = text.indexOf(token, i + 1)) {
    const b1 = text[i - 1];
    const b2 = text[i - 2];
    const a1 = text[i + token.length];
    const a2 = text[i + token.length + 1];
    if (startsNum && (isDigit(b1) || (b1 === '.' && isDigit(b2)) || (b1 === ',' && isDigit(b2) && /^\d{3}(\D|$)/.test(token)))) continue;
    if (endsNum && (isDigit(a1) || ((a1 === '.' || a1 === ',') && isDigit(a2) && isDigit(text[i + token.length + 2]) && isDigit(text[i + token.length + 3])))) continue;
    if (endsNum && a1 === '.' && isDigit(a2)) continue;
    if (/[0-9]m$/.test(token) && a1 === 'm') continue;
    out.push(i);
  }
  return out;
}

const sentences = (t: string) =>
  t
    .split(/\n+|(?<=[.!?。！？])(?=\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

const snip = (text: string, at: number, len: number) => {
  const from = Math.max(0, at - 14);
  const to = Math.min(text.length, at + len + 14);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ')}${to < text.length ? '…' : ''}`;
};

// ── 값의 낌새를 찾는 틀 ─────────────────────────────────────

const DUR = /\d+\s*(?:영업일|일|주일|주|개월|달|天|日|周|个月|個月|business days?|days?|weeks?|months?)|한\s*달|보름|D\s*-\s*\d+|\d+\s*시간\s*전|[一二两三四五六七八九十]+\s*(?:天|周|个月)/i;
const TIME_RANGE =
  /(?:오전|오후|새벽|아침|저녁|밤|上午|下午|凌晨|早上|晚上)?\s*\d{1,2}\s*(?:시(?:\s*\d{1,2}\s*분)?|:\d{2}|点|時|\s*[ap]m)\s*(?:부터|에서|~|〜|∼|-|–|—|至|到|\bto\b|until)\s*(?:익일|다음\s*날|새벽|오전|오후|저녁|밤|次日|翌日|凌晨|下午|晚上)?\s*\d{1,2}\s*(?:시|:\d{2}|点|時|\s*[ap]m)|24\s*시간|24\s*小时|24\s*hours?|24\s*hrs?\b|24\s*H\b|24\/7|全天|종일\s*(?:운영|송출)/gi;
const MONEY =
  /(?:₩|￦|KRW|RMB|USD|US\$|\$|¥)\s*(\d[\d,]*(?:\.\d+)?)()|(\d[\d,]*(?:\.\d+)?)\s*(억\s*원?|만\s*원|천\s*원|원(?![가-힣]*단)(?![가-힣])|万\s*(?:韩元|韩币|韓元|won|KRW)?|韩元|韩币|韓元|KRW|won\b|元|만(?=\s*(?:[^가-힣\s]|$|\n|이고|입니다|이에요|이며|에)))/gi;
const DIM_UNIT = /\d+(?:\.\d+)?\s*(?:mm|cm|㎜|㎝|m(?![a-zA-Z0-9²])|미터|센티|밀리|米|厘米|毫米)/gi;
const DIM_PAIR = /\d+(?:\.\d+)?\s*(?:mm|cm|m)?\s*[x×*X✕]\s*\d+(?:\.\d+)?/g;
const RES_PAIR = /\d{3,4}\s*[x×*X✕]\s*\d{3,4}/g;
const FILE_EXT = /(?<![A-Za-z0-9])\.?(?:mp4|mov|avi|wmv|jpe?g|png|gif|pdf|psd|eps|tiff?)(?![A-Za-z0-9])|\.ai(?![A-Za-z0-9])|(?<![A-Za-z0-9])(?:ai|AI)\s*(?:파일|형식|포맷|원본)|일러스트(?:레이터)?\s*(?:파일|원본)/gi;
const ALL_REGIONS = [...new Set(Object.values(AD_REGIONS).flat())] as string[];

function moneyValue(num: string, unit: string): number {
  const n = Number(num.replace(/,/g, ''));
  if (/억/.test(unit)) return Math.round(n * 100_000_000);
  if (/만|万/.test(unit)) return Math.round(n * 10_000);
  if (/천/.test(unit)) return Math.round(n * 1_000);
  return Math.round(n);
}

/** 칸을 부르는 말(대표 낱말). */
const WORDS: Partial<Record<FieldKey, RegExp>> = {
  list_price_krw: /정가|정상가|원래\s*(?:값|가격|금액)|할인\s*전|기존\s*(?:가|가격|금액)|原价|原價|定价|list price|original price|regular price|usual price/i,
  vat_included: /부가세|부가가치세|V\.?A\.?T|含税|不含税|增值税|税费|세금(?!계산서)|\btax(?!\s*invoice)/i,
  region: /위치|소재지|주소|입지|地址|位置|地点|\blocation\b|\blocated\b/i,
  size_m: /크기|사이즈|규격|가로|세로|화면\s*면적|尺寸|大小|\bsize\b|dimension/i,
  resolution_px: /해상도|픽셀|\bpx\b|分辨率|像素|resolution|pixel/i,
  hours: /운영\s*시간|송출\s*시간|가동\s*시간|방영\s*시간|점등|营业时间|运营时间|播放时间|operating hours|hours of operation|on-?air/i,
  spot_seconds: /초수|길이|秒数|时长|长度|duration|spot length|\bspot\b/i,
  plays_per_day: /송출\s*횟수|노출\s*횟수|재생\s*횟수|송출\s*수|횟수|播放次数|次数|plays per day|rotation/i,
  footfall_per_day: /유동\s*인구|유동량|통행량|통행\s*인구|이용객|승하차|人流|客流|流动人口|footfall|foot traffic|\btraffic\b|passers?-?by|pedestrian/i,
  material_deadline_days: /소재|원고|영상\s*(?:제출|마감|접수)|파일\s*(?:제출|마감|접수)|데이터\s*(?:제출|마감|접수)|주셔야|보내\s*주|素材|物料|\bmaterials?\b|artwork|creative/i,
  file_format: /파일\s*형식|확장자|포맷|파일\s*규격|格式|file format|file type|\bformat\b/i,
  refund_full_days: /환불|취소|위약|해지|退款|取消|违约|refund|cancel/i,
  booking_deadline_days: /예약|신청|부킹|청약|접수|预订|预约|\bbook|reserv/i,
  service_region: /출장|방문\s*(?:지역|가능)|지역|服务(?:地区|范围)|配送范围|地区|service area|coverage/i,
  service_hours: /운영\s*시간|이용\s*시간|서비스\s*시간|영업\s*시간|머무|체류|服务时间|营业时间|service hours|on-?site/i,
  design_deadline_days: /시안|도안|디자인|문구|设计|稿|\bdesign\b|artwork|draft/i,
  size_mm: /크기|사이즈|규격|치수|가로|세로|尺寸|大小|\bsize\b|dimension/i,
  material: /재질|소재|용지|원단|材质|面料|纸张|\bmaterial\b/i,
  lead_time_days: /제작|작업|납기|출고|배송|발송|소요|만드는|걸리|制作|生产|工期|交期|交货|发货|lead time|production|turnaround|deliver|\bship/i,
  min_order_qty: /최소|최저|MOQ|起订|最低|最少|minimum|min\.?\s*order|at least/i,
  price_krw: /가격|금액|단가|비용|요금|광고료|게재료|견적|값|价格|费用|报价|\bprice\b|\brate\b|\bcost\b/i,
  period_options: /기간|期间|period/i,
  quantity_options: /수량|数量|quantity/i,
};

/** 값 없이 칸 이름만 나온 것을 알릴 때 쓰는 좁은 목록. 여기 없는 칸은 WORDS 를 그대로 쓴다. */
const MENTION: Partial<Record<FieldKey, RegExp>> = {
  material_deadline_days: /소재\s*(?:마감|접수\s*마감|제출\s*기한)|원고\s*마감|素材截止|material deadline/i,
  lead_time_days: /제작\s*기간|제작\s*소요|납기|制作周期|交货期|lead time/i,
  booking_deadline_days: /예약\s*마감|신청\s*마감|预订截止|booking deadline/i,
  design_deadline_days: /시안/i,
  service_region: /출장\s*(?:지역|가능|범위)|방문\s*지역|服务(?:地区|范围)|service area/i,
  spot_seconds: /초수|(?:소재|영상|광고)\s*길이|秒数|时长|spot length/i,
  size_m: /크기|사이즈|규격|尺寸|\bsize\b/i,
  size_mm: /크기|사이즈|규격|치수|尺寸|\bsize\b/i,
};

const SERVICE_REGION_VALUE = /서울|경기|인천|부산|대구|대전|광주|울산|세종|제주|강원|충청|전라|경상|수도권|전국|강남권|首尔|京畿|仁川|釜山|全国|首都圈|Seoul|Gyeonggi|Incheon|Busan|nationwide|metropolitan/i;
const MATERIAL_VALUE = /아크릴|원단|극세사|스웨이드|유포지|스노우지|아트지|모조지|크라프트|주석|알루미늄|캔버스|면\s*100|코팅지|PVC|\bPET\b|스테인리스|실리콘|\d+\s*g(?![a-zA-Z])|\d\s*T(?![a-zA-Z])|亚克力|铜版纸|帆布|马口铁|acrylic|canvas|cotton|aluminum/i;
const VAT_IN = /포함|\bincluded\b|inclusive|含税|已含/i;
const VAT_OUT = /별도|미포함|불포함|제외|excluded|exclusive|not included|不含|另计|另付|未含/i;

const DEADLINE_FIELDS: readonly FieldKey[] = ['material_deadline_days', 'refund_full_days', 'booking_deadline_days', 'design_deadline_days'];
const DEADLINE_DUR = new RegExp(`(?:${DUR.source})\\s*(?:전|이전|前|之前|以前|여유|before|prior|in advance|ahead)|提前\\s*\\d+\\s*(?:天|日|周)|D\\s*-\\s*\\d+`, 'i');
const clauses = (t: string) =>
  sentences(t)
    .flatMap((x) => x.split(/(?<!\d),|,(?!\d)|[，、;；]|\s및\s|\s그리고\s/))
    .map((x) => x.trim())
    .filter(Boolean);

/** 마감 칸의 알맹이 낱말. */
const DEADLINE_CORE: Partial<Record<FieldKey, RegExp>> = {
  material_deadline_days: /소재|원고|영상\s*(?:제출|마감|접수)|파일\s*(?:제출|마감|접수)|素材|物料|artwork|creative/i,
  refund_full_days: /환불|취소|위약|退款|取消|refund|cancel/i,
  booking_deadline_days: /예약|신청|부킹|预订|预约|\bbook|reserv/i,
  design_deadline_days: /시안|도안|设计稿|\bdesign\b/i,
};

/**
 * 마감 칸("며칠 전까지")은 다른 칸과 같은 표기("7일")를 쓰기 쉽다. 표기를 지운 글로는 못 잡으므로 원문의 구절로 한 번 더 본다.
 * 칸을 부르는 말과 "며칠 전"이 한 구절에 있으면 값이 샌 것이다. 값이 있는 다른 마감 칸의 말과 표기가 함께 있으면 확신하지 못한다.
 */
function deadlineLeak(field: FieldKey, plain: string, hints: readonly SurfaceHint[]): { hard: string[]; unsure: string[] } {
  const hard: string[] = [];
  const unsure: string[] = [];
  const words = DEADLINE_CORE[field] as RegExp;
  for (const c of clauses(plain)) {
    if (!words.test(c) || !DEADLINE_DUR.test(c)) continue;
    const explained = hints.filter((h) => (DEADLINE_FIELDS.includes(h.field) || h.field === 'lead_time_days') && h.tokens.some((t) => cleanIndexes(c, t).length > 0));
    if (explained.length === 0) hard.push(c.slice(0, 60));
    else unsure.push(`${c.slice(0, 50)} (값이 있는 칸 "${explained.map((h) => h.label).join(', ')}"와 한 구절)`);
  }
  return { hard, unsure };
}

function leak(field: FieldKey, rest: string, restSentences: string[], plain: string, hints: readonly SurfaceHint[]): { hard: string[]; mention: string[]; unsure: string[] } {
  const hard: string[] = [];
  const mention: string[] = [];
  const unsure: string[] = [];
  if (DEADLINE_FIELDS.includes(field)) {
    const d = deadlineLeak(field, plain, hints);
    hard.push(...d.hard);
    unsure.push(...d.unsure);
  }
  const words = WORDS[field];
  const withWord = words ? restSentences.filter((s) => words.test(s)) : [];
  const all = (re: RegExp) => [...rest.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))].map((m) => snip(rest, m.index ?? 0, m[0].length));
  const inWord = (re: RegExp) => withWord.filter((s) => re.test(s)).map((s) => s.slice(0, 60));

  switch (field) {
    case 'list_price_krw':
      hard.push(...inWord(/\d/));
      break;
    case 'vat_included':
      hard.push(
        ...withWord
          .map((s) => s.replace(/(?:포함|별도)\s*(?:여부|인지)|是否含税/g, ''))
          .filter((s) => VAT_IN.test(s) || VAT_OUT.test(s))
          .map((s) => s.slice(0, 60)),
      );
      break;
    case 'region':
      hard.push(...ALL_REGIONS.filter((r) => rest.includes(r)).map((r) => `지명 "${r}"`));
      hard.push(...all(/(?<![가-힣])[가-힣]{2,6}역(?![가-힣])\s*\d*\s*번?\s*출구/g));
      break;
    case 'size_m':
    case 'size_mm':
      hard.push(...all(DIM_UNIT), ...all(DIM_PAIR));
      if (field === 'size_mm') hard.push(...all(/(?<![A-Za-z0-9])[AB][3-6](?![A-Za-z0-9])/g));
      break;
    case 'resolution_px':
      hard.push(...all(RES_PAIR), ...inWord(/\d{3,4}/));
      break;
    case 'hours':
    case 'service_hours':
      hard.push(...all(TIME_RANGE));
      break;
    case 'spot_seconds':
      hard.push(...all(/\d+\s*(?:초(?!과)|秒|sec(?:ond)?s?\b)/gi));
      break;
    case 'plays_per_day':
      hard.push(...all(/\d[\d,]*\s*(?:회(?!사|의|차)|次|times\b|plays\b|spots\b)/gi));
      break;
    case 'footfall_per_day':
      hard.push(...inWord(/\d/));
      break;
    case 'period_options':
    case 'quantity_options':
    case 'price_krw':
      // 금액은 문서 전체에서 따로 본다.
      break;
    case 'file_format':
      hard.push(...all(FILE_EXT));
      break;
    case 'service_region':
      hard.push(...all(SERVICE_REGION_VALUE));
      break;
    case 'material':
      hard.push(...all(MATERIAL_VALUE));
      break;
    case 'min_order_qty':
      hard.push(...inWord(/\d/), ...all(/\d+\s*(?:개|장|세트|부|매|个|张|套|份|pcs|ea)\s*(?:이상|부터|起|以上)/gi));
      break;
    case 'refund_full_days':
      hard.push(...withWord.filter((s) => DUR.test(s) || /\d+\s*%/.test(s)).map((s) => s.slice(0, 60)));
      break;
    default:
      // 일수 칸: 칸을 부르는 말과 기간이 한 문장에 있으면 값이 샌 것으로 본다.
      hard.push(...inWord(DUR));
  }
  const narrow = MENTION[field] ?? words;
  if (hard.length === 0 && narrow) mention.push(...restSentences.filter((s) => narrow.test(s)).map((s) => s.slice(0, 40)));
  return { hard: [...new Set(hard)], mention: [...new Set(mention)], unsure: [...new Set(unsure)] };
}

/** 수 옆에 단위를 붙이지 않는 꼴에서, 그 단위를 글 다른 곳에 밝힌 자리를 찾는 틀. */
function unitDeclared(unit: string): RegExp {
  switch (unit) {
    case '만원':
      return /만\s*원|万\s*(?:韩元|won|KRW)|10,?000\s*(?:KRW|won)/i;
    case '천원':
      return /천\s*원|千\s*(?:韩元|won|KRW)|1,?000\s*(?:KRW|won)|thousand/i;
    case 'mm':
      return /mm|㎜|밀리|毫米/i;
    case 'cm':
      return /cm|㎝|센티|厘米/i;
    case 'm':
      return /[(（\[［]\s*(?:단위\s*[:：]?\s*)?m\s*[)）\]］]|단위\s*[:：]?\s*m(?![a-z])|\bm\s*(?:단위|기준)|미터|\bmeters?\b|米/i;
    default:
      return new RegExp(unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

/** 수 바로 뒤에 붙으면 안 되는 단위. */
function unitGlued(unit: string): RegExp {
  switch (unit) {
    case '만원':
    case '천원':
      return /^\s*(?:만|원|천|万|千|KRW|won)/i;
    case 'mm':
    case 'cm':
    case 'm':
      return /^\s*(?:mm|cm|m(?![a-z])|㎜|㎝|밀리|센티|미터|米)/i;
    default:
      return /^$/;
  }
}

// ── 문서 한 건 ──────────────────────────────────────────────

export function checkDoc(spec: GoldSpec, doc: GoldDoc): Finding[] {
  const out: Finding[] = [];
  const hard = (kind: string, text: string) => out.push({ level: 'hard', kind, text });
  const soft = (kind: string, text: string) => out.push({ level: 'soft', kind, text });
  const content = doc.content;
  const length = [...content].length;

  // 가. 조립이 정답을 바꾸지 않았는가
  if (doc.truth.type !== spec.type || doc.truth.subtype !== spec.subtype) hard('정답', '종류·갈래가 설계도와 다르다');
  if (!same(doc.truth.fields, spec.truth)) hard('정답', '칸 값이 설계도와 다르다');
  if (length < 100 || length > 900) hard('길이', `${length}자`);
  for (const s of spec.must_include) if (!content.includes(s)) hard('지시문', '넣기로 한 문장이 없다');

  // 꼴
  const han = (content.match(/\p{Script=Han}/gu) ?? []).length;
  const latin = (content.match(/[A-Za-z]{3,}/g) ?? []).length;
  const lines = content.split('\n').filter((l) => l.trim() !== '');
  if (spec.style === 'mixed_lang' && (han < 10 || latin < 5)) soft('꼴', `중국어·영어가 섞인 글인데 한자 ${han}자, 영어 낱말 ${latin}개`);
  if (spec.style === 'long_mixed' && length < 600) soft('꼴', `긴 글인데 ${length}자(600자보다 짧다)`);
  if (spec.style === 'table' && lines.filter((l) => /[\t|:：/]/.test(l)).length < 3) soft('꼴', '표 꼴인데 칸을 나눈 줄이 셋보다 적다');
  if (spec.style === 'messenger' && lines.length < 4) soft('꼴', `메신저 말투인데 줄이 ${lines.length}개`);

  // 양식의 칸 이름을 그대로 베낀 글은 뽑기가 너무 쉬워진다
  const copied = ['한 번 길이', '하루 송출 횟수', '기간 옵션', '수량 옵션', '소재 파일 형식', '최소 주문 수량', '상품 이름', '하루 유동인구'].filter((l) => content.includes(l));
  if (copied.length >= 2) soft('칸 이름 베낌', `양식의 칸 이름을 그대로 쓴 곳이 ${copied.length}개: ${copied.join(', ')}`);

  // 가짜임이 분명하지 않은 연락처
  for (const m of content.matchAll(/\b0\d{1,2}[-.\s]\d{3,4}[-.\s]\d{4}\b/g)) if (!/0000|000[-.\s]/.test(m[0])) soft('연락처', `전화번호 꼴 "${m[0]}"`);
  for (const m of content.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)) if (!/^example\./i.test(m[1] as string)) soft('연락처', `메일 주소 꼴 "${m[0]}"`);
  for (const m of content.matchAll(/(?:https?:\/\/|www\.)[^\s)]+/g)) if (!/example/i.test(m[0])) soft('연락처', `주소 꼴 "${m[0].slice(0, 40)}"`);

  if (spec.type === 'not_product') {
    // 상품 글이 아닌 글에 금액·규격이 있어도 정답에는 영향이 없다. 값은 보지 않는다.
    return out;
  }

  // 나. 조각이 원문에 있는가, 다시 읽으면 정답이 되는가
  const need = new Map<string, { count: number; labels: Set<string> }>();
  const optionHints = spec.surface_hints.filter((h) => h.field === 'period_options' || h.field === 'quantity_options');
  const inOption = (t: string) => optionHints.some((h) => h.tokens.some((x) => x.includes(t)));
  for (const h of spec.surface_hints) {
    const kind = fieldDef(h.field).kind;
    let value: unknown;
    try {
      value = recalc(h);
    } catch (err) {
      hard('검산', `${h.label}: 본보기 표기를 다시 읽지 못함(${(err as Error).message.slice(0, 40)})`);
      continue;
    }
    if (!same(value, spec.truth[h.field])) hard('검산', `${h.label}: 본보기 표기를 다시 읽은 값이 정답과 다르다`);
    // 원문에 실제로 들어간 것은 조각이다. 조각만 이어서 한 번 더 읽는다.
    if (kind !== 'text' && h.tokens.length > 0) {
      try {
        const written = recalc({ ...h, show: h.tokens.join(kind === 'period_options' || kind === 'quantity_options' ? '\n' : ' ') });
        if (!same(written, spec.truth[h.field])) hard('검산', `${h.label}: 원문의 조각을 다시 읽은 값이 정답과 다르다`);
      } catch (err) {
        hard('검산', `${h.label}: 원문의 조각을 다시 읽지 못함(${(err as Error).message.slice(0, 40)})`);
      }
    }
    for (const t of h.tokens) {
      if (!content.includes(t)) {
        hard('표기 없음', `${h.label}: "${t}"`);
        continue;
      }
      // 판매가는 가장 짧은 옵션의 값과 같은 표기다. 값표 안에 한 번만 나와도 된다.
      if (h.field === 'price_krw' && inOption(t)) continue;
      const n = need.get(t) ?? { count: 0, labels: new Set<string>() };
      n.count += 1;
      n.labels.add(h.label);
      need.set(t, n);
    }
  }
  for (const [t, n] of need) {
    const found = cleanIndexes(content, t).length;
    if (found === 0) hard('표기가 다른 수의 토막', `"${t}"(${[...n.labels].join(', ')})가 더 큰 수의 일부로만 나온다`);
    else if (found < n.count) hard('표기 겹침', `"${t}"를 ${n.count}곳(${[...n.labels].join(', ')})이 쓰는데 원문에는 ${found}번만 나온다`);
  }

  // 정답의 조각을 지운 글. 남은 수·기간·시간은 정답에 없는 값이다.
  let rest = content;
  for (const s of spec.must_include) rest = rest.split(s).join(' ');
  const blank = [...new Set(spec.surface_hints.flatMap((h) => [h.show, ...h.tokens]))].sort((a, b) => b.length - a.length);
  for (const t of blank) {
    for (const i of cleanIndexes(rest, t).reverse()) rest = `${rest.slice(0, i)}${'□'.repeat(t.length)}${rest.slice(i + t.length)}`;
  }
  const restSentences = sentences(rest);
  const fullSentences = sentences(content);
  let plain = content;
  for (const x of [...spec.must_include, String(spec.truth.name ?? '')]) if (x) plain = plain.split(x).join(' ');

  // 다. 조각의 단위와 짝. 꼴 이름을 보지 않는다.
  for (const h of spec.surface_hints) {
    const first = h.tokens[0] as string;
    const kind = fieldDef(h.field).kind;
    const own = WORDS[h.field];

    if (h.unit) {
      // 수 옆에 단위를 붙이지 않기로 한 조각
      const glued = unitGlued(h.unit);
      for (const t of new Set(h.tokens)) {
        const idx = cleanIndexes(content, t);
        if (idx.length > 0 && idx.every((i) => glued.test(content.slice(i + t.length, i + t.length + 6)))) hard('단위', `${h.label}: 단위를 붙이지 않기로 한 "${t}" 바로 뒤에 단위가 붙었다`);
      }
      const declared = unitDeclared(h.unit).test(rest);
      if (h.declare_unit === true && !declared) hard('단위', `${h.label}: 단위(${h.unit})를 글 다른 곳에 밝히기로 했는데 못 찾음`);
      if (h.declare_unit === false && declared && (kind === 'money' || kind === 'period_options' || kind === 'quantity_options')) soft('단위', `${h.label}: 단위(${h.unit})를 밝히지 않기로 했는데 글에 그 단위 말이 있다`);
    }

    if (h.tokens.length >= 2) {
      // 조각이 여럿이면 적힌 차례가 본보기와 같아야 짝이 맞는다
      const at = h.tokens.map((t) => cleanIndexes(content, t)[0] ?? content.indexOf(t));
      if (!at.every((x, i) => x >= 0 && (i === 0 || x > (at[i - 1] as number)))) soft('짝', `${h.label}: 조각 ${h.tokens.length}개가 본보기와 같은 차례로 있는지 기계로 못 찾음`);
    }

    if (kind === 'days' && own) {
      // 마침표로 끊긴 짧은 문장("소재 전달. 게재 3일 전 마감")도 있어서 문장과 앞쪽 40자 창을 함께 본다.
      const withToken = [...fullSentences.filter((s) => cleanIndexes(s, first).length > 0), ...cleanIndexes(content, first).map((i) => content.slice(Math.max(0, i - 40), i + first.length))];
      if (!withToken.some((s) => own.test(s))) soft('짝', `${h.label}: "${first}"가 이 칸을 부르는 말과 같은 문장에 있는지 기계로 못 찾음`);
    }

    if (h.field === 'list_price_krw') {
      const listWord = /정가|정상가|원래|할인\s*전|기존|평소|소비자가|原价|原價|定价|list|original|regular|usual|normally|\bwas\b/i;
      const near = cleanIndexes(content, first).some((i) => listWord.test(content.slice(Math.max(0, i - 40), i + first.length + 40)));
      if (!near) soft('짝', `${h.label}: "${first}"가 정가라는 말 가까이에 있는지 기계로 못 찾음`);
    }
    if (h.field === 'vat_included') {
      const i = content.indexOf(first);
      if (/^\s*(?:아님|아닙|이\s*아니|되지\s*않|안\s*됨)/.test(content.slice(i + first.length, i + first.length + 8))) hard('부가세', `"${first}" 바로 뒤에 부정하는 말이 있다`);
    }

    if (h.field === 'region' || h.field === 'service_region') {
      // 정답 글자가 그것만으로 읽히는 자리가 한 번은 있어야 한다
      const glue = /^[ \t]*(?:\d+[ \t]*번[ \t]*출구|\d+[ \t]*호선|[가-힣]{0,4}[ \t]*출구|사거리|교차로|인근|부근|근처|일대|앞(?![가-힣])|옆|방면|방향|\d+[ \t]*층|대합실|환승[ \t]*통로|개찰구|로데오|[가-힣]{1,6}[ \t]*(?:빌딩|타워|건물|백화점|광장))/;
      const idx = cleanIndexes(content, first).filter((i) => !/[가-힣]/.test(content[i - 1] ?? ''));
      if (idx.length > 0 && idx.every((i) => glue.test(content.slice(i + first.length, i + first.length + 14)))) soft('위치', `${h.label}: "${first}"가 나오는 자리마다 더 자세한 설명이 붙어 있다`);
      if (idx.length === 0 && content.includes(first)) soft('위치', `${h.label}: "${first}"가 다른 낱말의 한 토막으로만 나온다`);
    }
  }

  // 부가세: 정답과 반대되는 말이 한 번 더 나오는가
  if (typeof spec.truth.vat_included === 'boolean') {
    const vatWord = WORDS.vat_included as RegExp;
    for (const s of restSentences.filter((x) => vatWord.test(x))) {
      const opposite = spec.truth.vat_included ? VAT_OUT.test(s) : VAT_IN.test(s) && !VAT_OUT.test(s);
      if (opposite) hard('부가세', `정답은 ${spec.truth.vat_included ? '포함' : '별도'}인데 반대로 읽히는 말이 있다: "${s.slice(0, 50)}"`);
    }
  }

  // 라. 없는 칸
  for (const a of spec.absent) {
    const r = leak(a.field, rest, restSentences, plain, spec.surface_hints);
    if (a.how === 'placeholder') {
      const word = a.placeholder as string;
      const words = WORDS[a.field];
      const lineOk = content.split('\n').some((l) => l.includes(word) && (!words || words.test(l)));
      if (!content.includes(word)) hard('없는 칸', `${a.label}: 값 자리에 쓰기로 한 "${word}"가 없다`);
      else if (!lineOk) soft('없는 칸', `${a.label}: 칸 이름과 "${word}"가 한 줄에 있는지 기계로 못 찾음`);
      for (const x of r.hard) hard('없는 칸에 값', `${a.label}("${word}"라고만 쓰기로 함): ${x}`);
    } else {
      for (const x of r.hard) hard('없는 칸에 값', `${a.label}: ${x}`);
      for (const x of r.mention) soft('없는 칸 낌새', `${a.label}: 값은 안 보이지만 칸을 부르는 말이 있다: "${x}"`);
    }
    for (const x of r.unsure) soft('없는 칸 낌새', `${a.label}: 값이 샜는지 확신하지 못함: ${x}`);
  }

  // 마. 정답에 없는 금액·시간
  const known = new Set<number>();
  for (const k of ['price_krw', 'list_price_krw'] as const) if (typeof spec.truth[k] === 'number') known.add(spec.truth[k] as number);
  for (const k of ['period_options', 'quantity_options'] as const) {
    for (const o of (spec.truth[k] as { price_krw: number }[] | null | undefined) ?? []) known.add(o.price_krw);
  }
  for (const m of rest.matchAll(MONEY)) {
    const unit = (m[2] ?? m[4] ?? '') as string;
    // 단위를 밝히는 말("단위: 만원", "(천원)")은 금액이 아니다
    if (!/\d/.test((m[1] ?? m[3]) as string)) continue;
    const won = moneyValue((m[1] ?? m[3]) as string, unit);
    if (known.has(won)) soft('금액 두 번', `정답의 금액을 다른 표기로 한 번 더 적었다: "${m[0].trim()}"`);
    else hard('정답에 없는 금액', `"${snip(rest, m.index ?? 0, m[0].length)}"`);
  }
  const hoursField = spec.type === 'ad' ? 'hours' : spec.type === 'catering' ? 'service_hours' : null;
  if (hoursField && spec.truth[hoursField]) {
    for (const m of rest.matchAll(TIME_RANGE)) hard('시간 하나 더', `정답의 운영 시간 말고 시간 범위가 더 있다: "${snip(rest, m.index ?? 0, m[0].length)}"`);
  }
  if (spec.type === 'goods') {
    for (const m of rest.matchAll(TIME_RANGE)) hard('시간 하나 더', `시간 범위가 있다: "${snip(rest, m.index ?? 0, m[0].length)}"`);
  }
  // 값이 있는 칸 옆에 정답에 없는 값이 하나 더 있는가
  const extra = (field: FieldKey, re: RegExp, what: string) => {
    if (spec.truth[field] === null || spec.truth[field] === undefined) return;
    for (const m of rest.matchAll(re)) soft('값 하나 더', `정답의 ${what} 말고 하나 더 있다: "${snip(rest, m.index ?? 0, m[0].length)}"`);
  };
  extra('spot_seconds', /\d+\s*(?:초(?!과)|秒|sec(?:ond)?s?\b)/gi, '초수');
  extra('plays_per_day', /\d[\d,]*\s*(?:회(?!사|의|차)|次|times\b|plays\b)/gi, '횟수');
  extra('resolution_px', RES_PAIR, '해상도');
  extra('size_m', DIM_UNIT, '크기');
  extra('size_mm', DIM_UNIT, '크기');
  if (Array.isArray(spec.truth.file_format)) {
    const formats = spec.truth.file_format as string[];
    for (const m of rest.matchAll(FILE_EXT)) {
      const ext = m[0].replace(/^\./, '').toLowerCase().replace('jpeg', 'jpg').replace('tiff', 'tif');
      if (!formats.some((f) => ext.startsWith(f))) hard('정답에 없는 값', `정답의 파일 형식(${formats.join(', ')}) 말고 "${m[0]}"도 나온다`);
    }
  }
  // 정답에 없는 "며칠 전"
  for (const m of rest.matchAll(/(\d+\s*(?:영업일|일|주일|주|개월|시간)|한\s*달|보름)\s*(?:전|이전|이내|안에|여유)|D\s*-\s*\d+/g)) {
    soft('기간 하나 더', `정답의 표기 말고 기간이 더 있다: "${snip(rest, m.index ?? 0, m[0].length)}"`);
  }
  // 다른 지명
  if (spec.type === 'ad' && typeof spec.truth.region === 'string') {
    for (const r of ALL_REGIONS) if (r !== spec.truth.region && rest.includes(r)) soft('지명 하나 더', `정답의 위치 말고 "${r}"도 나온다`);
  }
  return out;
}

// ── 판에 박힘 재기 ──────────────────────────────────────────

/** 표기에서 수를 지운 뼈대. "게재 7일 전까지" → "게재 N일 전까지", "1,500,000원" → "N원" */
export const shapeOf = (text: string) => text.replace(/\d[\d,.]*\d|\d/g, 'N').replace(/\s+/g, ' ').trim();

/** 한 칸의 표기 뼈대. 값표는 짝 하나의 뼈대만 본다(짝의 수가 달라도 같은 꼴로 센다). */
export function hintShape(h: SurfaceHint): string {
  const kind = fieldDef(h.field).kind;
  if (kind === 'period_options' || kind === 'quantity_options') {
    const [a, b] = h.tokens;
    // 첫 차례의 조각은 낱말과 금액이 따로였다("1주", "150만원"). 둘째 차례는 짝이 한 조각이다("1주 → 150만원").
    const pair = a !== undefined && b !== undefined && h.show.startsWith(`${a} ${b}`) ? `${a} ${b}` : (a ?? h.show);
    return shapeOf(pair);
  }
  return shapeOf(h.show);
}

export interface ShapeRow {
  field: FieldKey;
  label: string;
  docs: number;
  /** 가장 흔한 뼈대를 쓴 문서 수 */
  top: number;
  /** 서로 다른 뼈대의 수 */
  kinds: number;
}

/** 칸별로 가장 흔한 표기 뼈대의 몫. 글 칸(이름·위치·재질)은 정답 글자 그대로라 뺀다. */
export function shapeTable(specs: readonly GoldSpec[]): ShapeRow[] {
  const by = new Map<FieldKey, { label: string; shapes: Map<string, number> }>();
  for (const s of specs) {
    for (const h of s.surface_hints) {
      if (fieldDef(h.field).kind === 'text') continue;
      const row = by.get(h.field) ?? { label: h.label, shapes: new Map<string, number>() };
      const shape = hintShape(h);
      row.shapes.set(shape, (row.shapes.get(shape) ?? 0) + 1);
      by.set(h.field, row);
    }
  }
  return [...by].map(([field, r]) => {
    const counts = [...r.shapes.values()];
    return { field, label: r.label, docs: counts.reduce((a, b) => a + b, 0), top: Math.max(...counts), kinds: counts.length };
  });
}

const grams = (t: string) => {
  const x = t.replace(/\s+/g, ' ');
  const set = new Set<string>();
  for (let i = 0; i + 4 <= x.length; i += 1) set.add(x.slice(i, i + 4));
  return set;
};

export interface AlikePair {
  a: string;
  b: string;
  rate: number;
}

/** 네 글자 토막이 겹치는 비율(겹친 토막 ÷ 두 글의 토막 전부)을 모든 짝에 대해 잰다. */
export function alikePairs(docs: readonly { id: string; content: string }[]): AlikePair[] {
  const g = docs.map((d) => grams(d.content));
  const out: AlikePair[] = [];
  for (let i = 0; i < docs.length; i += 1) {
    for (let j = i + 1; j < docs.length; j += 1) {
      const A = g[i] as Set<string>;
      const B = g[j] as Set<string>;
      let both = 0;
      for (const x of A) if (B.has(x)) both += 1;
      out.push({ a: (docs[i] as { id: string }).id, b: (docs[j] as { id: string }).id, rate: both / (A.size + B.size - both) });
    }
  }
  return out;
}

export interface LengthStats {
  n: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  mean: number;
}

export function lengthStats(lengths: readonly number[]): LengthStats {
  const xs = [...lengths].sort((a, b) => a - b);
  const at = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1)))] ?? 0;
  return { n: xs.length, min: xs[0] ?? 0, q1: at(0.25), median: at(0.5), q3: at(0.75), max: xs[xs.length - 1] ?? 0, mean: Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)) };
}
