// 글자 칸의 "감싼 꼴" 벗기기.
// 모델이 값은 맞게 읽고(value) 원문 표현(raw)을 이름표째·문장째 적을 때가 있다("위치: ○○", "위치는 ○○ 이에요").
// raw 에서 value 를 뺀 나머지가 칸 이름표와 문장을 맺는 말뿐이면 value 를 코드 값으로 쓴다.
// 나머지에 다른 낱말이나 기호가 하나라도 남으면 벗기지 않는다.
// 모델 값이 이미 잘린 값일 때(이름의 앞 낱말만 준 때) 그 잘린 값을 표시 없이 싣는 일을 막으려고 꼴을 좁게 둔다.
// 좁아서 못 벗긴 것은 전과 같이 raw 가 실리고 불일치 표시가 붙는다.
import type { FieldKey } from '@/contract/fields';
import { squash } from '../text';

/** 값이 한 글자면 어느 글에나 들어 있어서 벗기지 않는다. */
const MIN_VALUE_CHARS = 2;

/** 칸마다 그 칸을 가리키는 이름표 낱말(소문자, 공백 없이). 닫힌 목록이다. 목록에 없는 머리말은 벗기지 않는다. */
const LABELS: Partial<Record<FieldKey, readonly string[]>> = {
  name: [
    '상품명', '상품이름', '제품명', '제품이름', '품명', '품목', '품목명', '매체명', '매체이름', '지면명', '지면이름', '이름', '명칭', '상품', '제품',
    'productname', 'itemname', 'name', 'product', 'item', 'title',
    '商品名称', '产品名称', '產品名稱', '商品名', '产品名', '名称', '名稱', '品名',
  ],
  region: [
    '위치', '장소', '주소', '소재지', '지역', '설치위치', '설치장소', '게재위치', '매체위치',
    'location', 'place', 'address', 'site', 'area', 'region',
    '地点', '地點', '位置', '地址', '场所', '場所',
  ],
  service_region: [
    '출장지역', '출장가능지역', '서비스지역', '가능지역', '배달지역', '배송지역', '지역', '출장',
    'servicearea', 'serviceregion', 'coverage', 'area', 'region',
    '服务地区', '服务区域', '服務地區', '地区', '地區', '区域',
  ],
  material: [
    '재질', '소재', '원단', '재료', '용지',
    'material', 'materials', 'fabric', 'paper',
    '材质', '材質', '材料', '面料',
  ],
};

/** 이름표 앞에 올 수 있는 것: 글자도 숫자도 아닌 것(공백, 글머리 기호, 여는 괄호)의 줄. 값과는 닿지 않는 자리다. */
const LEAD = String.raw`[^\p{L}\p{N}]*`;
/** 값 바로 앞에 올 수 있는 것: 공백과 여는 괄호·따옴표뿐. 닫힌 목록이다. 그 밖의 기호가 값에 붙어 있으면 벗기지 않는다. */
const OPEN = String.raw`[\s(\[{<【「『〔《"'“‘]*`;
/** 값 바로 뒤에 올 수 있는 닫는 괄호·따옴표. */
const CLOSE = String.raw`[)\]}>】」』〕》"'”’]`;
/** 맨 끝에 올 수 있는 것: 공백, 닫는 괄호·따옴표, 마침표, 느낌표뿐. 물음표·물결·더하기 같은 기호는 뜻이 있을 수 있어 넣지 않는다. */
const TAIL = String.raw`(?:\s|${CLOSE}|[.!。！])*`;
/**
 * 이름표와 값을 가르는 기호. 이름표를 감싼 괄호의 닫는 쪽도 넣는다("[위치] ○○").
 * 줄표와 화살표는 넣지 않는다. "○○ - △△"는 이름 한가운데에도 흔히 오는 꼴이다.
 */
const SEPARATOR = String.raw`[:：=|\])】」』〕》]`;
/** 이름표 뒤의 조사. 조사와 값 사이는 띄어 있어야 한다(붙어 있으면 한 낱말일 수 있다). */
const KO_PARTICLE = String.raw`(?:은|는|이|가)(?=\s)`;

/**
 * 문장을 맺는 말. 닫힌 목록이다. 홀로는 이름의 낱말이 될 수 없는 것만 넣는다.
 * 넣지 않은 것: "고요", "구요", "이다", "네요", "지요", "이요", "이며", "랍니다", "에요", "요", "임", "죠".
 * 이름의 끝 낱말이거나 낱말의 끝 글자일 수 있어서다.
 * 맺는 말은 값과 띄어 있거나 닫는 괄호·따옴표 뒤에 올 때만 본다. 값에 바로 붙은 것은 낱말의 끝 글자일 수 있어 벗기지 않는다.
 */
const ENDINGS = [
  '이라고 합니다', '라고 합니다', '이라고 해요', '라고 해요',
  '입니다', '입니당', '이에요', '이예요', '이에용', '예요', '이구요', '이고요',
];
/** 위치 칸에서만: "~ 에 있어요", "~ 에 위치합니다". 값이 놓인 곳이라는 말일 뿐 값의 일부가 아니다. */
const PLACE_ENDINGS = [
  '에 위치해 있습니다', '에 위치해 있어요', '에 위치하고 있습니다', '에 위치합니다', '에 위치해요', '에 있습니다', '에 있어요',
];

const alt = (words: readonly string[]) =>
  [...words].sort((a, b) => b.length - a.length).map((w) => w.replace(/ /g, String.raw`\s*`)).join('|');

/** 이름표 낱말을 정규식으로. 낱말 안의 띄어쓰기는 있어도 없어도 된다("상품 이름", "상품이름"). */
function labelPattern(labels: readonly string[]): string {
  const spaced = (w: string) => [...w].join(String.raw`\s*`);
  return [...labels].sort((a, b) => b.length - a.length).map(spaced).join('|');
}

interface Shapes {
  /** 이름표 + 가르는 기호. 뒤쪽이 비어도 된다("위치: ○○"). */
  labeled: RegExp;
  /** 이름표 + 조사. 뒤쪽에 맺는 말이 있어야 한다("위치는 ○○ 이에요"). 맺는 말이 없으면 이름의 앞머리일 수 있다. */
  particled: RegExp;
  /** 맺는 말 + 끝. */
  ended: RegExp;
  /** 끝(닫는 괄호·따옴표, 마침표)만. */
  bare: RegExp;
  /** 앞쪽에 이름표 없이 공백과 여는 괄호·따옴표만. */
  opened: RegExp;
  labels: ReadonlySet<string>;
}

function shapesFor(field: FieldKey): Shapes | null {
  const labels = LABELS[field];
  if (!labels) return null;
  // 글머리 기호·번호 → 이름표
  const head = String.raw`^${LEAD}(?:\d{1,2}[.)])?${LEAD}(?:${labelPattern(labels)})`;
  const endings = field === 'region' ? [...PLACE_ENDINGS, ...ENDINGS] : ENDINGS;
  return {
    labeled: new RegExp(String.raw`${head}\s*${SEPARATOR}${OPEN}$`, 'iu'),
    particled: new RegExp(String.raw`${head}${KO_PARTICLE}${OPEN}$`, 'iu'),
    ended: new RegExp(String.raw`^(?:${CLOSE}+\s*|\s+)(?:${alt(endings)})${TAIL}$`, 'u'),
    bare: new RegExp(String.raw`^${TAIL}$`, 'u'),
    opened: new RegExp(String.raw`^${OPEN}$`, 'u'),
    labels: new Set(labels),
  };
}

const SHAPES = new Map<FieldKey, Shapes | null>();
function cachedShapes(field: FieldKey): Shapes | null {
  if (!SHAPES.has(field)) SHAPES.set(field, shapesFor(field));
  return SHAPES.get(field) ?? null;
}

/**
 * raw 가 value 를 감싼 꼴이면 value(앞뒤 공백을 뗀 것)를, 아니면 null 을 낸다. null 이면 부르는 쪽은 전과 같이 raw 를 쓴다.
 * 벗기는 꼴은 셋뿐이다.
 * - 이름표 + 가르는 기호 + 값 (+ 맺는 말)      "위치: ○○", "[위치] ○○ 입니다"
 * - 이름표 + 조사 + 값 + 맺는 말              "위치는 ○○ 이에요"
 * - 값 + 맺는 말                              "○○ 입니다"
 * 그리고 모두 채워야 한다.
 * - 글자 칸이고, 값이 두 글자 이상이며 이름표 낱말 자체가 아니다.
 * - 값이 raw 안에 글자 그대로 있고, 원문에도 있다(공백 차이만 봐준다).
 * - 나머지에 위의 꼴 말고 다른 글자·숫자·기호가 없다.
 */
export function unwrapLabeled(field: FieldKey, raw: string, value: string, sourceText: string): string | null {
  const shapes = cachedShapes(field);
  if (!shapes) return null;
  const inner = value.trim();
  if ([...inner].length < MIN_VALUE_CHARS) return null;
  if (shapes.labels.has(inner.toLowerCase().replace(/\s+/g, ''))) return null;
  if (!squash(sourceText).includes(squash(inner))) return null;

  for (let at = raw.indexOf(inner); at !== -1; at = raw.indexOf(inner, at + 1)) {
    const before = raw.slice(0, at);
    const after = raw.slice(at + inner.length);
    const ended = shapes.ended.test(after);
    if (!ended && !shapes.bare.test(after)) continue;
    // 앞쪽은 처음부터 끝까지 이름표 꼴이어야 한다. 앞쪽에 이름표가 없으면 뒤에 맺는 말이 있어야 감싼 꼴이다.
    if (shapes.labeled.test(before)) return inner;
    if (ended && (shapes.opened.test(before) || shapes.particled.test(before))) return inner;
  }
  return null;
}
