'use client';

// API 탭. 화면에서 방금 누른 것과 같은 일을 하는 curl 을 작업 공간 번호까지 채워 보여 준다.
import { WORKSPACE_HEADER } from '@/contract/api';
import { CopyButton } from './bits';
import { clearCalls, useCalls, useMounted, useOrigin, useWorkspace, type CallRecord } from './client';
import { formatTime } from './format';

/** 셸의 작은따옴표 안에 넣을 수 있게 바꾼다. */
const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** 작업 공간과 상관없는 경로. 공간 헤더를 싣지 않는다. */
const SPACELESS = /^\/api\/(jobs\/drain|eval\/|health|samples|content-checks)/;

interface Example {
  method: string;
  path: string;
  body?: unknown;
  fileName?: string;
  /** 공간 헤더를 싣지 않는다(본보기 공간 읽기, 공간과 상관없는 경로) */
  noWorkspace?: boolean;
  /** 응답을 파일로 받는다 */
  output?: string;
}

function curl(origin: string, workspace: string | null, e: Example): string {
  const lines = [`curl -sS${e.method === 'GET' ? '' : ` -X ${e.method}`} ${quote(`${origin}${e.path}`)}`];
  if (workspace && !e.noWorkspace && !SPACELESS.test(e.path)) lines.push(`  -H ${quote(`${WORKSPACE_HEADER}: ${workspace}`)}`);
  if (e.fileName !== undefined) lines.push(`  -F ${quote(`file=@${e.fileName}`)}`);
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
  return { method: c.method, path: c.path, body: c.body, fileName: c.fileName, noWorkspace: c.publicSpace, output: c.path.startsWith('/api/export.csv') ? 'export.csv' : undefined };
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
    </main>
  );
}
