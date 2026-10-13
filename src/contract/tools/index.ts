// 딸린 도구 일곱의 약속이 모이는 문. 도구마다 파일이 하나씩 있다. 결정 문서는 docs/PRD-TOOLS.md 다.
//
//   도구        약속 파일      판단(순수 함수)        DB 일                  경로                         화면
//   점검        audit.ts      src/tools/audit       src/server/audit.ts    app/api/audits               app/audit
//   모으기      collect.ts    src/tools/collect     src/server/imports.ts, collected.ts  app/api/imports, collected  app/collect
//   용어 사전   glossary.ts   (glossary.ts 안)      src/server/glossary.ts app/api/glossary             app/glossary
//   견적        quote.ts      src/tools/quote       src/server/quotes.ts   app/api/quotes               app/quote
//   시안 검사   creative.ts   src/tools/creative    (없음. 상품 읽기뿐)     app/api/creative-checks      app/creative
//   달력        calendar.ts   src/tools/calendar    src/server/calendar.ts app/api/calendar             app/calendar
//   비교        compare.ts    src/tools/compare     src/server/compare.ts  app/api/compare              app/compare
//   (함께)      dates.ts      src/tools/shared      —                      —                            —
//   (내려받기)  xlsx.ts       —                     src/server/export-xlsx.ts  app/api/export.xlsx      상품 화면
//
// 공통 규칙은 본체와 같다(api.ts 의 머리말): 작업 공간은 X-Workspace 헤더, 오류 본문은 { code, message }, 시각은 ISO 8601 글자.
// 읽기만 하는 경로(점검, 달력, 비교, 시안 검사, GET 들)는 헤더가 없으면 본보기 공간을 본다.
// 쓰는 경로(용어 더하기, 견적, 받기, 줄 → 초안)는 헤더가 없으면 그때 새 공간을 만들어 응답의 workspace 에 돌려준다.
//
// 경로 15개(본체 18개에 이어 19번부터 33번까지)
//  19  POST  /audits                     점검(저장하지 않는다)
//  20  GET   /glossary                   용어 목록
//  21  POST  /glossary                   용어 더하기
//  22  PATCH /glossary/:id               용어 고치기·승인
//  23  POST  /quotes                     문의 글 → 견적
//  24  GET   /quotes/:id                 견적 한 건
//  25  POST  /quotes/:id/confirm         답장 확정
//  26  POST  /creative-checks            시안 검사(저장하지 않는다)
//  27  GET   /calendar                   마감 거꾸로 세기
//  28  POST  /imports                    모은 줄 받기
//  29  GET   /imports                    받은 묶음 목록
//  30  GET   /collected                  모은 줄 목록
//  31  POST  /collected/:id/draft        줄 → 초안
//  32  GET   /export.xlsx                여러 시트 내려받기
//  33  GET   /compare                    같은 잣대로 나란히 놓기(저장하지 않는다)
// 이 파일은 브라우저 코드(맨 위 메뉴)도 읽는다. 도구별 파일을 여기서 다시 내보내지 않는다(쓰는 쪽이 그 파일을 직접 가져온다).

export const TOOL_KEYS = ['audit', 'collect', 'glossary', 'quote', 'creative', 'calendar', 'compare'] as const;
export type ToolKey = (typeof TOOL_KEYS)[number];

export interface ToolDef {
  key: ToolKey;
  /** 화면의 주소 */
  href: string;
  /** 메뉴에 보이는 이름 */
  label: string;
  /** 한 줄 소개 */
  blurb: string;
  /** LLM 을 쓰는가. 화면이 "AI를 쓰지 않습니다"를 숨기지 않고 적는다. */
  usesLlm: boolean;
}

/** 메뉴의 "도구" 묶음. 순서가 곧 메뉴의 순서다. */
export const TOOLS: readonly ToolDef[] = [
  { key: 'audit', href: '/audit', label: '점검', blurb: '등록된 상품 전체를 한 번에 살핍니다.', usesLlm: false },
  { key: 'collect', href: '/collect', label: '모으기', blurb: '공공 자료에서 정리해 온 줄을 초안의 재료로 씁니다.', usesLlm: false },
  { key: 'glossary', href: '/glossary', label: '용어 사전', blurb: '번역 표기를 한곳에서 정합니다.', usesLlm: false },
  { key: 'quote', href: '/quote', label: '견적', blurb: '문의 글에서 조건을 뽑아 맞는 상품과 총액을 냅니다.', usesLlm: true },
  { key: 'creative', href: '/creative', label: '시안 검사', blurb: '시안 파일이 지면 규격에 맞는지 봅니다.', usesLlm: false },
  { key: 'calendar', href: '/calendar', label: '달력', blurb: '기념일에 맞추려면 언제까지 무엇을 해야 하는지 셉니다.', usesLlm: false },
  { key: 'compare', href: '/compare', label: '비교', blurb: '등록된 상품을 같은 잣대로 나란히 놓습니다.', usesLlm: false },
];

export function toolDef(key: ToolKey): ToolDef {
  const def = TOOLS.find((t) => t.key === key);
  if (!def) throw new Error(`모르는 도구: ${key}`);
  return def;
}
