-- PRD v0.2 에서 늘어난 것: 그림·PDF 올리기, 방문자 글의 실제 호출, 규칙만 길로 내려간 까닭.
-- 이 파일은 통째로 두 번 돌려도 같은 결과가 되게 썼다(IF NOT EXISTS, 제약은 지우고 다시 건다).

-- 1. 원문이 무엇으로 들어왔나. 파일 자체는 저장하지 않는다. 모델이 옮긴 글(clean_text)과 파일의 해시만 남긴다.
ALTER TABLE source_docs ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'text';
ALTER TABLE source_docs ADD COLUMN IF NOT EXISTS origin_name text;        -- 올린 파일 이름. 없을 수 있다
ALTER TABLE source_docs ADD COLUMN IF NOT EXISTS file_hash   text;        -- sha256(파일 바이트). 글이면 NULL

ALTER TABLE source_docs DROP CONSTRAINT IF EXISTS source_docs_source_kind_check;
ALTER TABLE source_docs ADD CONSTRAINT source_docs_source_kind_check CHECK (source_kind IN ('text', 'image', 'pdf'));

-- 붙여 넣은 글에는 파일 해시가 없고, 올린 파일에는 꼭 있다. 파일 이름은 파일에만 있다.
ALTER TABLE source_docs DROP CONSTRAINT IF EXISTS source_docs_file_columns_check;
ALTER TABLE source_docs ADD CONSTRAINT source_docs_file_columns_check
  CHECK ((source_kind = 'text' AND file_hash IS NULL AND origin_name IS NULL)
      OR (source_kind <> 'text' AND file_hash IS NOT NULL));

-- 같은 공간에 같은 파일 두 번 = 한 건. 모델을 부르기 전에 이것으로 먼저 찾는다(같은 파일에 돈을 두 번 쓰지 않는다).
CREATE UNIQUE INDEX IF NOT EXISTS source_docs_file_hash_key ON source_docs (workspace_id, file_hash) WHERE file_hash IS NOT NULL;

-- 2. 초안이 어떤 LLM 길로 뽑혔나.
--    llm_skip_cause: 규칙만 길로 내려간 까닭(사유 LLM_SKIPPED 의 원인). LLM 으로 뽑았으면 NULL.
--    llm_recorded / llm_latency_ms / llm_cost_usd: LLM 으로 뽑았을 때 그 답이 장부에서 나왔는지와, 그 답을 실제로 받을 때 잰 값.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS llm_skip_cause text;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS llm_recorded   boolean;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS llm_latency_ms int;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS llm_cost_usd   numeric(10, 6);

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_llm_skip_cause_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_llm_skip_cause_check
  CHECK (llm_skip_cause IS NULL
      OR llm_skip_cause IN ('no_key', 'cache_miss', 'off', 'too_long', 'daily_cap', 'refusal', 'error'));

-- 규칙만으로 뽑은 초안에는 호출 기록이 없다.
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_llm_columns_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_llm_columns_check
  CHECK (llm_skip_cause IS NULL OR (llm_recorded IS NULL AND llm_latency_ms IS NULL AND llm_cost_usd IS NULL));

-- 3. 장부의 일 종류에 "글로 옮기기"가 생겼다. 작업 줄(jobs.kind)은 그대로다.
--    글로 옮기기는 올리기 요청 안에서 끝낸다(파일을 저장하지 않으므로 줄에 넣어 둘 것이 없다).
ALTER TABLE llm_calls DROP CONSTRAINT IF EXISTS llm_calls_task_check;
ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_task_check CHECK (task IN ('transcribe', 'extract', 'content'));
