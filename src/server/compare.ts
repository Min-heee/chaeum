// 비교의 DB 일. 그 공간의 상품을 읽기만 한다(쓰지 않는다, 모델을 부르지 않는다).
// 계산은 src/tools/compare 의 순수 함수가 한다. 여기서는 상품을 읽어 넘기고, 없는 번호를 404 로 바꾼다.
import type { CompareQuery, CompareResponse } from '@/contract/tools/compare';
import { buildCompare } from '@/tools/compare';
import { getPool } from './db';
import { AppError } from './errors';
import { listProducts } from './repos/products';
import type { Db } from './types';

/**
 * GET /api/compare 의 응답을 만든다.
 * 읽는 것은 그 공간의 상품뿐이다. 남의 공간 상품 번호를 ids 에 넣으면 이 공간에는 없는 번호이므로 NOT_FOUND 다
 * (있는지 없는지도 알려 주지 않는다. 본보기 공간의 상품도 내 공간에서는 없는 번호다).
 * db 를 주면 그 연결(열어 둔 트랜잭션)로 읽는다. 안 주면 풀에서 읽는다.
 */
export async function compareFor(workspaceId: string, query: CompareQuery, db?: Db): Promise<CompareResponse> {
  const products = await listProducts(db ?? getPool(), workspaceId);
  const built = buildCompare(products, query);
  if (!built.ok) throw new AppError('NOT_FOUND', '나란히 놓을 상품 가운데 이 공간에 없는 것이 있습니다.');
  return built.response;
}
