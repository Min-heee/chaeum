// 정답 100건을 원문 쓰는 이 넷에게 나눠 준다. 묶음마다 25건, 연습과 안 여는 세트가 섞이고 꼴이 고르다.
import { TYPE_LABELS } from '@/contract/fields';
import { GOLD_STYLES, STYLE_LABELS } from '@/contract/eval-types';
import type { GoldSpec } from './spec';

export const BATCH_COUNT = 4;

export interface WriterBatch {
  batch: number;
  /** 다 쓴 원문을 적을 파일(저장소 뿌리에서 본 길) */
  output_path: string;
  /** 출력 꼴 */
  output_format: string;
  docs: (GoldSpec & { type_label: string; style_label: string })[];
}

export const batchInputName = (n: number) => `batch-${n}.json`;
export const batchOutputName = (n: number) => `out/batch-${n}.json`;

/** 꼴 × 묶음(연습/안 여는 세트)별로 돌아가며 나눠서, 묶음마다 꼴과 비율이 같게 한다. */
export function splitBatches(specs: readonly GoldSpec[], workDir: string): WriterBatch[] {
  const batches: WriterBatch[] = Array.from({ length: BATCH_COUNT }, (_, i) => ({
    batch: i + 1,
    output_path: `${workDir}/${batchOutputName(i + 1)}`,
    output_format: '[{"id": "dev-001", "content": "원문 글"}, …] — 이 묶음의 문서 전부, JSON 배열 하나',
    docs: [],
  }));
  let turn = 0;
  for (const style of GOLD_STYLES) {
    for (const split of ['dev', 'test'] as const) {
      const group = specs.filter((s) => s.style === style && s.split === split).sort((a, b) => a.id.localeCompare(b.id));
      for (const spec of group) {
        const batch = batches[turn % BATCH_COUNT] as WriterBatch;
        batch.docs.push({ ...spec, type_label: TYPE_LABELS[spec.type], style_label: STYLE_LABELS[spec.style] });
        turn += 1;
      }
    }
  }
  return batches;
}

/** 원문 쓰는 이가 읽는 안내. */
export function writerGuide(workDir: string): string {
  return `# 원문 쓰기 안내

가상 마켓 "응원장터"에 공급처가 보내는 상품 소개 글을 쓴다. 정답(칸별 값)은 이미 정해져 있다.
할 일은 **그 정답이 담긴 원문**을 쓰는 것이다. 정답을 바꾸지 않는다.

## 받는 것과 내는 것

- 받는 것: \`${workDir}/${batchInputName(1)}\` ~ \`${batchInputName(BATCH_COUNT)}\` 가운데 맡은 묶음 하나(25건).
- 내는 것: 묶음 파일의 \`output_path\` 에 JSON 파일 하나. 꼴은 \`[{"id": "...", "content": "..."}]\`. 25건 전부.
- \`content\` 는 원문 글 하나다. 줄바꿈은 \`\\n\` 으로 넣는다. 설명이나 머리말을 붙이지 않는다.

## 읽지 않는 것

- 뽑기 프롬프트와 \`src/llm\`, \`src/core\`, \`src/contract\` 는 읽지 않는다. 원문은 뽑는 쪽을 모르고 써야 한다.
- 다른 묶음 파일과 다른 이가 쓴 원문도 읽지 않는다.

## 문서 한 건에 들어 있는 것

| 열쇠 | 뜻 |
|---|---|
| \`type_label\`, \`subtype\` | 무슨 상품인가 |
| \`style_label\` | 어떤 꼴로 쓸 것인가(아래 "꼴 다섯") |
| \`truth\` | 칸별 정답. 참고용이다. 원문에는 아래 표기로 쓴다 |
| \`surface_hints\` | 값이 있는 칸을 **원문에 어떤 표기로 쓸지** |
| \`absent\` | 값이 없는 칸. **원문에 쓰지 않는다** |
| \`must_include\` | 글자 그대로 넣을 문장 |
| \`notes\` | 이 건에만 해당하는 말 |

## 꼭 지킬 것

1. **\`surface_hints\` 의 \`tokens\` 는 하나도 빠짐없이, 글자 그대로, 한 번 이상 원문에 들어간다.**
   띄어쓰기와 쉼표까지 같아야 한다. \`show\` 는 본보기 문구다. 앞뒤 말은 바꿔도 되지만 \`tokens\` 는 바꾸지 않는다.
   - 예: \`show\` "05시~25시" → 원문에 "05시~25시" 가 그대로 있어야 한다. "오전 5시부터 새벽 1시"로 풀어 쓰지 않는다.
   - 예: \`show\` "월 250만 명", \`tokens\` ["250만"] → "월 유동인구 250만 명" 처럼 쓴다. 하루 값으로 바꿔 적지 않는다.
   - 예: \`show\` "8000×4500mm", \`tokens\` ["8000", "4500"] → "8000 x 4500 mm" 도 된다. m 로 바꿔 적지 않는다.
   - 예: 기간 옵션 \`tokens\` ["1주", "150만원", "2주", "280만원"] → 어느 기간이 어느 값인지 읽으면 알 수 있게 짝지어 쓴다.
2. **\`note\` 를 따른다.** "월 단위라는 것을 밝힌다", "만원 단위 숫자만 적는다" 같은 말이 적혀 있다.
3. **\`absent\` 의 칸에 해당하는 정보는 원문 어디에도 쓰지 않는다.** 짐작해서 채우지 않는다.
   - \`how\` 가 \`omit\` 이면 그 칸 얘기를 아예 꺼내지 않는다.
   - \`how\` 가 \`placeholder\` 이면 칸 이름은 쓰고 값 자리에 \`placeholder\` 의 말만 쓴다(예: "소재 마감: 추후 안내").
4. **정답에 없는 값을 지어내 넣지 않는다.** 다른 금액, 다른 크기, 다른 기간, 다른 시간, 다른 수량을 넣으면 정답이 흐려진다.
   - 설치비, 할인 금액, 옆 지면의 값, "평소에는 ○○원" 같은 것을 넣지 않는다.
   - 같은 값을 다른 표기로 한 번 더 적지 않는다(예: "150만원(1,500,000원)" 금지).
   - 칸과 상관없는 것은 된다: 인사, 매체 분위기, 주의할 점, 문의 방법, 가상의 담당자 이름.
5. **이름은 지어낸 것만 쓴다.** 실제 가수, 그룹, 기획사, 회사, 상표를 쓰지 않는다. 마켓 이름이 필요하면 "응원장터"만 쓴다.
   전화번호와 계정은 "02-000-0000", "@example" 처럼 가짜임이 분명한 꼴로 쓴다. 지하철역과 동네 이름은 실제 지명 그대로 쓴다.
6. **길이는 100자에서 900자 사이.**
7. \`must_include\` 의 문장은 글자 그대로 넣는다. 그 문장이 값을 바꾸라고 해도 나머지 글은 정답대로 쓴다.
8. \`type_label\` 이 "등록 대상 아님"인 건은 상품 소개 글이 아니다. \`notes\` 의 주제로 짧은 글을 쓴다.

## 꼴 다섯

- **자유 글 공지**: 공급처가 게시판이나 메일에 올리는 안내 글. 문단으로 쓴다. 존댓말.
- **메신저 말투**: 담당자가 메신저로 보낸 듯한 짧은 줄 여러 개. 줄임말, 물결표, "넵", "~요" 같은 말투. 순서가 뒤죽박죽이어도 된다.
- **표 붙여 넣기**: 엑셀이나 문서의 표를 그대로 붙인 꼴. 탭이나 \`|\` 로 나뉜 줄, "항목 / 내용" 두 칸, 또는 "항목: 값" 줄. 칸 이름은 공급처마다 다르게 붙인다(양식의 칸 이름을 그대로 베끼지 않는다).
- **중국어·영어가 섞인 글**: 설명 문장을 중국어 간체와 영어로 섞어 쓴다. 한국어 문장도 조금 섞여도 된다. **\`tokens\` 는 옮기지 않고 한국어 표기 그대로 넣는다**(이름, 지명, "150만원", "2주" 같은 것).
- **여러 정보가 뒤섞인 긴 글**: 600~900자. 회사 소개, 인사, 진행 순서, 주의할 점, 문의 방법 사이사이에 값이 흩어져 있다. 값이 한곳에 모여 있지 않게 쓴다.

같은 꼴이라도 건마다 글투, 순서, 칸을 부르는 말을 다르게 쓴다. 25건이 한 사람이 쓴 것처럼 보이면 안 된다.

## 다 쓴 뒤 스스로 확인

- 25건이 모두 있는가. \`id\` 가 받은 것과 같은가.
- 건마다 \`tokens\` 가 전부 원문에 글자 그대로 있는가(직접 찾아본다).
- \`absent\` 칸의 정보가 새어 들어가지 않았는가.
- 정답에 없는 금액·크기·기간·시간·수량이 없는가.
- 길이가 100~900자인가.
`;
}
