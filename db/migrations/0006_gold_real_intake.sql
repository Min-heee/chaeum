-- 실제 자료 묶음(real)의 정답을 만드는 길을 남긴다. 정답 쪽 표만 더한다(앱의 표, gold_docs·gold_reviews 의 줄은 건드리지 않는다).
--
-- 실제 자료의 정답은 "얼린 파이프라인이 채운 초안을 사람이 고쳐서" 만든다. 사람이 놓친 틀림은 맞은 것으로 세어지므로
-- (모델에 유리하게 기운다), 모델이 낸 값을 사람이 확정한 값과 따로 남겨 둔다.
--   - 모델이 낸 값: 이 표의 model (종류, 갈래, 칸별 값·근거·표시)
--   - 사람이 확정한 값: gold_docs.truth (그 문서를 나중에 다시 고쳐도 여기서 읽으면 언제나 지금 정답이다)
--   - 사람이 바꿨는가: 둘을 견줘서 낸다(src/gold/origins.ts). 표에 따로 적지 않는다(적어 두면 정답을 다시 고쳤을 때 어긋난다).
CREATE TABLE gold_real_intake (
  id           bigserial PRIMARY KEY,
  -- 붙여 넣은 원문. 남이 쓴 글이라 저장소의 파일에는 싣지 않는다.
  content      text NOT NULL,
  source_url   text NOT NULL,
  -- 그 글을 받은 날(한국 날짜)
  fetched_on   date NOT NULL,
  -- 원문의 꼴: 소개 글 / 단가표 / PDF 를 글로 옮김 / 그림을 글로 옮김 / 그 밖
  source_kind  text NOT NULL CHECK (source_kind IN ('page', 'price_table', 'pdf_text', 'image_text', 'other')),
  -- 얼린 파이프라인(뽑기 → 맞추기 → 따지기)이 낸 초안
  model        jsonb NOT NULL,
  model_name   text NOT NULL,
  prompt_version text NOT NULL,
  -- 이 초안을 만들 때 실제로 모델을 불렀는가(장부에 답이 있었으면 false)
  called       boolean NOT NULL,
  cost_usd     numeric(10, 6) NOT NULL DEFAULT 0,
  -- open: 초안만 있음 / saved: 정답 문서가 됨 / skipped: 우리 양식에 없는 상품이라 넘김
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'saved', 'skipped')),
  skip_note    text,
  gold_doc_id  text UNIQUE REFERENCES gold_docs (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gold_real_intake_status_idx ON gold_real_intake (status, id);
