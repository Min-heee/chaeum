-- 0001 뒤에 드러난 것 셋을 고친다.

-- 1. 공간이 어긋난 줄을 표가 막는다.
--    초안은 그 원문과 같은 공간, 상품은 그 초안과 같은 공간이어야 한다.
ALTER TABLE source_docs ADD CONSTRAINT source_docs_id_workspace_key UNIQUE (id, workspace_id);
ALTER TABLE drafts ADD CONSTRAINT drafts_id_workspace_key UNIQUE (id, workspace_id);
ALTER TABLE drafts
  ADD CONSTRAINT drafts_source_doc_same_workspace_fk
  FOREIGN KEY (source_doc_id, workspace_id) REFERENCES source_docs (id, workspace_id) ON DELETE CASCADE;
ALTER TABLE products
  ADD CONSTRAINT products_draft_same_workspace_fk
  FOREIGN KEY (draft_id, workspace_id) REFERENCES drafts (id, workspace_id) ON DELETE CASCADE;

-- 2. 변경 기록: 상태 줄에는 바뀐 상태가, 고침 줄에는 칸 이름이 꼭 있다.
ALTER TABLE draft_events
  ADD CONSTRAINT draft_events_action_columns_check
  CHECK ((action = 'status' AND to_status IS NOT NULL) OR (action = 'edit' AND field IS NOT NULL));

-- 3. 정답 묶음이 넷이 됐다: 연습 / 안 여는 세트 / 실제 자료(real) / 손글.
ALTER TABLE gold_docs DROP CONSTRAINT gold_docs_split_check;
ALTER TABLE gold_docs ADD CONSTRAINT gold_docs_split_check CHECK (split IN ('dev', 'test', 'real', 'hand'));
ALTER TABLE eval_runs DROP CONSTRAINT eval_runs_split_check;
ALTER TABLE eval_runs ADD CONSTRAINT eval_runs_split_check CHECK (split IN ('dev', 'test', 'real', 'hand'));
