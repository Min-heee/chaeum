'use client';

// 달력 화면. 기념일(또는 날짜)과 오늘을 고르면 지면마다 언제까지 무엇을 해야 하는지 보여 준다.
// 세는 일은 서버가 한다(GET /api/calendar → src/tools/calendar 의 순수 함수). 이 화면은 고른 값을 보내고, 받은 결과를 되는 것 먼저 놓아 보여 준다.
// 화면이 오늘 날짜를 얻는 곳은 이 파일의 useRealToday 하나뿐이다. 그 값을 요청에 실어 보내므로 서버와 화면이 같은 오늘로 센다.
import Link from 'next/link';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { kstDay } from '@/contract/api';
import { TYPE_LABELS } from '@/contract/fields';
import { ANNIVERSARY_KIND_LABELS, type CalendarItem, type CalendarItemStatus, type CalendarResponse } from '@/contract/tools/calendar';
import { DEADLINE_KIND_LABELS, DEADLINE_RULES, isRealDate, type Deadline } from '@/contract/tools/dates';
import {
  CALENDAR_STATUS_LABELS,
  calendarPath,
  calendarQuery,
  dateText,
  daysLeftText,
  daysUntilText,
  doableFirst,
  isCounting,
  isUsableToday,
  lastDayOfRun,
  monthDayText,
  TODAY_MAX,
  type CalendarBasis,
} from '@/tools/calendar';
import { diffDays } from '@/tools/shared/deadline';
import { Notice } from '../../components/bits';
import { call, failureMessage, productHref, useMounted, useWorkspace } from '../../components/client';
import styles from './calendar.module.css';

type Space = 'public' | 'mine';

const noChange = () => () => {};

/**
 * 화면이 오늘을 얻는 단 한 곳. 이 브라우저의 시계로 본 한국 날짜('YYYY-MM-DD')다.
 * 서버에서 그릴 때와 첫 그리기에서는 모른다(null). 그래서 서버가 그린 글과 브라우저가 그린 글이 어긋나지 않는다.
 */
function useRealToday(): string | null {
  return useSyncExternalStore(
    noChange,
    () => kstDay(new Date()),
    () => null,
  );
}

/** 화면에서 보여 줄 순서와 이름표의 색(전역 스타일의 상태 이름표를 그대로 쓴다). 되는 것이 앞이다. */
const STATUS_ORDER: readonly CalendarItemStatus[] = ['closing', 'open', 'late', 'unknown'];
const STATUS_CLASS: Record<CalendarItemStatus, string> = {
  open: 'status status-APPROVED',
  closing: 'status status-NEEDS_REVIEW',
  late: 'status status-FAILED',
  unknown: 'status',
};

function DeadlineLine({ deadline }: { deadline: Deadline }) {
  const tone = deadline.status === 'late' ? styles.lateText : deadline.status === 'closing' ? styles.closingText : undefined;
  return (
    <li>
      <strong>{DEADLINE_KIND_LABELS[deadline.kind]}</strong> {dateText(deadline.date)}까지 · <span className={tone}>{daysLeftText(deadline.daysLeft)}</span>{' '}
      <span className="muted small">({deadline.days === 0 ? '기준일 당일까지' : `기준일 ${deadline.days}일 전까지`})</span>
    </li>
  );
}

function ItemRow({ item, publicSpace }: { item: CalendarItem; publicSpace: boolean }) {
  return (
    <tr>
      <th scope="row">
        <Link href={productHref(item.productId, publicSpace)}>{item.name}</Link>
        <span className="muted small">
          {TYPE_LABELS[item.type]} · {item.subtype}
        </span>
      </th>
      <td>
        <span className={STATUS_CLASS[item.status]}>{CALENDAR_STATUS_LABELS[item.status]}</span>
        {item.daysLeft !== null ? <div className="small">{daysLeftText(item.daysLeft)}</div> : null}
      </td>
      <td>
        <ul className={styles.todo}>
          {item.deadlines.map((d) => (
            <DeadlineLine key={d.kind} deadline={d} />
          ))}
          {item.missing.map((kind) => (
            <li key={kind} className="muted">
              {(DEADLINE_KIND_LABELS as Record<string, string>)[kind] ?? kind} 일수가 상품에 적혀 있지 않아 세지 못했습니다.
            </li>
          ))}
        </ul>
      </td>
    </tr>
  );
}

/** 기준일 하나에 대한 결과: 한 줄 요약, 상태별 수, 지면별 표(되는 것 먼저). */
export function CalendarResult({ data, eventDate, space }: { data: CalendarResponse; eventDate: string; space: Space }) {
  const { anniversary, counts, today } = data;
  const untilEvent = diffDays(today, eventDate);
  const fromToday =
    untilEvent === 0
      ? `기준일이 오늘(${dateText(today)})입니다`
      : untilEvent > 0
        ? `오늘(${dateText(today)})부터 ${untilEvent}일 뒤`
        : `오늘(${dateText(today)})보다 ${-untilEvent}일 앞`;
  const items = doableFirst(data.items);
  const doable = counts.open + counts.closing;
  const movedFromFeb29 = anniversary !== null && anniversary.month === 2 && anniversary.day === 29 && eventDate.endsWith('-02-28');

  return (
    <section className="export" aria-label="마감 거꾸로 세기 결과">
      <h2>
        {dateText(eventDate)}에 맞추려면{' '}
        <span className="count">
          {anniversary ? `${anniversary.artist} ${ANNIVERSARY_KIND_LABELS[anniversary.kind]} · ` : ''}
          {fromToday}
        </span>
      </h2>
      {movedFromFeb29 ? (
        <p className="muted small">
          이 기념일은 2월 29일인데 {eventDate.slice(0, 4)}년에는 2월 29일이 없습니다. 그래서 2월 28일을 기준일로 셉니다.
        </p>
      ) : null}
      {untilEvent < 0 ? (
        <Notice kind="warn">
          기준일이 이미 지난 날짜입니다. 마감 일수가 적힌 지면은 모두 &ldquo;{CALENDAR_STATUS_LABELS.late}&rdquo;으로 나옵니다.
        </Notice>
      ) : null}

      {items.length === 0 ? (
        <Notice>
          셀 지면이 없습니다.{' '}
          {space === 'public' ? (
            <>
              본보기 공간에 승인된 상품이 아직 없습니다. 내 작업 공간에 승인한 상품이 있으면 위에서 &ldquo;내 작업 공간&rdquo;을 골라 셀 수 있습니다. 없으면{' '}
              <Link href="/">작업 화면</Link>에서 글을 넣고 <Link href="/inbox">검수함</Link>에서 승인하면 상품이 됩니다.
            </>
          ) : (
            <>
              이 공간에 승인한 상품이 아직 없습니다. <Link href="/inbox">검수함</Link>에서 초안을 승인하면 상품이 됩니다.
            </>
          )}
        </Notice>
      ) : (
        <>
          <p role="status">
            지면·상품 {items.length}곳 가운데 <strong>지금 마감을 맞출 수 있는 곳은 {doable}곳</strong>입니다.
          </p>
          <ul className={styles.counts} aria-label="상태별 수">
            {STATUS_ORDER.map((status) => (
              <li key={status}>
                <span className={STATUS_CLASS[status]}>{CALENDAR_STATUS_LABELS[status]}</span> {counts[status] ?? 0}곳
              </li>
            ))}
          </ul>
          <div className="table-wrap" tabIndex={0}>
            <table>
              <caption className="sr-only">지면별 마감. 되는 것이 먼저, 그 안에서는 마감이 가까운 것이 먼저다.</caption>
              <thead>
                <tr>
                  <th scope="col">지면·상품</th>
                  <th scope="col">상태</th>
                  <th scope="col">언제까지 무엇을</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <ItemRow key={item.productId} item={item} publicSpace={space === 'public'} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            되는 지면이 먼저, 그 안에서는 마감이 가까운 것이 먼저입니다. 그다음이 이미 늦은 지면(방금 놓친 것부터), 끝이 마감 일수가 없어 세지 못한 지면입니다.
          </p>
        </>
      )}
    </section>
  );
}

/** 세는 방법과 하지 않는 일. 기준(며칠부터 "곧 마감"인가, 기간 옵션을 어떻게 보는가)을 숨기지 않고 적는다. */
export function CalendarRules({ eventDate }: { eventDate: string | null }) {
  const within = DEADLINE_RULES.closingWithinDays;
  // 보기 문장은 고른 기준일로 적는다. 끝 날이 다룰 수 있는 날짜(2200년까지)를 넘으면 적지 않는다.
  const lastDay = eventDate ? lastDayOfRun(eventDate, 7) : null;
  const example = eventDate && lastDay && isRealDate(lastDay) ? ` 예: 7일 옵션이면 ${dateText(eventDate)}부터 ${dateText(lastDay)}까지 걸립니다.` : '';
  return (
    <section aria-label="세는 방법">
      <h2>세는 방법</h2>
      <ul className={styles.rules}>
        <li>
          <strong>마감일 = 기준일 − 상품에 적힌 일수.</strong> &ldquo;7일 전까지&rdquo;면 기준일의 7일 전 날짜가 마감일이고, 그날까지는 됩니다. 남은 날 = 마감일 − 오늘.
          일수는 등록할 때 채운 칸(예약 마감, 소재 마감, 시안 마감, 제작 기간)을 그대로 읽습니다.
        </li>
        <li>
          <strong>상태.</strong> 마감일이 지났으면 &ldquo;{CALENDAR_STATUS_LABELS.late}&rdquo;, 남은 날이 0~{within}일이면 &ldquo;{CALENDAR_STATUS_LABELS.closing}&rdquo;(마감
          당일 포함), 그보다 많이 남았으면 &ldquo;{CALENDAR_STATUS_LABELS.open}&rdquo;입니다. {within}일이라는 기준은 재서 정한 값이 아니라 임의로 둔 값입니다. 마감이 둘인
          지면(예약·소재)은 하나라도 지났으면 &ldquo;{CALENDAR_STATUS_LABELS.late}&rdquo;입니다.
        </li>
        <li>
          <strong>기간 옵션(7일, 30일 등)이 있는 광고 지면.</strong> 기준일에 게재를 시작한다고 봅니다. 기념일이 게재 기간의 첫날로 들어갑니다.
          {example} 기념일보다 앞서 걸고 싶으면(그 주
          월요일부터 등) &ldquo;날짜 직접 넣기&rdquo;에 게재를 시작할 날을 넣으세요. 앞당긴 날 수만큼 마감도 앞당겨집니다.
        </li>
        <li>
          <strong>케이터링과 굿즈.</strong> 케이터링은 기준일을 행사일로 보고 시안 마감을 셉니다. 굿즈는 기준일까지 다 만들어져야 한다고 보고 제작 기간만큼 앞선 날을
          주문 마감으로 셉니다. 배송에 걸리는 날은 적힌 칸이 없어 세지 않습니다.
        </li>
        <li>
          <strong>2월 29일 기념일.</strong> 2월 29일이 없는 해에는 2월 28일로 셉니다.
        </li>
        <li>
          <strong>하지 않는 것.</strong> 휴일과 영업일을 따지지 않습니다(달력 날짜로만 셉니다). 그 날짜에 지면이 비어 있는지는 모릅니다. 일수가 적혀 있지 않은 마감은
          짐작하지 않고 &ldquo;{CALENDAR_STATUS_LABELS.unknown}&rdquo;으로 둡니다. 결과를 저장하지 않습니다.
        </li>
      </ul>
    </section>
  );
}

export function CalendarTool() {
  const mounted = useMounted();
  const workspace = useWorkspace();
  const realToday = useRealToday();

  const [basis, setBasis] = useState<CalendarBasis>('anniversary');
  const [anniversaryId, setAnniversaryId] = useState<string | null>(null);
  const [dateInput, setDateInput] = useState('');
  // null 이면 실제 오늘을 따른다. 날짜를 넣으면 그 날을 오늘로 보고 센다.
  const [todayInput, setTodayInput] = useState<string | null>(null);
  const [space, setSpace] = useState<Space>('public');
  const [loaded, setLoaded] = useState<{ key: string; space: Space; data: CalendarResponse } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);

  // 내 작업 공간이 아직 없으면 볼 수 있는 것은 본보기 공간뿐이다.
  const chosen: Space = workspace && space === 'mine' ? 'mine' : 'public';
  const today = todayInput ?? realToday;
  const todayOk = isUsableToday(today);
  const dateOk = isRealDate(dateInput);

  // 보낼 요청은 순수 함수가 정한다. 오늘을 모르면 보내지 않고, 기준일을 아직 못 정했으면(첫 화면, 날짜를 안 넣음) 기념일 목록만 받는다.
  const query = calendarQuery({ basis, anniversaryId, date: dateInput, today });
  const path = query === null ? null : calendarPath(query);
  const counting = query !== null && isCounting(query);
  const key = path === null ? null : `${chosen} ${path}`;

  useEffect(() => {
    if (path === null || key === null) return;
    let alive = true;
    call<CalendarResponse>('GET', path, {
      publicSpace: chosen === 'public',
      // 마감을 센 요청만 API 탭에 남긴다(목록만 받은 요청은 남기지 않는다).
      label: counting ? `달력 (${chosen === 'public' ? '본보기 공간' : '내 작업 공간'})` : undefined,
    })
      .then((data) => {
        if (!alive) return;
        setLoaded({ key, space: chosen, data });
        setFailed(null);
        // 처음에는 가장 가까운 기념일을 골라 둔다. 그 뒤로는 고른 것을 그대로 둔다.
        setAnniversaryId((current) => current ?? data.anniversaries[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        if (alive) setFailed({ key, message: failureMessage(err) });
      });
    return () => {
      alive = false;
    };
  }, [path, key, chosen, counting]);

  const error = failed !== null && failed.key === key ? failed.message : null;
  const busy = key !== null && loaded?.key !== key && error === null;
  // 기념일 목록은 마지막으로 받은 것을 쓴다. 표는 지금 고른 값으로 센 것만 보여 준다(다시 세는 동안에는 앞의 표를 흐리게 둔다).
  const anniversaries = loaded?.data.anniversaries ?? null;
  const shown = loaded !== null && error === null && key !== null ? loaded : null;
  const picked = anniversaries?.find((a) => a.id === anniversaryId) ?? null;

  return (
    <main className="page">
      <h1>달력</h1>
      <p className="muted">
        기념일에 맞추려면 지면마다 언제까지 예약하고 언제까지 소재를 보내야 하는지 거꾸로 셉니다. <strong>AI를 쓰지 않습니다.</strong> 날짜는 코드가 셉니다. 등록할 때
        채운 마감 일수 칸을 그대로 읽고, 아무것도 저장하지 않습니다. 기념일 목록의 가수와 그룹은 모두 지어낸 이름입니다.
      </p>

      <fieldset className={styles.controls}>
        <legend className="sr-only">기준일과 오늘 고르기</legend>

        <div className={styles.line}>
          <label className="check">
            <input type="radio" name="calendar-basis" checked={basis === 'anniversary'} onChange={() => setBasis('anniversary')} /> 기념일에서 고르기
          </label>
          <select
            aria-label="기념일"
            value={anniversaryId ?? ''}
            disabled={anniversaries === null}
            onChange={(e) => {
              setAnniversaryId(e.target.value);
              setBasis('anniversary');
            }}
          >
            {anniversaryId === null ? <option value="">불러오는 중…</option> : null}
            {(anniversaries ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.artist} {ANNIVERSARY_KIND_LABELS[a.kind]} · {monthDayText(a.month, a.day)} ({daysUntilText(a.daysUntil)})
              </option>
            ))}
          </select>
          {basis === 'anniversary' && picked ? <span className="muted small">다음에 오는 날: {dateText(picked.next)}</span> : null}
        </div>

        <div className={styles.line}>
          <label className="check">
            <input type="radio" name="calendar-basis" checked={basis === 'date'} onChange={() => setBasis('date')} /> 날짜 직접 넣기
          </label>
          <input
            type="date"
            aria-label="기준일"
            value={dateInput}
            min="1900-01-01"
            max="2200-12-31"
            onChange={(e) => {
              setDateInput(e.target.value);
              setBasis('date');
            }}
          />
          {basis === 'date' && !dateOk ? (
            <span className={dateInput === '' ? 'muted small' : 'problem'}>
              {dateInput === '' ? '날짜를 넣으면 그 날을 기준일로 셉니다.' : '1900년부터 2200년 사이의 날짜만 셉니다.'}
            </span>
          ) : null}
        </div>

        <div className={styles.line}>
          <label>
            오늘 날짜{' '}
            <input
              type="date"
              value={today ?? ''}
              min="1900-01-01"
              max={TODAY_MAX}
              disabled={!mounted}
              onChange={(e) => setTodayInput(e.target.value === '' || e.target.value === realToday ? null : e.target.value)}
            />
          </label>
          <button type="button" className="btn small" disabled={todayInput === null} onClick={() => setTodayInput(null)}>
            실제 오늘로
          </button>
          {today !== null && !todayOk ? (
            <span className="problem">오늘 날짜는 1900년부터 {TODAY_MAX.slice(0, 4)}년 사이만 셉니다.</span>
          ) : todayInput !== null ? (
            <span className="flag-line small">바꿔 본 날짜로 세는 중입니다.{isUsableToday(realToday) ? ` 실제 오늘은 ${dateText(realToday)}입니다.` : ''}</span>
          ) : (
            <span className="muted small">이 브라우저의 시계로 본 한국 날짜입니다. 다른 날로 바꿔 볼 수 있습니다.</span>
          )}
        </div>

        <div className={styles.line}>
          <span>어느 공간의 상품으로 셀지</span>
          <div className="who" role="group" aria-label="어느 공간의 상품으로 셀지">
            <button type="button" className="seg" aria-pressed={chosen === 'public'} onClick={() => setSpace('public')}>
              본보기 공간
            </button>
            <button type="button" className="seg" aria-pressed={chosen === 'mine'} disabled={!mounted || !workspace} onClick={() => setSpace('mine')}>
              내 작업 공간
            </button>
          </div>
          {mounted && !workspace ? <span className="muted small">내 작업 공간은 글을 처음 넣을 때 생깁니다.</span> : null}
        </div>
      </fieldset>

      {error ? <Notice kind="error">{error}</Notice> : null}
      {busy ? (
        <p className="muted small" role="status">
          세는 중…
        </p>
      ) : null}
      {shown && shown.data.eventDate ? (
        <div className={busy ? styles.stale : undefined} aria-busy={busy}>
          <CalendarResult data={shown.data} eventDate={shown.data.eventDate} space={shown.space} />
        </div>
      ) : null}

      <CalendarRules eventDate={shown?.data.eventDate ?? null} />
    </main>
  );
}
