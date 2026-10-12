// 답장에 말로 쓴 숫자와, 이름의 숫자를 다른 뜻으로 쓴 자리를 찾는다. 순수 함수다.
// 본체의 글 검사는 아라비아 숫자(전각 포함)만 센다. 답장은 숫자가 전부 자리표시에서 나와야 하므로 여기서 더 본다.
// 다 막지는 못한다. 못 보는 것: 목록에 없는 수 낱말("a couple of", "dozen", "하루", "열네"), 단위 없이 쓴 수 낱말("three options"),
// 이름의 숫자를 단위 없이 다시 쓴 경우. docs/EVALUATION-TOOLS.md 의 견적 절에 적었다.

const EN_UNIT = String.raw`(?:days?|nights?|weeks?|months?|years?|hours?|won|krw|units?|pieces?|pcs|cups?|servings?|sets?|copies|people|persons?|guests?|sheets?|items?|payments?|times)`;
const EN_CARDINAL = String.raw`(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)`;
const EN_ORDINAL = String.raw`(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|(?:twenty|thirty)-(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth))`;
// 달 이름은 첫 글자가 대문자일 때만 본다("may" 는 흔한 말이다).
const EN_MONTH = String.raw`(?:January|February|March|April|May|June|July|August|September|October|November|December)`;
const KO_UNIT = String.raw`(?:원|일|개월|개|장|잔|명|인분|주|달|년|월|회|부|세트|박스)`;
// "号"는 날짜("9号")일 때만 본다. "9号出口"(9번 출구), "9号线"(9호선) 같은 자리 이름은 값이 아니다.
const ZH_DAY = String.raw`号(?!出口|线|線|楼|樓|馆|館|厅|廳|门|門|口)`;
const ZH_UNIT = String.raw`(?:韩元|韩币|元|块|天|日|${ZH_DAY}|个月|月|年|周|星期|个|份|张|杯|件|次|人)`;

const WORD_PATTERNS: readonly RegExp[] = [
  // 영어: 큰 수의 낱말은 그 자체로, 그 밖의 수사는 금액·기간·수량 낱말 앞에서만("fourteen days"). "one" 은 흔한 말이라 보지 않는다.
  /\b(?:hundred|thousand|million|billion)s?\b/i,
  new RegExp(String.raw`\b${EN_CARDINAL}(?:[- ]\w+)?[- ]${EN_UNIT}\b`, 'i'),
  // 날짜를 말로 쓴 것: "the first of December", "December first".
  new RegExp(String.raw`\b${EN_ORDINAL}\s+of\s+${EN_MONTH}\b|\b${EN_MONTH}\s+(?:the\s+)?${EN_ORDINAL}\b`),
  // 로마 숫자를 글자로 쓴 것은 단위 앞에서만("XIV days").
  new RegExp(String.raw`\b(?!I\b)[IVXLC]{1,7}\s+${EN_UNIT}\b`),
  // 한자 숫자: 십·백·천·만·억이 든 수, 또는 한 글자 수사가 단위 앞에 있을 때("二百六十万韩元", "十四天", "三月").
  new RegExp(String.raw`[〇零一二两兩三四五六七八九十百千万萬亿億]*[十百千万萬亿億][〇零一二两兩三四五六七八九十百千万萬亿億]*\s*${ZH_UNIT}`),
  new RegExp(String.raw`[一二两兩三四五六七八九](?:天|日|${ZH_DAY}|个月|月|年|周|星期)`),
  // 한글 숫자: 십·백·천·만·억이 든 두 글자 이상의 수가 단위 앞에 있을 때("삼백만 원", "십사 일").
  new RegExp(String.raw`(?<![가-힣])(?!만일)(?=[일이삼사오육칠팔구십백천만억]{2,})[일이삼사오육칠팔구]?(?:[십백천만억][일이삼사오육칠팔구]?)+\s*${KO_UNIT}(?![가-힣])`),
  // 날 수를 세는 우리말.
  /이틀|사흘|나흘|닷새|엿새|이레|여드레|아흐레|열흘|보름|[일이삼사]주일|(?<![가-힣])(?:한|두|석|세|넉|네)\s?(?:달|주)(?![가-힣])/,
];

/** 숫자 꼴인데 아스키 숫자가 아닌 글자(로마 숫자 Ⅻ, 동그라미 숫자 ①, 분수 ½, 아라비아 문자 숫자 ٣ 같은 것). */
const OTHER_DIGITS = /[\p{Nl}\p{No}]|(?![0-9])\p{Nd}/u;

/** 글에 말로 쓴 숫자가 있는가. text 는 자리표시를 뗀 글이다. */
export function hasNumberWords(text: string): boolean {
  // 호환 꼴 맞추기(NFKC)가 로마 숫자를 글자로, 전각 숫자를 아스키 숫자로 바꾼다. 그래서 바꾸기 전의 글에서 먼저 본다(전각 숫자는 본체의 검사가 센다).
  if (OTHER_DIGITS.test(text.replace(/[０-９]/g, ''))) return true;
  const flat = text.normalize('NFKC');
  return WORD_PATTERNS.some((re) => re.test(flat));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 이름·지역에 원래 있는 숫자("9번 출구"의 9)가 글에서 금액·기간·수량·날짜로 쓰였는가("for 9 days").
 * text 는 자리표시와, 이름·지역 표기가 글자 그대로 들어간 자리를 뗀 글이다. numbers 는 봐주는 숫자 덩어리들이다.
 */
export function numberUsedAsValue(text: string, numbers: readonly string[]): boolean {
  const flat = text.normalize('NFKC');
  return numbers.some((n) => {
    // 더 큰 수의 한 토막("1,700" 의 7)은 그 수가 아니다. 앞뒤가 숫자이거나 숫자에 붙은 쉼표·점이면 건너뛴다.
    const num = String.raw`(?<!\d|\d[.,])${escapeRe(n)}(?!\d|[.,]\d)`;
    return [
      new RegExp(String.raw`${num}\s*-?\s*${EN_UNIT}\b`, 'i'),
      new RegExp(String.raw`${num}(?:st|nd|rd|th)\b`, 'i'),
      new RegExp(String.raw`(?:krw|₩|￦)\s*${num}`, 'i'),
      new RegExp(String.raw`\b${EN_MONTH}\s+${num}|${num}\s+${EN_MONTH}\b`),
      new RegExp(String.raw`${num}\s*(?:${KO_UNIT}|[만천백억])`),
      new RegExp(String.raw`${num}\s*(?:${ZH_UNIT}|[万萬千百亿億])`),
    ].some((re) => re.test(flat));
  });
}
