// 값을 사람이 읽는 꼴로 적는다. 화면에만 쓴다(판단은 서버가 한다).
import { fieldDef, isFieldKey, type FieldKey, type FieldKind } from '@/contract/fields';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 세 자리마다 쉼표. 브라우저 설정과 상관없이 같은 글자가 나온다. */
export function comma(n: number): string {
  const [whole = '0', frac] = String(Math.abs(n)).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

export const won = (n: number) => `${comma(n)}원`;

/** 운영 시간. "05:00~다음 날 01:00" */
export function hoursText(v: Obj): string | null {
  if (typeof v.open !== 'string' || typeof v.close !== 'string') return null;
  if (v.nextDay === true && v.open === v.close) return `24시간(${v.open}부터)`;
  return `${v.open}~${v.nextDay === true ? '다음 날 ' : ''}${v.close}`;
}

function byKind(kind: FieldKind, value: unknown): string | null {
  switch (kind) {
    case 'text':
      return typeof value === 'string' ? value : null;
    case 'money':
      return num(value) ? won(value) : null;
    case 'bool':
      return typeof value === 'boolean' ? (value ? '예' : '아니오') : null;
    case 'count':
    case 'footfall':
      return num(value) ? comma(value) : null;
    case 'days':
      return num(value) ? `${comma(value)}일` : null;
    case 'size_m':
      return isObj(value) && num(value.width) && num(value.height) ? `가로 ${value.width} × 세로 ${value.height} m` : null;
    case 'size_mm':
      return isObj(value) && num(value.width) && num(value.height) ? `가로 ${comma(value.width)} × 세로 ${comma(value.height)} mm` : null;
    case 'resolution':
      return isObj(value) && num(value.width) && num(value.height) ? `${value.width} × ${value.height} px` : null;
    case 'hours':
      return isObj(value) ? hoursText(value) : null;
    case 'period_options':
      if (!Array.isArray(value)) return null;
      if (value.length === 0) return '(옵션 0개)';
      return value.map((o) => (isObj(o) && num(o.days) && num(o.price_krw) ? `${o.days}일 ${won(o.price_krw)}` : JSON.stringify(o))).join(' · ');
    case 'quantity_options':
      if (!Array.isArray(value)) return null;
      if (value.length === 0) return '(옵션 0개)';
      return value.map((o) => (isObj(o) && num(o.qty) && num(o.price_krw) ? `${comma(o.qty)}개 ${won(o.price_krw)}` : JSON.stringify(o))).join(' · ');
    case 'formats':
      return Array.isArray(value) ? (value.length === 0 ? '(없음)' : value.map(String).join(', ')) : null;
  }
}

/** 칸 값을 한 줄로. 없으면 "없음". 꼴이 낯설면 받은 그대로 적는다(숨기지 않는다). */
export function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return '없음';
  if (isFieldKey(field)) {
    const text = byKind(fieldDef(field).kind, value);
    if (text !== null) return text;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** 칸 이름. 종류·갈래 줄도 한국어로. */
export function fieldLabel(field: string): string {
  if (field === 'type') return '종류';
  if (field === 'subtype') return '갈래';
  return isFieldKey(field) ? fieldDef(field as FieldKey).label : field;
}

/** 두 값이 같은가(꼴째로). 코드 값과 모델 값을 견줄 때 쓴다. */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** 시각을 "10월 12일 16:53" 꼴로. 한국 시각이다. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일 ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`;
}

/** 초. 1초가 안 되면 소수 둘째 자리까지. */
export function seconds(ms: number): string {
  const s = ms / 1000;
  return `${s >= 10 ? s.toFixed(0) : s >= 1 ? s.toFixed(1) : s.toFixed(2)}초`;
}

/** 달러. 아주 작은 값도 0 으로 뭉개지 않는다. */
export function usd(value: number): string {
  if (value === 0) return '0달러';
  return `${value >= 0.01 ? value.toFixed(3) : value.toFixed(5)}달러`;
}
