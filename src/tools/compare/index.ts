// 비교의 판단 코드(순수 함수)의 문. 약속은 src/contract/tools/compare.ts, 결정 문서는 docs/PRD-TOOLS.md 3-7.
// 시계·난수·DB·네트워크를 쓰지 않는다(린트가 본다). 시험은 같은 폴더의 *.test.ts.
// 브라우저 코드(app/compare)도 이 문을 가져다 쓴다. 서버 전용 모듈을 여기서 가져오지 않는다.
//
//   metrics.ts  상품 하나 → 견줄 값(하루당 값, 유동인구 1,000명당 값, 넓이, 운영 시간, 노출 시간, 마감, 한 개당 값). 값·어디서 계산했는지·없음의 까닭
//   group.ts    거르기, 차례 매기기(없는 것은 맨 뒤, 같은 값은 번호순, 부가세가 섞이면 같은 것끼리), 묶음의 경고, 나란히 놓기
//   words.ts    값과 까닭을 사람 말로
//   query.ts    화면에서 고른 값 → 경로에 보낼 주소
export { compareRow, exposureSeconds, openMinutes, optionValues, perDay, perThousandFootfall, perUnit, readOptions, regionOf, roundDiv, screenArea, skippedOptions } from './metrics';
export { buildCompare, defaultOrder, filterProducts, groupWarnings, rankRows, sideBySide, typesIn, vatMixed } from './group';
export { comparePath, nextSort, tableMetrics, togglePick, type CompareChoice } from './query';
export {
  basisText,
  belowOneWon,
  betterText,
  comma,
  durationText,
  metricValueText,
  missingText,
  optionText,
  otherOptionLines,
  RANK_GROUP_LABELS,
  rankHeadText,
  rankScopeText,
  secondsText,
  skippedText,
  vatText,
  warningText,
  withheldText,
} from './words';
