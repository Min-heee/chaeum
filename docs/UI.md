# 화면 만드는 법 (UI 바탕)

실무자가 하루 종일 쓰는 관리 화면이다. 꾸밈 없이 굵기·크기·옅은 바탕으로만 위계를 만든다.
스타일은 `app/globals.css` 한 장과 화면별 `*.module.css` 뿐이다. 부품은 `components/bits.tsx` 와 `components/ListParts.tsx` 에 있다.

## 기준값 (globals.css 맨 위의 변수. 값을 직접 적지 말고 변수를 쓴다)

- 색: 바탕 `--bg`, 옅은 바탕 `--bg-soft`(표 머리), 판 `--panel`, 글 `--fg` / `--fg-soft` / `--muted`(보조 글),
  선 `--line` / `--line-strong`(버튼) / `--line-input`(입력), 강조 `--accent` · `--accent-hover` · `--accent-soft`, 채운 색 위의 글자 `--on-accent`,
  확인할 칸 `--flag` · `--flag-line` · `--flag-fg`(노랑은 "사람이 봐야 한다"는 뜻으로만), 좋음 `--ok` · `--ok-soft`, 위험 `--danger` · `--danger-soft`,
  표 줄 hover `--row-hover`, 코드 상자 `--code-bg`.
- 글자: 본문 14px(`--fs-md`), 보조 13px(`--fs-sm`, 클래스 `.small`), 가장 작은 글자 12px(`--fs-xs`). 12px 아래는 없다.
  제목은 h1 20px(화면에 하나) → h2 16px(구역. 판 제목 `.panel-title` · `.pane-title` 도 16px) → h3 14px → h4 13px. 차례를 건너뛰지 않는다.
- 간격: `--s1` 4 · `--s2` 8 · `--s3` 12 · `--s4` 16 · `--s5` 24 · `--s6` 32. 모서리: `--r-sm` 4 · `--r` 6 · `--r-lg` 8. 입력·버튼 높이 36px.

## 틀

- 왼쪽 옆 메뉴(224px, `components/TopBar.tsx`) + 본문. 맨 위에 알림 띠("데모")가 한 줄 있다. 둘 다 `app/layout.tsx` 가 깐다. 화면에서 다시 그리지 않는다.
- 화면은 `<main className="page">`(보통 너비: 양식·읽는 화면) 또는 `<main className="page wide">`(넓게: 작업 화면·목록·넓은 표)로 시작한다.
- 경계는 둘이다. **1080px 아래**: 옆 메뉴가 위쪽 한 줄 머리(48px, 화면에 붙음)와 "메뉴" 버튼으로 접힌다(본문이 넓어져 두 칸 `.split` 은 그대로 선다).
  **900px 아래**: 두 칸이 위아래로 서고, 작은 버튼·조각 버튼·접는 줄이 손가락으로 누르기 좋게 40px 로 커진다. 390px 에서 가로로 넘치면 안 된다.
- 화면에 붙이는(sticky) 것은 `top: calc(var(--head-h) + 12px)` 처럼 `--head-h`(머리 높이. 넓으면 0)를 더한다.
- 키보드 초점과 `#주소` 이동은 전역의 `scroll-padding` 이 머리와 막대를 피해 준다. 아래에 붙는 막대에는 `data-dock` 을 붙인다(그 화면에서 아래 여백이 생긴다).

## 부품 (components/bits.tsx)

- `PageHead` — 화면 머리. 모든 화면의 첫 줄이다. 제목 줄 오른쪽에 행동이 서고, 한 줄 설명은 그 아래에 온다.
  `<PageHead title="검수함" lead="한 줄 설명" actions={<button className="btn">새로 고침</button>} about={<>긴 설명</>} crumb={<Link href="/inbox">← 검수함</Link>} />`
  `about` 은 기본으로 닫힌 "이 화면 설명" 안에 들어간다. 긴 설명은 글자 그대로 옮긴다(줄이지 않는다).
- `Steps` — 단계 줄. `<Steps label="일하는 차례" items={[{ n: 1, label: '글 넣기', state: 'done' }, { n: 2, label: '승인', note: '검수함', state: 'now', href: '/inbox' }]} />`
  state: `done`(체크) · `now`(파랑, aria-current) · `todo` · `warn`(노란 느낌표: 살펴야 함). href 가 `#…` 이면 화면 안, `/…` 이면 다른 화면으로 간다.
- `Badge` — 옅은 바탕의 작은 상태 표. tone: `neutral`(기본) · `info` · `ok` · `warn` · `danger`. 초안 상태는 `StatusBadge`, 확인할 까닭은 `ReasonChips` / `ReasonList`(노란 딱지 `.flag`).
- `Notice` — 알림 상자. kind: `info`(기본) · `ok` · `warn` · `error`(바로 읽어 준다).
- `EmptyState` — 빈 상태. `<EmptyState title="아직 넣은 글이 없습니다" action={<Link className="btn primary" href="/">작업 화면으로</Link>}>한 줄 설명</EmptyState>`
- `Loading` — 읽는 중. `<Loading />`(판 꼴, 줄 3개) · `<Loading label="칸을 채우는 중입니다…" lines={0} />`(버튼 옆 한 줄). 글자는 그대로 읽힌다(role="status").
- `Stats` — 요약 숫자 줄. `<Stats items={[{ label: '확인 필요', value: '5건', tone: 'warn' }, { label: '승인됨', value: '7건', note: '본보기 공간' }]} />`
- `Toolbar` — 거르기와 버튼을 한 줄에. `<Toolbar label="거르기" end={<button className="btn small">내려받기</button>}><label>종류 <select>…</select></label></Toolbar>`
- 전부터 있던 것: `CopyButton`, `RouteBanner`(어떤 길로 뽑혔는지 한 줄 띠), `LocalRunHelp`.

## 목록 부품 (components/ListParts.tsx) 과 공간

- `SpaceTabs` + `SpacePanel` — "내 작업 공간 / 본보기 공간 (읽기 전용)" 탭(화살표 키로 옮긴다). 검수함·상품·모으기가 쓴다. 고른 공간은 주소의 `?space=` 에 둔다(`setQuery` / `useQuery`, `components/client.ts`).
- `StatFilter` — 요약 숫자이면서 거르는 버튼(고른 칸에 파란 밑줄). `useRowOpen` — 표의 줄 전체를 눌러 그 건으로 가기(키보드는 이름 링크).
- `useStackBelow(너비)` — 표 싸개의 ref. 싸개가 그 너비보다 좁아지면 `data-stacked` 를 붙인다. 싸개에 `.stack` 을 함께 붙이면 전역 꼴로 줄 하나가 한 덩이로 쌓인다
  (칸 이름은 td 의 `data-label`, 오른쪽에 둘 표시는 `.stack-end`, 표로 읽히게 role 을 적는다). 화면 너비가 아니라 표가 놓인 자리의 너비를 본다.
- 도구 화면(견적·시안 검사·달력·비교·점검)의 공간은 `useToolSpace()` / `setToolSpace()`(`components/space.ts`)로 정한다: 고른 적이 있으면 그것(이 탭에서 남는다),
  없으면 내 작업 공간에 상품이 있을 때 내 작업 공간, 아니면 본보기 공간. 조각 버튼의 차례는 "내 작업 공간 | 본보기 공간"이다.

## 클래스

- 버튼 `.btn`(보조, 테두리) · `.btn primary`(주요, 채운 파랑. 한 구역에 하나. **채운 파랑은 이것만 쓴다**) · `.btn ghost`(조용한 것, 글자만) · `.btn danger`(위험).
  크기 `.small`(32px) · 기본(36px) · `.big`(40px. 작업 화면의 "초안 만들기" 한 곳). 켜고 끄는 버튼은 `aria-pressed`. 링크도 `className="btn"` 이면 같은 꼴이다.
- 입력: `.page` / `.pane` 안의 input · select · textarea 는 클래스 없이 같은 꼴이다. 라벨은 위에: `<label className="stack">이름<input /></label>`.
  여러 개를 나란히: `.form-grid` 안에 `.stack`. 도움 글 `.hint`, 체크 `.check`, 넓은 입력 `input.wide`. textarea 의 높이는 모듈에서 클래스 둘(`.판 .칸`)로 적어야 이긴다.
- 판 `.panel`(+ `.panel-title`) — 1px 테두리, 모서리 8px, 그림자 없음. 작업 화면의 두 칸은 `.split` 안에 `.pane`.
- 표: `<div className="table-wrap" tabIndex={0} role="region" aria-label="… 표"><table>…</table></div>`. 숫자 칸은 th·td 에 `.num`(오른쪽 정렬, 자릿수 맞춤),
  번호·버튼 같은 좁은 칸은 `.tight`(`num tight` 를 함께 붙이면 숫자 칸이 내용만큼만 좁아진다). 고른 줄은 `tr.is-picked`. 판 안의 표는 `.table-wrap.flush`(판의 양 끝까지).
  표는 싸개 안에서만 가로로 밀린다. 묶음마다 tbody 를 따로 써도 묶음 사이의 선은 남는다. 좁은 표 머리가 한 글자씩 서면 머리 칸에 `white-space: nowrap` 을 준다.
- 탭 `.tabs > .tab`(밑줄 탭) · 조각 버튼 `.segmented > .seg`(`.who` 와 같다. 고른 것은 `aria-pressed="true"`, 옅은 파랑 + 파란 밑줄).
- 줄 맞춤: `.actions`(버튼 줄) · `.toolbar` · `.head`(제목 + 오른쪽 버튼) · `.pair` · `.rows`. 접는 도움말 `details.help`. 코드 `pre.code`.
- 글: `.muted`(보조 글) · `.small`(13px) · `.ok-line` · `.flag-line` · `.problem`(오류 글). 화면에만 안 보이게: `.sr-only`.

## 화면을 짤 때

1. `PageHead`(제목 + 한 줄 + 주요 행동) → 요약 숫자(`Stats`) → 도구 막대(`Toolbar`) → 표나 판. "지금 할 일"이 가장 눈에 띄게 한다.
2. 끝낸 뒤의 다음 일을 그 자리에 둔다(승인 뒤 "다음 초안 열기" · "새 글 넣기", 확정 뒤 "새 문의 받기"). 누른 결과는 누른 자리 가까이에 글로 알린다(role="status").
3. 긴 화면의 결정 버튼은 아래에 붙는 막대에 모은다: 판 안에서 `position: sticky; bottom: 0`, 판의 안쪽 여백만큼 음수 마진, 위 테두리, `data-dock`
   (`components/DraftPanel.module.css` 의 `.dock`). 키보드로는 "…로 건너뛰기" 지름길을 판 머리에 둔다.
4. 숫자나 결과 바로 옆의 경고·단서는 접지 않고 그 자리에 둔다(`Notice kind="warn"`, `.flag`). 접어도 되는 것은 화면 머리의 긴 설명뿐이다.
5. 없는 값은 "없음"으로 적는다. 합성 자료·규칙만·사람이 확인하지 않음 같은 문장은 지우지 않는다. 같은 문장이 줄마다 되풀이되면 판 머리에 한 번 적고 줄에는 표만 둔다.

## 하지 말 것

- 새 라이브러리, 아이콘 묶음, 글꼴 주소, 그라데이션, 그림자, 장식 그림, 이모지.
- 색·크기·간격을 숫자로 직접 쓰기(변수를 쓴다). 12px 보다 작은 글자. 옅은 회색 글자(`--muted` 보다 옅게 쓰지 않는다. 대비 4.5:1).
- 인라인 `style` 로 꾸미기. 화면에만 필요한 스타일은 그 화면의 `*.module.css` 에 두고, 전역 클래스 이름과 겹치지 않게 한다.
- 메뉴 이름·주소·주요 버튼 글자 바꾸기, 있던 버튼·입력·링크·표시 빼기, 초점 테두리 지우기(`outline: none`).
- 좁은 화면에서 페이지 전체가 가로로 밀리게 두기. 넓은 것은 `.table-wrap` 처럼 그 안에서만 밀리게 한다.
