// 구조 검사: 필수 옵션 0개, 종류·갈래 불일치, 자리 채움 글자, 지시문처럼 보이는 문장.
import type { StructureInput, StructureResult } from '@/contract/core-api';
import { FIELDS_BY_TYPE, isSubtypeOf, REQUIRED_OPTION_FIELDS } from '@/contract/fields';
import type { ReasonCode } from '@/contract/reasons';

/** 값 자리에 들어온 자리 채움 글자. 점·줄표뿐이거나 "추후 안내" 같은 말뿐인 것. */
const PLACEHOLDER_WORDS =
  /^(?:추후\s*(?:안내|공지|협의|결정|확정)(?:\s*예정)?|(?:미정|미확정)(?:\s*\(?\s*추후\s*(?:안내|공지|협의|결정|확정)\s*\)?)?|(?:확인|준비|조율|협의)\s*중|상담\s*후\s*(?:결정|안내)|없음|해당\s*없음|모름|tbd|tba|n\/?a|none|null|待定)$/;
/** "문의", "가격 문의", "별도 협의 바람" */
const ASK_WORDS = /^(?:\S{1,6}\s*)?(?:문의|협의)(?:\s*(?:바람|요망|주세요|바랍니다|후\s*결정|가능|필요))?$/;

export function isPlaceholder(text: string): boolean {
  const t = text.normalize('NFKC').trim().toLowerCase();
  if (t === '') return false;
  if (/^[\s.\-–—_~·*?!…/xX○△□]+$/.test(t)) return true;
  const word = t.replace(/[.\s]+$/, '');
  return PLACEHOLDER_WORDS.test(word) || ASK_WORDS.test(word);
}

/**
 * 원문이 읽는 쪽에게 시키는 말처럼 보이는 꼴.
 * 손님에게 하는 말("문의하세요", "예약하세요")은 걸지 않고, 등록 값·출력·앞선 지시를 건드리는 말만 건다.
 */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /(?:이전|위|앞|기존|지금까지)(?:의|에)?\s*(?:모든\s*)?(?:지시|지침|명령|규칙|프롬프트|내용|글|말|설명)[^\n]{0,12}(?:무시|잊)/,
  /(?:으로|로)\s*(?:적어라|적어\s*줘|적을\s*것|적으시오|써라|쓸\s*것|바꿔라|바꿀\s*것|고쳐라|채워라|채울\s*것)/,
  /(?:칸|값|항목|필드)[^\n]{0,10}비워\s*(?:두|둬|놓)/,
  /(?:시스템|system)\s*(?:프롬프트|prompt|메시지|message)/i,
  /(?:ai|인공지능|어시스턴트|assistant|챗봇|모델)\s*(?:는|은|에게|야|님)[\s,][^\n]{0,40}(?:하라|해라|하세요|하시오|하십시오|할\s*것|해\s*줘|말\s*것|마라|마세요)/i,
  /(?:값|가격|금액|판매가|정가|칸|필드|항목|상태)[^\n]{0,20}(?:으로|로)\s*(?:등록|입력|기재|출력|설정|표시|추출|저장|처리)\s*(?:하라|해라|하시오|하십시오|할\s*것|하세요|해\s*주세요|해\s*줘|바람)/,
  /(?:반드시|무조건)[^\n]{0,30}(?:등록|출력|승인|입력|추출|통과)\s*(?:하라|해라|하시오|하십시오|할\s*것|하세요|시켜)/,
  /(?:검수|검토|확인)[^\n]{0,10}(?:없이|생략|건너뛰)[^\n]{0,20}(?:승인|등록|통과)/,
  /(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|messages?)/i,
  /(?:ignore|disregard|forget)\s+(?:all\s+|everything\s+)?(?:the\s+)?(?:above|previous|prior)\b/i,
  /you\s+are\s+now\b/i,
  /(?:set|register|output|return|report)\s+(?:the\s+|this\s+)?(?:price|value|field|amount|status)[^\n]{0,30}\b(?:as|to)\b/i,
  /do\s+not\s+(?:extract|flag|report|follow)/i,
  /忽略(?:之前|以上|上述|前面)?的?(?:所有)?(?:指示|指令|说明|规则)/,
  /请?(?:将|把)[^\n]{0,20}(?:登记|设置|输出|填写)为/,
  /(?:价格|金额|售价|状态)[^\n]{0,6}请?(?:登记|设置|输出|填写|改)[为成]/,
];

export function looksLikeInstruction(sourceText: string): boolean {
  const t = sourceText.normalize('NFKC');
  return INSTRUCTION_PATTERNS.some((re) => re.test(t));
}

export function checkStructure(input: StructureInput): StructureResult {
  const { sourceText, type, subtype, raws, values } = input;
  const fieldReasons: StructureResult['fieldReasons'] = {};
  const add = (key: keyof typeof fieldReasons, code: ReasonCode) => {
    const list = (fieldReasons[key] ??= []);
    if (!list.includes(code)) list.push(code);
  };

  for (const key of REQUIRED_OPTION_FIELDS[type]) {
    const value = values[key];
    if (Array.isArray(value) && value.length === 0) add(key, 'EMPTY_REQUIRED_OPTIONS');
  }
  for (const key of FIELDS_BY_TYPE[type]) {
    const raw = raws[key];
    const value = values[key];
    if (typeof raw === 'string' && isPlaceholder(raw)) add(key, 'PLACEHOLDER_VALUE');
    if (typeof value === 'string' && isPlaceholder(value)) add(key, 'PLACEHOLDER_VALUE');
  }

  const draftReasons: ReasonCode[] = [];
  if (!isSubtypeOf(type, subtype)) draftReasons.push('TYPE_SUBTYPE_MISMATCH');
  if (looksLikeInstruction(sourceText)) draftReasons.push('INSTRUCTION_LIKE');
  return { fieldReasons, draftReasons };
}
