// 견줄 값을 사람이 읽는 말로 적는다. 화면이 쓴다. 순수 함수다(브라우저의 숫자 서식에 기대지 않아 어디서나 같은 글자가 나온다).
import { fieldDef, isFieldKey, TYPE_LABELS, type ProductType } from '@/contract/fields';
import {
  compareMetricDef,
  type CompareBasis,
  type CompareBestWithheld,
  type CompareMetric,
  type CompareOption,
  type CompareRankGroup,
  type CompareRow,
  type CompareValue,
  type CompareWarning,
} from '@/contract/tools/compare';

/** 세 자리마다 쉼표. 소수는 그대로 둔다. */
export function comma(n: number): string {
  const [whole = '0', frac] = String(Math.abs(n)).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

const won = (n: number): string => `${comma(n)}원`;

/** 분 → "20시간", "19시간 30분", "45분". */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}분`;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

/** 초 → "2,000초(33분 20초)". 한 시간이 넘으면 시간도 적는다. 60초가 안 되면 초만. */
export function secondsText(seconds: number): string {
  if (seconds < 60) return `${seconds}초`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [h > 0 ? `${comma(h)}시간` : '', m > 0 ? `${m}분` : '', s > 0 ? `${s}초` : ''].filter(Boolean);
  return `${comma(seconds)}초(${parts.join(' ')})`;
}

/** 나눈 값이 1원에 못 미쳐 반올림하면 0 이 되는 돈. "0원"이라고 적지 않는다(값이 없는 것이 아니다). */
export function belowOneWon(metric: CompareMetric, value: number, rounded: boolean): boolean {
  return compareMetricDef(metric).unit === 'krw' && value === 0 && rounded;
}

const BELOW_ONE_WON = '1원 미만';

/** 잣대의 값을 단위와 함께. 반올림해 0원이 된 돈은 "1원 미만"이다. */
export function metricValueText(metric: CompareMetric, value: number, rounded = false): string {
  if (belowOneWon(metric, value, rounded)) return BELOW_ONE_WON;
  switch (compareMetricDef(metric).unit) {
    case 'krw':
      return won(value);
    case 'people':
      return `${comma(value)}명`;
    case 'm2':
      return `${comma(value)} m²`;
    case 'minutes':
      return durationText(value);
    case 'count':
      return `${comma(value)}회`;
    case 'seconds':
      return secondsText(value);
    case 'days':
      return metric === 'lead_time_days' ? `${comma(value)}일` : value === 0 ? '당일까지' : `${comma(value)}일 전까지`;
    case 'qty':
      return `${comma(value)}개`;
  }
}

/** 어디서 계산했는지 한 줄. 칸을 그대로 읽은 값에는 적을 것이 없다(null). */
export function basisText(basis: CompareBasis | null): string | null {
  if (basis === null) return null;
  switch (basis.kind) {
    case 'period_option':
      return `${comma(basis.days)}일 옵션 ${won(basis.price_krw)} ÷ ${comma(basis.days)}`;
    case 'per_footfall':
      return `${comma(basis.days)}일 옵션 ${won(basis.price_krw)} ÷ ${comma(basis.days)} ÷ 유동인구 ${comma(basis.footfall)}명 × 1,000`;
    case 'quantity_option':
      return `수량 ${comma(basis.qty)} 옵션 ${won(basis.price_krw)} ÷ ${comma(basis.qty)}`;
    case 'size':
      return `가로 ${basis.width} × 세로 ${basis.height} m`;
    case 'hours':
      return basis.nextDay && basis.open === basis.close ? `${basis.open}부터 24시간` : `${basis.open}~${basis.nextDay ? '다음 날 ' : ''}${basis.close}`;
    case 'exposure':
      return `하루 ${comma(basis.plays)}회 × ${comma(basis.seconds)}초`;
    case 'field':
      return null;
  }
}

const fieldLabel = (field: string): string => (isFieldKey(field) ? fieldDef(field).label : field);

/** 값이 없을 때 칸에 적을 말과 그 까닭. 없는 것은 "없음", 그 종류에 없는 잣대는 "해당 없음". */
export function missingText(missing: NonNullable<CompareValue['missing']>): { label: string; why: string } {
  const names = missing.fields.map(fieldLabel).join(', ');
  switch (missing.reason) {
    case 'not_applicable':
      return { label: '해당 없음', why: '이 종류에는 없는 칸입니다.' };
    case 'no_period':
      return { label: '없음', why: `기간 옵션이 없습니다. 기간을 몰라 하루당 값을 내지 않습니다${missing.fields.includes('footfall_per_day') ? '(하루 유동인구도 없습니다)' : ''}.` };
    case 'no_quantity':
      return { label: '없음', why: '수량 옵션이 없습니다. 수량을 몰라 한 개당 값을 내지 않습니다.' };
    case 'bad_value':
      return { label: '없음', why: `${names} 칸의 값으로는 계산할 수 없습니다.` };
    case 'no_value':
      return { label: '없음', why: `${names} 칸이 비어 있습니다.` };
  }
}

/** 옵션 하나에서 낸 값 한 줄. "7일 1,500,000원 → 하루 214,286원(반올림)" */
export function optionText(option: CompareOption): string {
  const head = option.kind === 'period' ? `${comma(option.size)}일` : `수량 ${comma(option.size)}`;
  const each = option.kind === 'period' ? '하루' : '한 개';
  if (option.each === 0 && option.rounded) return `${head} ${won(option.price_krw)} → ${each} ${BELOW_ONE_WON}`;
  return `${head} ${won(option.price_krw)} → ${each} ${won(option.each)}${option.rounded ? '(반올림)' : ''}`;
}

/**
 * 칸의 값을 낸 옵션 말고 나머지 옵션에서 낸 값. 하루당 값 칸에는 대표가 아닌 기간 옵션들,
 * 한 개당 값(가장 적은 수량) 칸에는 가장 적은 수량·가장 많은 수량 칸에 쓰지 않은 옵션들.
 */
export function otherOptionLines(row: Pick<CompareRow, 'values' | 'options'>, metric: CompareMetric): string[] {
  if (metric !== 'per_day_krw' && metric !== 'unit_krw_min_qty') return [];
  const used = (metric === 'per_day_krw' ? [row.values.per_day_krw] : [row.values.unit_krw_min_qty, row.values.unit_krw_max_qty]).map((v) => v.basis);
  const rest = [...row.options];
  for (const basis of used) {
    const from = basis?.kind === 'period_option' ? { size: basis.days, price_krw: basis.price_krw } : basis?.kind === 'quantity_option' ? { size: basis.qty, price_krw: basis.price_krw } : null;
    const at = from ? rest.findIndex((o) => o.size === from.size && o.price_krw === from.price_krw) : -1;
    if (at >= 0) rest.splice(at, 1);
  }
  return rest.map((o) => `다른 옵션: ${optionText(o)}`);
}

/** 쓸 수 없어 계산에서 뺀 옵션이 있으면 그렇다고 적는다. 없으면 null. */
export function skippedText(count: number): string | null {
  return count > 0 ? `쓸 수 없는 옵션 ${comma(count)}개를 뺐습니다(일수·수량·값이 0 이하이거나 꼴이 틀림).` : null;
}

/** 부가세. 적혀 있지 않으면 없음이다(포함이라고도 별도라고도 짐작하지 않는다). */
export function vatText(vatIncluded: boolean | null): string {
  return vatIncluded === null ? '없음' : vatIncluded ? '포함' : '별도';
}

export const RANK_GROUP_LABELS: Record<CompareRankGroup, string> = {
  vat_excluded: '부가세 별도끼리',
  vat_included: '부가세 포함끼리',
  vat_unknown: '부가세를 모르는 것끼리',
};

/** 차례를 매긴 묶음의 머리줄. "광고 지면끼리 · 부가세 별도끼리". 묶지 않았으면 null. */
export function rankHeadText(rankType: ProductType | null, rankGroup: CompareRankGroup | null): string | null {
  const parts = [rankType ? `${TYPE_LABELS[rankType]}끼리` : '', rankGroup ? RANK_GROUP_LABELS[rankGroup] : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** 차례를 어떻게 묶어 매겼는지 한마디. 한 줄로 매겼으면 빈 글자. */
export function rankScopeText(sort: { split: boolean; byType: boolean }): string {
  const parts = [sort.byType ? '종류가 같은 것끼리' : '', sort.split ? '부가세가 같은 것끼리' : ''].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** 잣대의 방향을 한마디로. 방향이 없으면 null. */
export function betterText(metric: CompareMetric): string | null {
  const better = compareMetricDef(metric).better;
  return better === null ? null : better === 'lower' ? '작을수록 좋음' : '클수록 좋음';
}

/** "좋은 쪽" 표시를 붙이지 않은 까닭. metric 을 주면 기간인지 수량인지 맞춰 적는다. 굳이 적지 않아도 되는 것(방향 없음, 값이 모자람, 모두 같음)은 null. */
export function withheldText(withheld: CompareBestWithheld | null, metric?: CompareMetric): string | null {
  if (withheld === 'mixed_basis') {
    const what = metric === 'unit_krw_min_qty' || metric === 'unit_krw_max_qty' ? '수량' : '기간';
    return `값을 나눈 옵션의 ${what}이 서로 달라 좋은 쪽을 표시하지 않습니다.`;
  }
  if (withheld === 'vat_mixed') return '부가세 포함 여부가 섞였거나 적혀 있지 않아 좋은 쪽을 표시하지 않습니다.';
  if (withheld === 'mixed_types') return '종류가 달라 좋은 쪽을 표시하지 않습니다.';
  return null;
}

const metricLabels = (metrics: readonly CompareMetric[]): string => metrics.map((m) => compareMetricDef(m).label).join(', ');

/** 묶음의 경고를 문장으로. */
export function warningText(warning: CompareWarning): string {
  if (warning.code === 'vat_mixed') {
    const parts = [
      warning.excluded > 0 ? `별도 ${warning.excluded}건` : '',
      warning.included > 0 ? `포함 ${warning.included}건` : '',
      warning.unknown > 0 ? `적혀 있지 않은 것 ${warning.unknown}건` : '',
    ].filter(Boolean);
    return `부가세가 섞여 있습니다(${parts.join(', ')}). 금액은 상품에 적힌 그대로이고 부가세를 더하거나 빼지 않았습니다. 그래서 돈 잣대(${metricLabels(warning.metrics)})는 부가세가 같은 것끼리만 견줍니다.`;
  }
  const types = warning.types.map((t) => TYPE_LABELS[t]).join(', ');
  return `종류가 섞여 있습니다(${types}). 한쪽 종류에만 있는 칸(${metricLabels(warning.metrics)})은 묶음 전체로 견줄 수 없습니다.`;
}
