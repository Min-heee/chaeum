'use client';

// API 탭. 화면에서 방금 누른 것과 같은 일을 하는 curl 을 작업 공간 번호까지 채워 보여 준다.
import { WORKSPACE_HEADER } from '@/contract/api';
import { CopyButton } from './bits';
import { clearCalls, useCalls, useMounted, useOrigin, useWorkspace, type CallRecord } from './client';
import { formatTime } from './format';

/** 셸의 작은따옴표 안에 넣을 수 있게 바꾼다. */
const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** 작업 공간과 상관없는 경로. 공간 헤더를 싣지 않는다. */
const SPACELESS = /^\/api\/(jobs\/drain|eval\/|health|samples)/;

interface Example {
  method: string;
  path: string;
  body?: unknown;
  fileName?: string;
  /** 파일과 함께 싣는 글자 칸 */
  fields?: Record<string, string>;
  /** 공간 헤더를 싣지 않는다(본보기 공간 읽기, 공간과 상관없는 경로) */
  noWorkspace?: boolean;
  /** 응답을 파일로 받는다 */
  output?: string;
}

function curl(origin: string, workspace: string | null, e: Example): string {
  const lines = [`curl -sS${e.method === 'GET' ? '' : ` -X ${e.method}`} ${quote(`${origin}${e.path}`)}`];
  if (workspace && !e.noWorkspace && !SPACELESS.test(e.path)) lines.push(`  -H ${quote(`${WORKSPACE_HEADER}: ${workspace}`)}`);
  if (e.fileName !== undefined) {
    for (const [name, value] of Object.entries(e.fields ?? {})) lines.push(`  -F ${quote(`${name}=${value}`)}`);
    lines.push(`  -F ${quote(`file=@${e.fileName}`)}`);
  }
  else if (e.body !== undefined) {
    lines.push(`  -H 'Content-Type: application/json'`);
    lines.push(`  -d ${quote(JSON.stringify(e.body))}`);
  }
  if (e.output) lines.push(`  -o ${quote(e.output)}`);
  return lines.join(' \\\n');
}

function Snippet({ title, note, code }: { title: string; note?: string; code: string }) {
  return (
    <li className="card">
      <div className="head">
        <strong>{title}</strong>
        <CopyButton text={code} label="curl 복사" />
      </div>
      {note ? <p className="muted small">{note}</p> : null}
      <pre className="code" tabIndex={0}>{code}</pre>
    </li>
  );
}

function fromCall(c: CallRecord): Example {
  const output = c.path.startsWith('/api/export.csv') ? 'export.csv' : c.path.startsWith('/api/export.xlsx') ? 'products.xlsx' : undefined;
  return { method: c.method, path: c.path, body: c.body, fileName: c.fileName, fields: c.fields, noWorkspace: c.publicSpace, output };
}

export function ApiGuide() {
  const mounted = useMounted();
  const origin = useOrigin();
  const workspace = useWorkspace();
  const calls = useCalls();

  // 방금 다룬 초안 번호가 있으면 보기에 채워 넣는다.
  const lastDraft = calls.map((c) => /^\/api\/drafts\/(\d+)/.exec(c.path)?.[1]).find(Boolean) ?? '<초안 번호>';

  const reference: { title: string; note?: string; example: Example }[] = [
    { title: '글 한 건 접수', note: '새 글이면 201, 같은 글이면 200. 응답의 draftId 가 초안 번호입니다.', example: { method: 'POST', path: '/api/source-docs', body: { text: '홍대입구역 9번 출구 전광판 단가 안내. 1주 150만원(VAT별도), 운영 05시~25시.' } } },
    { title: '여러 건 접수 (50건까지)', note: '한 건이 틀려도 나머지는 들어갑니다(202).', example: { method: 'POST', path: '/api/source-docs/bulk', body: { texts: ['첫 번째 글', '두 번째 글'] } } },
    { title: '그림·PDF 올리기', note: '요청 안에서 모델이 글로 옮깁니다. 파일은 저장하지 않습니다. 실제 호출이 닫혀 있으면 503 입니다.', example: { method: 'POST', path: '/api/source-files', fileName: '단가표.png' } },
    { title: '줄 굴리기', note: '이 사이트에는 따로 도는 작업자가 없습니다. remaining 이 0 이 될 때까지 부릅니다.', example: { method: 'POST', path: '/api/jobs/drain', noWorkspace: true } },
    { title: '검수함 (확인 필요)', example: { method: 'GET', path: '/api/drafts?status=NEEDS_REVIEW' } },
    { title: '초안 상세', note: '칸마다 값, 원문 표현, 근거 구절, 사유가 들어 있습니다.', example: { method: 'GET', path: `/api/drafts/${lastDraft}` } },
    { title: '칸 고치기', note: 'version 은 초안 상세의 version 입니다. 낡은 값이면 409 가 옵니다.', example: { method: 'PATCH', path: `/api/drafts/${lastDraft}/fields`, body: { version: 1, edits: { price_krw: 1500000 }, actor: 'admin' } } },
    { title: '승인', example: { method: 'POST', path: `/api/drafts/${lastDraft}/approve`, body: { version: 2 } } },
    { title: '반려 (사유 코드가 꼭 있어야 합니다)', example: { method: 'POST', path: `/api/drafts/${lastDraft}/reject`, body: { version: 2, reasonCode: 'NOT_ENOUGH_INFO', memo: '값이 없습니다' } } },
    { title: '다시 돌리기 (실패·반려된 초안)', example: { method: 'POST', path: `/api/drafts/${lastDraft}/reprocess`, body: { version: 3 } } },
    { title: '상품 목록', example: { method: 'GET', path: '/api/products' } },
    { title: '양식으로 내려받기', note: 'template 을 바꾸면 다른 양식 꼴로 나옵니다(default, ad-board).', example: { method: 'GET', path: '/api/export.csv?kind=products&template=default', output: 'products.csv' } },
    {
      title: '번역 검사',
      note: '이미 번역된 제목·요약을 넣으면 글 검사 결과를 돌려줍니다. 모델을 부르지 않고 저장하지 않습니다.',
      example: {
        method: 'POST',
        path: '/api/content-checks',
        noWorkspace: true,
        body: { items: [{ lang: 'en', field: 'title', text: 'Sure! Here is the title: LED billboard 전광판', sourceKo: '전광판 광고', allowedNumbers: ['7'] }] },
      },
    },
    { title: '평가 실행 목록', example: { method: 'GET', path: '/api/eval/runs', noWorkspace: true } },
    { title: '보기 글 목록', example: { method: 'GET', path: '/api/samples', noWorkspace: true } },
    { title: '살아 있는지', note: 'DB 연결, 줄 길이, 오늘 남은 실제 호출 수.', example: { method: 'GET', path: '/api/health', noWorkspace: true } },
  ];

  // 딸린 도구의 경로(19~32번). 약속은 src/contract/tools 에 있다.
  const tools: { title: string; note?: string; example: Example }[] = [
    { title: '점검: 등록된 상품 전체', note: '구조 규칙과 글 검사를 한 번에 돌립니다. 저장하지 않습니다. 헤더를 빼면 본보기 공간을 살핍니다. ?format=csv 를 붙이면 CSV 로 받습니다.', example: { method: 'POST', path: '/api/audits', body: { source: 'workspace' } } },
    { title: '점검: 양식 꼴 CSV·XLSX 파일', note: '내려받은 파일을 그대로 올려 볼 수 있습니다(1MB, 500줄까지).', example: { method: 'POST', path: '/api/audits', fileName: 'products.csv' } },
    { title: '용어 목록', note: '공용 줄(본보기 공간)과 내 작업 공간의 줄이 함께 옵니다.', example: { method: 'GET', path: '/api/glossary' } },
    { title: '용어 더하기', note: '제안 상태로 들어갑니다. 같은 낱말이 이미 있으면 409 입니다.', example: { method: 'POST', path: '/api/glossary', body: { ko: '키링', en: 'keyring' } } },
    { title: '용어 고치기·승인', note: '승인하려면 영어와 중국어(간체) 표기가 모두 있어야 합니다. 공용 줄은 고칠 수 없습니다(403).', example: { method: 'PATCH', path: '/api/glossary/<용어 번호>', body: { status: 'approved' } } },
    {
      title: '문의 글 → 견적',
      note: "catalog 를 'public' 으로 주면 본보기 공간의 상품을 살핍니다(견적은 내 작업 공간에 저장됩니다). 조건 뽑기 모델을 못 부르면 503 입니다.",
      example: { method: 'POST', path: '/api/quotes', body: { text: '강남역 지하철 광고 한 달 하면 얼마인가요? 12월에 걸고 싶습니다.', catalog: 'public' } },
    },
    { title: '견적 한 건', example: { method: 'GET', path: '/api/quotes/<견적 번호>' } },
    { title: '답장 확정', note: '표에 적는 것까지입니다. 어디로도 보내지 않습니다. 두 번째 확정은 422 입니다.', example: { method: 'POST', path: '/api/quotes/<견적 번호>/confirm', body: { reply: '사람이 읽고 고친 답장 글' } } },
    { title: '시안 검사: 파일 올리기', note: '4MB 까지. 파일도 결과도 저장하지 않습니다. 헤더를 빼면 본보기 공간의 상품과 견줍니다.', example: { method: 'POST', path: '/api/creative-checks', fileName: '시안.mp4', fields: { productId: '<상품 번호>' } } },
    {
      title: '시안 검사: 읽은 값만 보내기',
      note: '큰 영상은 파일을 보내지 않고 읽은 값만 보냅니다. 이때 서버는 파일을 보지 못합니다(응답의 readBy 가 client).',
      example: { method: 'POST', path: '/api/creative-checks', body: { productId: 1, facts: { format: 'mp4', width: 1080, height: 1920, sizeBytes: 30000000, durationSeconds: 20 } } },
    },
    { title: '달력: 마감 거꾸로 세기', note: 'anniversary 대신 date=2027-05-01 처럼 날짜를 줄 수 있습니다. today 를 주면 그날을 오늘로 놓고 셉니다.', example: { method: 'GET', path: '/api/calendar?anniversary=ann-13' } },
    {
      title: '모으기: 정리된 줄 받기',
      note: '로컬의 수집기(파이썬)가 부르는 경로입니다. 한 번에 500줄까지, 줄마다 결과가 돌아옵니다(202).',
      example: {
        method: 'POST',
        path: '/api/imports',
        body: { source: { id: 'my-source', name: '자료 이름', url: 'https://example.org/data', license: '이용 조건', fetchedAt: '2026-10-12T16:00:00+09:00' }, rows: [{ line: 1, kind: '전광판', name: '가 전광판', region: '서울 마포구', width_m: 7, height_m: 12 }] },
      },
    },
    { title: '모으기: 받은 묶음 목록', example: { method: 'GET', path: '/api/imports' } },
    { title: '모으기: 모은 줄 목록', note: 'sourceId, flag, drafted(yes·no), q 로 거릅니다.', example: { method: 'GET', path: '/api/collected?drafted=no' } },
    { title: '모으기: 줄을 초안으로', note: 'AI 를 부르지 않습니다. 가격이 없는 자료라 "필수 칸 빔"으로 확인 필요에 갑니다.', example: { method: 'POST', path: '/api/collected/<줄 번호>/draft' } },
    { title: '엑셀 파일(XLSX)로 내려받기', note: '시트 셋: 상품, 옵션, 안내.', example: { method: 'GET', path: '/api/export.xlsx?template=default', output: 'products.xlsx' } },
  ];

  return (
    <main className="page">
      <h1>API</h1>
      <p className="muted">
        화면이 하는 일은 전부 아래 API를 부르는 것입니다. 작업 공간은 요청 헤더 <code>{WORKSPACE_HEADER}</code>로 가릅니다. 접수 요청에 헤더가 없으면 새 공간이
        생기고 응답의 <code>workspace</code>에 번호가 돌아옵니다. 로그인은 없습니다.
      </p>
      {mounted ? (
        <p>
          지금 작업 공간:{' '}
          {workspace ? (
            <>
              <code className="wrap">{workspace}</code> <CopyButton text={workspace} label="번호 복사" />
            </>
          ) : (
            '아직 없음 — 작업 화면에서 글을 한 번 넣으면 생기고, 아래 예시에 번호가 채워집니다.'
          )}
        </p>
      ) : null}

      <section aria-label="방금 화면에서 누른 것">
        <div className="head">
          <h2>방금 화면에서 누른 것</h2>
          {calls.length > 0 ? (
            <button type="button" className="btn small" onClick={clearCalls}>
              기록 지우기
            </button>
          ) : null}
        </div>
        {!mounted ? null : calls.length === 0 ? (
          <p className="empty">아직 누른 것이 없습니다. 작업 화면에서 “이 글로 초안 만들기”를 누르고 다시 오면, 같은 일을 하는 curl이 여기에 나옵니다.</p>
        ) : (
          <ul className="cards">
            {calls.map((c) => (
              <Snippet
                key={c.id}
                title={c.label}
                note={`${formatTime(c.at)} · 응답 ${c.status}${c.fileName !== undefined ? ' · 파일 이름은 내 컴퓨터의 경로로 바꿔 주세요' : ''}${
                  c.method !== 'GET' && /\/(fields|approve|reject|reprocess)$/.test(c.path) ? ' · 같은 version 으로 다시 보내면 409 가 옵니다(이미 바뀌었으므로)' : ''
                }`}
                code={curl(origin, workspace, fromCall(c))}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="경로 보기">
        <h2>경로 보기</h2>
        <p className="muted small">번호와 version 은 내 것으로 바꿔 주세요. 오류는 언제나 {'{ code, message }'} 꼴입니다.</p>
        {mounted ? (
          <ul className="cards">
            {reference.map((r) => (
              <Snippet key={r.title} title={r.title} note={r.note} code={curl(origin, workspace, r.example)} />
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-label="딸린 도구의 경로">
        <h2>딸린 도구의 경로</h2>
        <p className="muted small">점검·용어 사전·견적·시안 검사·달력·모으기와 엑셀 내려받기입니다. 읽기만 하는 경로는 헤더를 빼면 본보기 공간을 봅니다.</p>
        {mounted ? (
          <ul className="cards">
            {tools.map((r) => (
              <Snippet key={r.title} title={r.title} note={r.note} code={curl(origin, workspace, r.example)} />
            ))}
          </ul>
        ) : null}
      </section>
    </main>
  );
}
