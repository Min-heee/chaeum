-- 딸린 도구(점검, 모으기, 용어 사전, 견적, 시안 검사, 달력)에서 늘어난 것. 결정 문서는 docs/PRD-TOOLS.md.
-- 이 파일은 통째로 두 번 돌려도 같은 결과가 되게 썼다(IF NOT EXISTS, 제약은 지우고 다시 건다).
-- 정답 표(gold_docs, gold_reviews)와 평가 표는 건드리지 않는다.
-- 표가 14개에서 18개가 된다: glossary_terms, quotes, import_batches, collected_items.
-- 점검·시안 검사·달력은 아무것도 저장하지 않아 표가 없다.

-- ── 본체 표의 닫힌 목록에 더하는 값 ─────────────────────────

-- 1. 모으기 도구가 가져온 줄로 만든 초안. 원문 종류와 뽑은 방식에 'import' 가 생긴다.
--    가져온 줄은 파일이 아니다. 파일 해시도 파일 이름도 없다.
ALTER TABLE source_docs DROP CONSTRAINT IF EXISTS source_docs_source_kind_check;
ALTER TABLE source_docs ADD CONSTRAINT source_docs_source_kind_check CHECK (source_kind IN ('text', 'image', 'pdf', 'import'));

ALTER TABLE source_docs DROP CONSTRAINT IF EXISTS source_docs_file_columns_check;
ALTER TABLE source_docs ADD CONSTRAINT source_docs_file_columns_check
  CHECK ((source_kind IN ('text', 'import') AND file_hash IS NULL AND origin_name IS NULL)
      OR (source_kind IN ('image', 'pdf') AND file_hash IS NOT NULL));

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_extracted_by_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_extracted_by_check CHECK (extracted_by IN ('llm', 'rules', 'import'));

-- 2. 장부의 일 종류에 견적의 둘이 생긴다. 작업 줄(jobs.kind)은 그대로 둘이다(견적은 요청 안에서 바로 부른다).
ALTER TABLE llm_calls DROP CONSTRAINT IF EXISTS llm_calls_task_check;
ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_task_check
  CHECK (task IN ('transcribe', 'extract', 'content', 'quote_extract', 'quote_reply'));

-- ── 용어 사전 ───────────────────────────────────────────────

-- 15. 용어 한 줄. 같은 공간에 같은 한국어 낱말은 한 줄이다.
--     본보기 공간(00000000-…)의 줄이 "공용 줄"이다. 씨앗이 data/seed/glossary.json 을 승인 상태로 싣는다.
--     글 만들기와 글 검사는 승인된 줄만 본다(공용 줄 + 내 공간의 줄, 같은 낱말이면 내 줄).
CREATE TABLE IF NOT EXISTS glossary_terms (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  ko           text NOT NULL CHECK (length(ko) BETWEEN 1 AND 60),
  en           text CHECK (en IS NULL OR length(en) BETWEEN 1 AND 60),
  zh_hans      text CHECK (zh_hans IS NULL OR length(zh_hans) BETWEEN 1 AND 60),
  status       text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved')),
  note         text CHECK (note IS NULL OR length(note) <= 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, ko),
  -- 승인된 줄에는 두 표기가 꼭 있다. 표기가 빈 줄은 제안으로만 둘 수 있다.
  CONSTRAINT glossary_terms_approved_check CHECK (status <> 'approved' OR (en IS NOT NULL AND zh_hans IS NOT NULL))
);

-- ── 견적 ────────────────────────────────────────────────────

-- 16. 견적 한 건. 문의 글, 모델이 뽑은 것, 코드가 다듬은 조건, 고른 상품, 답장.
--     conditions·candidates·excluded 의 꼴은 src/contract/tools/quote.ts 에 있고 넣기 전에 코드가 본다.
--     today 는 계산에 쓴 오늘(한국 날짜)이다. 코드가 인자로 넣는다.
CREATE TABLE IF NOT EXISTS quotes (
  id                  bigserial PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  inquiry_text        text NOT NULL CHECK (length(inquiry_text) BETWEEN 1 AND 1000),
  lang                text NOT NULL CHECK (lang IN ('ko', 'en', 'zh-Hans')),
  today               date NOT NULL,
  extraction          jsonb NOT NULL CHECK (jsonb_typeof(extraction) = 'object'),
  conditions          jsonb NOT NULL CHECK (jsonb_typeof(conditions) = 'object'),
  candidates          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(candidates) = 'array'),
  candidate_count     int NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  excluded            jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(excluded) = 'array'),
  product_count       int NOT NULL DEFAULT 0 CHECK (product_count >= 0),
  -- 답장을 쓴 상품. 상품이 지워져도 견적은 남는다.
  selected_product_id bigint REFERENCES products (id) ON DELETE SET NULL,
  reply_template      text NOT NULL,                 -- 자리표시({total})인 채의 글
  reply_text          text NOT NULL,                 -- 코드가 숫자와 날짜를 넣은 글
  reply_source        text NOT NULL CHECK (reply_source IN ('llm', 'template')),
  reply_status        text NOT NULL CHECK (reply_status IN ('ok', 'needs_review')),
  reply_fail_codes    text[] NOT NULL DEFAULT '{}',
  llm                 jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(llm) = 'object'),   -- 호출 둘의 기록
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  confirmed_reply     text CHECK (confirmed_reply IS NULL OR length(confirmed_reply) BETWEEN 1 AND 2000),
  confirmed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- 확정에는 사람이 본 답장과 그 시각이 꼭 있고, 확정 전에는 없다.
  CONSTRAINT quotes_confirmed_check
    CHECK ((status = 'draft' AND confirmed_reply IS NULL AND confirmed_at IS NULL)
        OR (status = 'confirmed' AND confirmed_reply IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS quotes_workspace_idx ON quotes (workspace_id, id DESC);

-- ── 모으기 ──────────────────────────────────────────────────

-- 17. 받은 묶음. 무엇을 어디서 어떤 조건으로 받았는지와, 줄이 어떻게 갈렸는지.
--     rows_received = rows_new + rows_duplicate + rows_unreadable.
--     collector_* 는 수집기가 보내기 전에 스스로 뺀 줄의 수다(서버는 세지 못한다. 받은 그대로 적는다).
CREATE TABLE IF NOT EXISTS import_batches (
  id                    bigserial PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  source_id             text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 60),
  source_name           text NOT NULL,
  source_url            text NOT NULL,
  license               text NOT NULL,              -- 이용 조건
  fetched_at            timestamptz NOT NULL,       -- 수집기가 자료를 받은 시각
  rows_received         int NOT NULL DEFAULT 0 CHECK (rows_received >= 0),
  rows_new              int NOT NULL DEFAULT 0 CHECK (rows_new >= 0),
  rows_duplicate        int NOT NULL DEFAULT 0 CHECK (rows_duplicate >= 0),
  rows_unreadable       int NOT NULL DEFAULT 0 CHECK (rows_unreadable >= 0),
  collector_unreadable  int NOT NULL DEFAULT 0 CHECK (collector_unreadable >= 0),
  collector_duplicates  int NOT NULL DEFAULT 0 CHECK (collector_duplicates >= 0),
  received_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_batches_rows_check CHECK (rows_received = rows_new + rows_duplicate + rows_unreadable)
);
CREATE INDEX IF NOT EXISTS import_batches_workspace_idx ON import_batches (workspace_id, id DESC);

-- 18. 모은 줄. 같은 공간에 같은 중복 열쇠는 한 건이다(열쇠를 만드는 식은 src/contract/tools/collect.ts 의 collectDedupeKey).
--     값의 꼴은 느슨하다. 맞는지는 초안으로 만들 때 본체의 맞추기·따지기가 본다.
CREATE TABLE IF NOT EXISTS collected_items (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  batch_id     bigint NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  source_id    text NOT NULL,                      -- 출처의 짧은 번호
  source_line  int NOT NULL CHECK (source_line >= 1),   -- 출처 파일 안의 줄 번호
  kind         text,                               -- 종류(자료에 적힌 큰 갈래)
  name         text,
  region       text,
  address      text,
  subway_line  text,                               -- 호선
  station      text,                               -- 역
  media_type   text,                               -- 매체 종류
  width_m      double precision CHECK (width_m IS NULL OR width_m > 0),
  height_m     double precision CHECK (height_m IS NULL OR height_m > 0),
  quantity     int CHECK (quantity IS NULL OR quantity >= 0),
  lat          double precision CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng          double precision CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  operator     text,                               -- 운영 기관
  raw          jsonb NOT NULL CHECK (jsonb_typeof(raw) = 'object'),   -- 원래 줄
  dedupe_key   text NOT NULL CHECK (length(dedupe_key) > 0),
  flags        text[] NOT NULL DEFAULT '{}',
  -- 이 줄로 만든 초안. 초안이 지워지면 "아직 초안이 아님"으로 돌아간다.
  draft_id     bigint REFERENCES drafts (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS collected_items_workspace_idx ON collected_items (workspace_id, id DESC);
CREATE INDEX IF NOT EXISTS collected_items_source_idx ON collected_items (workspace_id, source_id);
