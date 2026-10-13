'use client';

// 비교 화면. 거르기 → 표(잣대 칸을 눌러 차례 바꾸기) → 2~4개를 골라 나란히 보기.
// 계산은 서버가 한다(GET /api/compare → src/tools/compare 의 순수 함수). 이 화면은 고른 값을 보내고 받은 값을 그대로 적는다.
// 값이 없는 칸은 "없음"으로 적고 까닭을 붙인다. 화면이 값을 채우거나 다시 계산하지 않는다.
import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import { PRODUCT_TYPES, SUBTYPES, TYPE_LABELS, type ProductType } from '@/contract/fields';
import {
  COMPARE_LIMITS,
  compareMetricDef,
  type CompareFact,
  type CompareMetric,
  type CompareResponse,
  type CompareRow,
  type CompareSide,
  type CompareValue,
  type CompareWarning,
} from '@/contract/tools/compare';
import {
  basisText,
  belowOneWon,
  betterText,
  comparePath,
  metricValueText,
  missingText,
  nextSort,
  otherOptionLines,
  rankHeadText,
  rankScopeText,
  skippedText,
  tableMetrics,
  togglePick,
  vatText,
  warningText,
  withheldText,
  type CompareChoice,
} from '@/tools/compare';
import { Notice } from '../../components/bits';
import { call, failureMessage, productHref, useMounted, useWorkspace } from '../../components/client';
import styles from './compare.module.css';

type Space = 'public' | 'mine';

const FACT_LABELS: Record<CompareFact, string> = { type: '종류', subtype: '갈래', region: '위치·출장 지역', vat: '부가세' };

/** 잣대 하나의 칸. 값 + (반올림) + 어디서 계산했는지, 또는 없음 + 까닭. */
function ValueCell({ metric, value, extra }: { metric: CompareMetric; value: CompareValue; extra?: readonly string[] }) {
  if (value.value === null || value.missing !== null) {
    const { label, why } = missingText(value.missing ?? { reason: 'no_value', fields: [] });
    return (
      <>
        <span className={`${styles.value} ${styles.none}`}>{label}</span>
        <span className={styles.note}>{why}</span>
      </>
    );
  }
  const basis = basisText(value.basis);
  return (
    <>
      <span className={styles.value}>
        {metricValueText(metric, value.value, value.rounded)}
        {value.rounded && !belowOneWon(metric, value.value, value.rounded) ? <span className="muted small"> (반올림)</span> : null}
      </span>
      {basis ? <span className={styles.note}>{basis}</span> : null}
      {(extra ?? []).map((line) => (
        <span key={line} className={styles.note}>
          {line}
        </span>
      ))}
    </>
  );
}

/** 값 아래에 덧붙이는 줄: 칸의 값을 낸 옵션 말고 나머지 옵션에서 낸 값, 그리고 쓸 수 없어 뺀 옵션이 있으면 그 수. */
function otherOptions(row: CompareRow, metric: CompareMetric): string[] {
  const lines = otherOptionLines(row, metric);
  const skipped = metric === 'per_day_krw' || metric === 'unit_krw_min_qty' ? skippedText(row.optionsSkipped) : null;
  return skipped ? [...lines, skipped] : lines;
}

function Warnings({ warnings }: { warnings: readonly CompareWarning[] }) {
  return (
    <>
      {warnings.map((w) => (
        <Notice key={w.code} kind="warn">
          {warningText(w)}
        </Notice>
      ))}
    </>
  );
}

function factCell(row: CompareRow, fact: CompareFact): string {
  if (fact === 'type') return TYPE_LABELS[row.type];
  if (fact === 'subtype') return row.subtype;
  if (fact === 'region') return row.region ?? (row.type === 'goods' ? '해당 없음' : '없음');
  return vatText(row.vatIncluded);
}

/** 고른 상품을 나란히 놓은 표. 줄 = 칸, 세로 = 상품. 값이 서로 다른 줄에 표시가 붙는다. */
export function SideTable({ side, publicSpace, onClose }: { side: CompareSide; publicSpace: boolean; onClose: () => void }) {
  const differing = side.facts.filter((f) => f.differs).length + side.metrics.filter((m) => m.differs).length;
  return (
    <section className="export" aria-label="나란히 보기">
      <div className="head">
        <h2>
          나란히 보기 <span className="count">{side.rows.length}개 · 서로 다른 칸 {differing}줄</span>
        </h2>
        <button type="button" className="btn small" onClick={onClose}>
          닫기
        </button>
      </div>
      <Warnings warnings={side.warnings} />
      <div className="table-wrap" tabIndex={0}>
        <table>
          <caption className="sr-only">고른 상품을 칸마다 나란히 놓은 표. 값이 서로 다른 줄에는 &ldquo;다름&rdquo; 표시가 있다.</caption>
          <thead>
            <tr>
              <th scope="col">칸</th>
              {side.rows.map((row) => (
                <th key={row.productId} scope="col">
                  <Link href={productHref(row.productId, publicSpace)}>{row.name}</Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {side.facts.map(({ fact, differs }) => (
              <tr key={fact} className={differs ? styles.diff : undefined}>
                <th scope="row">
                  {FACT_LABELS[fact]}
                  {differs ? <span className={styles.tag}>다름</span> : null}
                </th>
                {side.rows.map((row) => {
                  const text = factCell(row, fact);
                  return (
                    <td key={row.productId} className={text === '없음' || text === '해당 없음' ? styles.none : undefined}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
            {side.metrics.map(({ metric, differs, best, bestWithheld }) => {
              const better = betterText(metric);
              const withheld = differs ? withheldText(bestWithheld, metric) : null;
              return (
                <tr key={metric} className={differs ? styles.diff : undefined}>
                  <th scope="row">
                    {compareMetricDef(metric).label}
                    {differs ? <span className={styles.tag}>다름</span> : null}
                    {better && bestWithheld !== 'no_direction' ? <span className={styles.note}>{better}</span> : null}
                    {withheld ? <span className={styles.note}>{withheld}</span> : null}
                  </th>
                  {side.rows.map((row) => (
                    <td key={row.productId}>
                      <ValueCell metric={metric} value={row.values[metric]} extra={otherOptions(row, metric)} />
                      {best.includes(row.productId) ? <span className={styles.best}>좋은 쪽</span> : null}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        &ldquo;좋은 쪽&rdquo;은 작을수록 좋은지 클수록 좋은지가 분명한 칸에만, 같은 것끼리일 때만 붙습니다: 종류가 같고, 돈이면 부가세가 같고, 하루당 값·유동인구 1,000명당
        값·한 개당 값이면 값을 나눈 옵션의 기간(수량)이 같을 때입니다. 7일 옵션의 하루당 값과 30일 옵션의 하루당 값은 견주지 않습니다(긴 옵션일수록 하루당 값이 싸지기
        쉽습니다). 화면 넓이와 한 번 길이처럼 어느 쪽이 좋다고 말할 수 없는 칸에도 붙이지 않습니다. 이 방향은 재서 정한 것이 아니라 미리 정해 둔 것입니다.
      </p>
    </section>
  );
}

/** 지키는 것과 계산하는 법. 기준을 숨기지 않고 적는다. */
export function CompareRules() {
  return (
    <section aria-label="계산하는 법">
      <h2>계산하는 법</h2>
      <ul className={styles.rules}>
        <li>
          <strong>하루당 값 = 기간 옵션 하나의 값 ÷ 그 옵션의 일수.</strong> 대표는 가장 짧은 기간 옵션입니다. 30일 옵션만 있는 지면의 7일 값을 만들어 내지 않습니다. 기간 옵션이
          없고 판매가만 있으면 기간을 몰라 하루당 값을 내지 않습니다. 긴 옵션일수록 하루당 값이 싸지는 경우가 많으므로, 대표 옵션의 기간이 다른 지면끼리는 값 옆의 작은 글씨를
          함께 보세요. 차례는 기간이 달라도 한 줄로 매기지만, 나란히 볼 때 &ldquo;좋은 쪽&rdquo;은 기간이 같은 옵션끼리만 붙입니다. 일수가 같은 옵션이 둘이면 판매가와 값이
          같은 것을 대표로 삼습니다. 일수나 값이 0 이하인 옵션은 빼고, 뺐다고 값 아래에 적습니다.
        </li>
        <li>
          <strong>유동인구 1,000명당 값 = 옵션의 값 × 1,000 ÷ (일수 × 하루 유동인구).</strong> 하루당 값과 유동인구가 둘 다 있을 때만 냅니다. 반올림한 하루당 값을 다시
          나누지 않고 한 번에 나눕니다. 유동인구는 공급처가 적은 숫자 그대로이고 재는 방법이 서로 다를 수
          있습니다.
        </li>
        <li>
          <strong>반올림.</strong> 나누어떨어지지 않으면 원 단위로 반올림하고 &ldquo;(반올림)&rdquo;이라고 적습니다. 반올림하면 0원이 되는 값은 &ldquo;1원 미만&rdquo;으로
          적습니다. 화면 넓이는 소수 넷째 자리까지 냅니다.
        </li>
        <li>
          <strong>없는 값.</strong> 칸이 비어 있으면 &ldquo;없음&rdquo;입니다. 다른 칸에서 짐작해 채우지 않습니다. 차례를 매기면 없는 것은 맨 뒤에 오고, 같은 값은 같은 차례입니다(1, 1, 3. 놓는
          순서는 상품 번호가 작은 것이 앞).
        </li>
        <li>
          <strong>부가세.</strong> 금액은 상품에 적힌 그대로입니다. 더하지도 빼지도 않습니다. 포함과 별도가 섞인 묶음을 돈 잣대로 차례 매기면 부가세가 같은 것끼리만 차례를
          매깁니다.
        </li>
        <li>
          <strong>종류가 섞였을 때의 판매가.</strong> 광고의 판매가는 기간 옵션의 값, 케이터링은 수량 옵션의 값, 굿즈는 낱개 값입니다. 종류를 고르지 않고 판매가로 차례를 매기면
          종류가 같은 것끼리만 차례를 매깁니다.
        </li>
        <li>
          <strong>하루 운영 시간.</strong> 시작부터 끝까지입니다. 끝이 다음 날이면 그만큼 더합니다(05:00~다음 날 01:00 = 20시간).
        </li>
        <li>
          <strong>케이터링과 굿즈.</strong> 케이터링은 수량 옵션의 값 ÷ 그 수량(가장 적은 수량 옵션과 가장 많은 수량 옵션 각각), 굿즈는 판매가·최소 주문 수량·제작 기간을 그대로
          놓습니다.
        </li>
        <li>
          <strong>하지 않는 것.</strong> 같은 상품이 다시 들어왔을 때 지난번과 달라진 칸을 보여 주지 않습니다. 지역은 글자가 들어 있는지만 봅니다(지도를 모릅니다). 결과를 저장하지
          않습니다.
        </li>
      </ul>
    </section>
  );
}

export function CompareTool() {
  const mounted = useMounted();
  const workspace = useWorkspace();

  const [space, setSpace] = useState<Space>('public');
  const [type, setType] = useState<ProductType | null>('ad');
  const [subtype, setSubtype] = useState<string | null>(null);
  const [region, setRegion] = useState('');
  const [sort, setSort] = useState<CompareChoice['sort']>(null);
  const [picked, setPicked] = useState<readonly number[]>([]);
  const [sideIds, setSideIds] = useState<readonly number[]>([]);
  const [loaded, setLoaded] = useState<{ key: string; space: Space; data: CompareResponse } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);

  // 내 작업 공간이 아직 없으면 볼 수 있는 것은 본보기 공간뿐이다.
  const chosen: Space = workspace && space === 'mine' ? 'mine' : 'public';
  const path = comparePath({ type, subtype, region, sort, ids: sideIds });
  const key = `${chosen} ${path}`;

  useEffect(() => {
    let alive = true;
    call<CompareResponse>('GET', path, { publicSpace: chosen === 'public', label: `비교 (${chosen === 'public' ? '본보기 공간' : '내 작업 공간'})` })
      .then((data) => {
        if (!alive) return;
        setLoaded({ key, space: chosen, data });
        setFailed(null);
      })
      .catch((err: unknown) => {
        if (alive) setFailed({ key, message: failureMessage(err) });
      });
    return () => {
      alive = false;
    };
  }, [path, key, chosen]);

  const error = failed !== null && failed.key === key ? failed.message : null;
  const busy = loaded?.key !== key && error === null;
  const shown = loaded !== null && error === null && loaded.space === chosen ? loaded : null;
  const data = shown?.data ?? null;
  const metrics = data ? tableMetrics(data.filter.type, data.rows) : [];
  const canSide = picked.length >= COMPARE_LIMITS.sideMin && picked.length <= COMPARE_LIMITS.sideMax;

  const clearPicked = () => {
    setPicked([]);
    setSideIds([]);
  };
  const changeSpace = (next: Space) => {
    // 상품 번호는 공간마다 다르다. 공간을 바꾸면 고른 것을 비운다.
    setSpace(next);
    clearPicked();
  };
  // 거르기를 바꾸면 표의 줄이 바뀐다. 표에 없는 상품이 고른 채로 남지 않게 고른 것을 비운다.
  const hadPicked = picked.length > 0 || sideIds.length > 0;

  return (
    <main className="page wide">
      <h1>비교</h1>
      <ul className={`${styles.why} muted`}>
        <li>
          <strong>왜 되나.</strong> 공급처마다 값을 다르게 적습니다(&ldquo;1주 150&rdquo;, &ldquo;월 600만 원&rdquo;, &ldquo;하루 21만 원&rdquo;). 등록할 때 그것을 한 꼴(일수와
          원)로 정리해 두었기 때문에 같은 잣대로 나란히 놓을 수 있습니다.
        </li>
        <li>
          <strong>지키는 것.</strong> 없는 값을 짐작하지 않고 &ldquo;없음&rdquo;으로 둡니다. 옵션에 없는 기간의 값을 만들지 않습니다. 부가세를 더하거나 빼지 않습니다. AI를 쓰지
          않고, 아무것도 저장하지 않습니다.
        </li>
      </ul>

      <fieldset className={styles.controls}>
        <legend className="sr-only">거르기</legend>
        <div className={styles.line}>
          <label>
            종류{' '}
            <select
              value={type ?? ''}
              onChange={(e) => {
                setType(e.target.value === '' ? null : (e.target.value as ProductType));
                setSubtype(null);
                setSort(null);
                clearPicked();
              }}
            >
              <option value="">전체</option>
              {PRODUCT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            갈래{' '}
            <select value={subtype ?? ''} disabled={type === null} onChange={(e) => {
                setSubtype(e.target.value === '' ? null : e.target.value);
                clearPicked();
              }}
            >
              <option value="">전체</option>
              {(type ? SUBTYPES[type] : []).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            지역 글자{' '}
            <input type="search" value={region} maxLength={COMPARE_LIMITS.regionMaxChars} placeholder="예: 합정"
              size={12}
              onChange={(e) => {
                setRegion(e.target.value);
                clearPicked();
              }}
            />
          </label>
          {type === null ? <span className="muted small">종류를 고르면 그 종류의 잣대가 모두 보입니다.</span> : null}
          <span className="muted small">거르기를 바꾸면 고른 것은 비워집니다.</span>
        </div>
        <div className={styles.line}>
          <span>어느 공간의 상품을 견줄지</span>
          <div className="who" role="group" aria-label="어느 공간의 상품을 견줄지">
            <button type="button" className="seg" aria-pressed={chosen === 'public'} onClick={() => changeSpace('public')}>
              본보기 공간
            </button>
            <button type="button" className="seg" aria-pressed={chosen === 'mine'} disabled={!mounted || !workspace} onClick={() => changeSpace('mine')}>
              내 작업 공간
            </button>
          </div>
          {mounted && !workspace ? <span className="muted small">내 작업 공간은 글을 처음 넣을 때 생깁니다.</span> : null}
        </div>
      </fieldset>

      {error ? <Notice kind="error">{error}</Notice> : null}
      {error && hadPicked ? (
        <div className={styles.bar}>
          <button type="button" className="btn small" onClick={clearPicked}>
            고른 것 비우고 다시 읽기
          </button>
          <span className="muted small">고른 상품을 읽지 못했을 수 있습니다. 비우면 표를 다시 읽습니다.</span>
        </div>
      ) : null}
      {busy ? (
        <p className="muted small" role="status">
          읽는 중…
        </p>
      ) : null}

      {data ? (
        <div className={busy ? styles.stale : undefined} aria-busy={busy}>
          {data.total === 0 ? (
            <Notice>
              견줄 상품이 없습니다.{' '}
              {chosen === 'public' ? (
                <>본보기 공간에 승인된 상품이 아직 없습니다.</>
              ) : (
                <>
                  이 공간에 승인한 상품이 아직 없습니다. <Link href="/inbox">검수함</Link>에서 초안을 승인하면 상품이 됩니다.
                </>
              )}
            </Notice>
          ) : (
            <>
              <p role="status">
                등록된 상품 {data.total}건 가운데 <strong>{data.rows.length}건</strong>
                {data.sort ? (
                  <>
                    {' '}
                    · {compareMetricDef(data.sort.metric).label} {data.sort.order === 'asc' ? '작은 것부터' : '큰 것부터'}
                    {rankScopeText(data.sort)}
                  </>
                ) : (
                  <> · 번호순(잣대 칸의 이름을 누르면 그 잣대로 차례를 매깁니다)</>
                )}
              </p>
              <Warnings warnings={data.warnings} />
              {data.rows.length === 0 ? (
                <Notice>거른 조건에 맞는 상품이 없습니다. 조건을 풀어 보세요.</Notice>
              ) : (
                <CompareTable
                  data={data}
                  metrics={metrics}
                  picked={picked}
                  publicSpace={chosen === 'public'}
                  onSort={(metric) => setSort((current) => nextSort(current, metric))}
                  onPick={(id) => setPicked((current) => togglePick(current, id))}
                />
              )}
              <div className={styles.bar}>
                <button type="button" className="btn primary" disabled={!canSide} onClick={() => setSideIds(picked)}>
                  나란히 보기
                </button>
                <span className="muted small" role="status">
                  고른 것 {picked.length}개 · {COMPARE_LIMITS.sideMin}~{COMPARE_LIMITS.sideMax}개를 고르면 나란히 놓습니다.
                  {picked.length >= COMPARE_LIMITS.sideMax ? ' 넷까지 고를 수 있습니다.' : ''}
                </span>
                {picked.length > 0 ? (
                  <button type="button" className="btn small" onClick={clearPicked}>
                    고른 것 비우기
                  </button>
                ) : null}
              </div>
            </>
          )}
          {data.side ? <SideTable side={data.side} publicSpace={chosen === 'public'} onClose={() => setSideIds([])} /> : null}
        </div>
      ) : null}

      <CompareRules />
    </main>
  );
}

/** 거른 상품의 표. 잣대 칸의 이름을 누르면 그 잣대로 차례를 매긴다. */
export function CompareTable({
  data,
  metrics,
  picked,
  publicSpace,
  onSort,
  onPick,
}: {
  data: CompareResponse;
  metrics: readonly CompareMetric[];
  picked: readonly number[];
  publicSpace: boolean;
  onSort: (metric: CompareMetric) => void;
  onPick: (id: number) => void;
}) {
  const { sort, rows } = data;
  const columns = 3 + (sort ? 1 : 0) + metrics.length;
  const full = picked.length >= COMPARE_LIMITS.sideMax;
  return (
    <div className="table-wrap" tabIndex={0}>
      <table>
        <caption className="sr-only">거른 상품의 견줄 값. 잣대 칸의 이름을 누르면 그 잣대로 차례를 매긴다. 값이 없는 것은 맨 뒤다.</caption>
        <thead>
          <tr>
            <th scope="col" className={styles.pickCell}>
              <span className="sr-only">고르기</span>
            </th>
            {sort ? (
              <th scope="col" title="같은 값은 같은 차례입니다. 놓는 순서는 상품 번호가 작은 것이 앞입니다.">
                차례
              </th>
            ) : null}
            <th scope="col">상품</th>
            <th scope="col">부가세</th>
            {metrics.map((metric) => {
              const def = compareMetricDef(metric);
              const active = sort?.metric === metric;
              return (
                <th key={metric} scope="col" aria-sort={active ? (sort.order === 'asc' ? 'ascending' : 'descending') : undefined}>
                  <button type="button" className={styles.sort} aria-pressed={active} title={def.hint} onClick={() => onSort(metric)}>
                    {def.label}
                    <span aria-hidden="true">{active ? (sort.order === 'asc' ? '▲' : '▼') : ''}</span>
                    {active ? <span className="sr-only">{sort.order === 'asc' ? '작은 것부터' : '큰 것부터'}</span> : null}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const before = rows[index - 1];
            // 종류끼리·부가세가 같은 것끼리 차례를 매겼으면 묶음이 바뀌는 자리에, 그리고 값이 없는 줄이 시작되는 자리에 한 줄을 넣는다.
            const head =
              sort && row.rank === null && (index === 0 || before?.rank !== null)
                ? '값이 없어 차례를 매기지 못한 것'
                : row.rank !== null && (index === 0 || row.rankGroup !== before?.rankGroup || row.rankType !== before?.rankType)
                  ? rankHeadText(row.rankType, row.rankGroup)
                  : null;
            const isPicked = picked.includes(row.productId);
            return (
              <Fragment key={row.productId}>
                {head ? (
                  <tr className={styles.groupRow}>
                    <th scope="colgroup" colSpan={columns}>
                      {head}
                    </th>
                  </tr>
                ) : null}
                <tr>
                  <td className={styles.pickCell}>
                    <input type="checkbox" aria-label={`${row.name} 고르기`} checked={isPicked} disabled={!isPicked && full} onChange={() => onPick(row.productId)} />
                  </td>
                  {sort ? <td>{row.rank ?? <span className={styles.none}>없음</span>}</td> : null}
                  <th scope="row">
                    <Link href={productHref(row.productId, publicSpace)}>{row.name}</Link>
                    <span className="muted small">
                      {TYPE_LABELS[row.type]} · {row.subtype}
                      {row.region ? ` · ${row.region}` : ''}
                    </span>
                  </th>
                  <td className={row.vatIncluded === null ? styles.none : undefined}>{vatText(row.vatIncluded)}</td>
                  {metrics.map((metric) => (
                    <td key={metric}>
                      <ValueCell metric={metric} value={row.values[metric]} extra={otherOptions(row, metric)} />
                    </td>
                  ))}
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
