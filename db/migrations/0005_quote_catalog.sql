-- 이행 0005: 견적이 어느 공간의 상품을 살폈는지 적는다.
-- 'own'    요청한 공간의 상품(전부터 있던 길)
-- 'public' 본보기 공간의 상품. 읽기만 한다. 자기 공간에 상품이 없는 방문자가 보기 문의를 끝까지 따라가 볼 수 있게 하려는 것이다.
--          견적 자체는 요청한 공간에 저장된다(본보기 공간에는 쓰지 않는다).
-- 두 번 돌려도 된다.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS catalog text NOT NULL DEFAULT 'own';
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_catalog_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_catalog_check CHECK (catalog IN ('own', 'public'));
