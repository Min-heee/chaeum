-- 표 14개. 묶음: 파이프라인 6 / 상품 3 / LLM 1 / 평가 4.
-- 초안은 느슨하게(칸 하나가 한 줄), 확정 상품은 엄격하게(타입과 CHECK).
-- 닫힌 목록의 값은 src/contract 의 목록과 같아야 한다.

-- ── 파이프라인 ──────────────────────────────────────────────

-- 1. 방문자 칸막이. 첫 쓰기 때 만든다. 'public' 은 읽기 전용 본보기.
CREATE TABLE workspaces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('public', 'sandbox', 'local')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_write_at timestamptz NOT NULL DEFAULT now()
);
-- 낡은 방문자 공간을 찾을 때 쓴다.
CREATE INDEX workspaces_sweep_idx ON workspaces (last_write_at) WHERE kind = 'sandbox';

-- 2. 원문. 같은 공간에 같은 글 두 번 = 한 건.
CREATE TABLE source_docs (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  clean_text   text NOT NULL CHECK (length(clean_text) > 0),
  content_hash text NOT NULL,
  batch_no     int,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, content_hash)
);

-- 3. 작업 줄. 시각(run_at, leased_until)은 기본값 없이 코드가 인자로 넣는다.
--    ref_id: extract 는 초안 번호, content 는 상품 번호.
CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('extract', 'content')),
  ref_id       bigint NOT NULL,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'dead')),
  attempts     int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_at       timestamptz NOT NULL,
  leased_until timestamptz,
  last_error   text,
  UNIQUE (kind, ref_id)                       -- 같은 일이 두 번 들어가지 않는다
);
CREATE INDEX jobs_queued_idx ON jobs (run_at) WHERE status = 'queued';
CREATE INDEX jobs_running_idx ON jobs (leased_until) WHERE status = 'running';

-- 4. 초안(검수 대상). 원문 하나에 초안 하나.
CREATE TABLE drafts (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  source_doc_id  bigint NOT NULL UNIQUE REFERENCES source_docs (id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'PROCESSING'
                 CHECK (status IN ('PROCESSING', 'NEEDS_REVIEW', 'READY', 'FAILED', 'APPROVED', 'REJECTED')),
  version        int NOT NULL DEFAULT 1 CHECK (version >= 1),
  type           text CHECK (type IN ('ad', 'catering', 'goods', 'not_product')),
  subtype        text,
  reasons        text[] NOT NULL DEFAULT '{}',
  reject_code    text,
  reject_memo    text,
  prompt_version text,
  model          text,
  extracted_by   text CHECK (extracted_by IN ('llm', 'rules')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- 반려에는 사유 코드가 꼭 있다.
  CHECK (status <> 'REJECTED' OR reject_code IS NOT NULL)
);
CREATE INDEX drafts_inbox_idx ON drafts (workspace_id, status, id DESC);

-- 5. 칸 하나가 한 줄. 값의 꼴은 코드가 본다(느슨하게).
CREATE TABLE draft_fields (
  draft_id        bigint NOT NULL REFERENCES drafts (id) ON DELETE CASCADE,
  field           text NOT NULL,
  raw             text,
  model_value     jsonb,
  code_value      jsonb,
  final_value     jsonb,
  evidence        text,
  reasons         text[] NOT NULL DEFAULT '{}',
  edited_by_human boolean NOT NULL DEFAULT false,
  PRIMARY KEY (draft_id, field)
);

-- 6. 변경 기록. 추가만 한다(코드와 시험으로 지킨다). 상태 변경과 같은 트랜잭션에 쓴다.
--    action = 'edit' 줄이 곧 "사람이 고친 값 = 정답 후보"다.
CREATE TABLE draft_events (
  id          bigserial PRIMARY KEY,
  draft_id    bigint NOT NULL REFERENCES drafts (id) ON DELETE CASCADE,
  actor       text NOT NULL CHECK (actor IN ('system', 'seller', 'admin')),
  action      text NOT NULL CHECK (action IN ('status', 'edit')),
  from_status text,
  to_status   text,
  field       text,
  before      jsonb,
  after       jsonb,
  reason_code text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX draft_events_draft_idx ON draft_events (draft_id, id);
CREATE INDEX draft_events_edit_idx ON draft_events (field) WHERE action = 'edit';

-- ── 상품 ────────────────────────────────────────────────────

-- 7. 확정 상품. 핵심 열은 타입과 CHECK, 종류별 규격과 옵션은 jsonb(넣기 전에 코드가 꼴을 본다).
--    제약은 코드 검사가 놓친 것을 막는 마지막 줄이다.
CREATE TABLE products (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  draft_id       bigint NOT NULL UNIQUE REFERENCES drafts (id) ON DELETE CASCADE,
  type           text NOT NULL CHECK (type IN ('ad', 'catering', 'goods')),
  subtype        text NOT NULL CHECK (length(subtype) >= 1),
  name           text NOT NULL CHECK (length(name) >= 2),
  price_krw      bigint NOT NULL CHECK (price_krw > 0),
  list_price_krw bigint CHECK (list_price_krw IS NULL OR list_price_krw >= price_krw),
  vat_included   boolean,
  spec           jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
  options        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(options) = 'array'),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_workspace_idx ON products (workspace_id, id DESC);

-- 8. 언어별 글. (상품, 칸, 언어)가 한 줄.
CREATE TABLE product_texts (
  product_id bigint NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  field      text NOT NULL CHECK (field IN ('title', 'summary')),
  lang       text NOT NULL CHECK (lang IN ('en', 'zh-Hans')),
  text       text NOT NULL,
  source     text NOT NULL CHECK (source IN ('llm', 'template', 'human')),
  status     text NOT NULL CHECK (status IN ('ok', 'needs_review')),
  fail_codes text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (product_id, field, lang)
);

-- 9. 하루 상한 세기(접수 전체, 진짜 LLM 호출). day 는 한국 날짜.
CREATE TABLE daily_counters (
  day   date NOT NULL,
  key   text NOT NULL,
  count int NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (day, key)
);

-- ── LLM ─────────────────────────────────────────────────────

-- 10. 호출 장부이자 캐시이자 녹화본.
--     cache_key = sha256(task + model + prompt_version + 스키마 버전 + 정리한 입력)
CREATE TABLE llm_calls (
  id             bigserial PRIMARY KEY,
  task           text NOT NULL CHECK (task IN ('extract', 'content')),
  provider       text NOT NULL CHECK (provider IN ('anthropic', 'replay', 'fake')),
  model          text NOT NULL,
  prompt_version text NOT NULL,
  cache_key      text NOT NULL,
  response       jsonb,
  stop_reason    text,
  input_tokens   int,
  output_tokens  int,
  cost_usd       numeric(10, 6),
  latency_ms     int,
  is_recorded    boolean NOT NULL DEFAULT false,
  eval_run_id    bigint,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_calls_cache_key_idx ON llm_calls (cache_key, id DESC);

-- ── 평가 ────────────────────────────────────────────────────

-- 11. 정답 문서.
CREATE TABLE gold_docs (
  id           text PRIMARY KEY,
  split        text NOT NULL CHECK (split IN ('dev', 'test', 'hand')),
  gold_version int NOT NULL DEFAULT 1 CHECK (gold_version >= 1),
  content      text NOT NULL,
  truth        jsonb NOT NULL,
  author       text NOT NULL CHECK (author IN ('ai', 'human')),
  traps        text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX gold_docs_split_idx ON gold_docs (split);

-- 12. 사람 확인 기록. pass 1 = 첫 확인, 2 = 하루 뒤 다시 보기.
CREATE TABLE gold_reviews (
  id           bigserial PRIMARY KEY,
  gold_doc_id  text NOT NULL REFERENCES gold_docs (id) ON DELETE CASCADE,
  pass         int NOT NULL CHECK (pass IN (1, 2)),
  verdict      text NOT NULL CHECK (verdict IN ('ok', 'fixed', 'dropped')),
  fixed_fields int NOT NULL DEFAULT 0 CHECK (fixed_fields >= 0),
  seconds      int CHECK (seconds IS NULL OR seconds >= 0),
  reviewed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gold_reviews_doc_idx ON gold_reviews (gold_doc_id, pass);

-- 13. 평가 실행. 한 번 돌리면 방식별로 세 줄이 생긴다.
CREATE TABLE eval_runs (
  id             bigserial PRIMARY KEY,
  split          text NOT NULL CHECK (split IN ('dev', 'test', 'hand')),
  method         text NOT NULL CHECK (method IN ('rules', 'llm_only', 'llm_code')),
  model          text,
  prompt_version text,
  gold_version   int NOT NULL,
  git_commit     text NOT NULL,
  metrics        jsonb NOT NULL DEFAULT '{}',
  cost_usd       numeric(10, 4) NOT NULL DEFAULT 0,
  started_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX eval_runs_split_idx ON eval_runs (split, id DESC);

-- 14. 평가 결과. (실행, 정답 문서, 칸)이 한 줄. 종류와 갈래도 field = 'type' / 'subtype' 줄로 남긴다.
CREATE TABLE eval_results (
  run_id      bigint NOT NULL REFERENCES eval_runs (id) ON DELETE CASCADE,
  gold_doc_id text NOT NULL,
  field       text NOT NULL,
  expected    jsonb,
  actual      jsonb,
  verdict     text NOT NULL CHECK (verdict IN ('correct', 'wrong', 'missed', 'fabricated', 'true_none')),
  flagged     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (run_id, gold_doc_id, field)
);

-- 장부의 줄이 어느 평가 실행에서 나왔는지. 실행을 지워도 장부(녹화본)는 남는다.
ALTER TABLE llm_calls
  ADD CONSTRAINT llm_calls_eval_run_fk FOREIGN KEY (eval_run_id) REFERENCES eval_runs (id) ON DELETE SET NULL;
