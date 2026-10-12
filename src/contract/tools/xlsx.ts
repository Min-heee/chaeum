// XLSX 내려받기의 약속. 양식 맞춤 파일(export-template.ts)을 여러 시트로 넓힌다.
//
//   GET /api/export.xlsx?template=<양식 이름>     응답은 XLSX 파일. template 을 비우면 기본 양식. 없는 이름이면 404
//
// CSV 는 한 줄에 상품 하나라 기간·수량 옵션이 한 칸에 "7일:1500000;14일:2800000" 으로 눌려 들어간다.
// XLSX 는 시트를 셋으로 나눠 옵션 하나가 한 줄이 되게 한다. 두 시트는 상품 열쇠(상품번호)로 잇는다.
//   · "상품" 시트: 한 줄에 상품 하나. 양식의 열 그대로다. 다만 옵션 칸(period_options, quantity_options)에서 온 열은 뺀다.
//       첫 열은 늘 상품 열쇠다. 양식에 product_id 열이 있으면 그 열을 맨 앞으로 옮기고(칸 이름은 양식의 것), 없으면 "상품번호" 열을 더한다.
//   · "옵션" 시트: 한 줄에 옵션 하나. 열은 XLSX_OPTION_COLUMNS 로 고정이다. 굿즈처럼 옵션이 없는 상품은 줄이 없다.
//   · "안내" 시트: 이 파일이 무엇인지, 시트를 어떻게 잇는지, 만든 날짜와 양식 이름, 줄 수.
import { z } from 'zod';
import type { ExportSource } from '../export-template';

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 시트 이름과 순서. */
export const XLSX_SHEETS = { products: '상품', options: '옵션', guide: '안내' } as const;

/** 양식에 상품 열쇠 열이 없을 때 더하는 열의 칸 이름. 값은 상품 번호(products.id)다. */
export const XLSX_KEY_HEADER = '상품번호';

/** 옵션 칸. 이 칸에서 온 열은 "상품" 시트에서 빠지고 "옵션" 시트의 줄이 된다. */
export const XLSX_OPTION_SOURCES = ['period_options', 'quantity_options'] as const satisfies readonly ExportSource[];

/** 옵션의 갈래. 기간: 광고 지면의 기간 옵션. 수량: 케이터링의 수량 옵션. */
export const XLSX_OPTION_KINDS = { period_options: '기간', quantity_options: '수량' } as const;

/**
 * "옵션" 시트의 열(고정). 상품번호는 "상품" 시트의 첫 열과 같은 값이다.
 * 기간 옵션은 일수에, 수량 옵션은 수량에 값이 있고 다른 쪽은 빈칸이다. 줄은 상품 순서대로, 그 안에서는 일수(수량)가 작은 것부터.
 */
export const XLSX_OPTION_COLUMNS = ['상품번호', '상품명', '옵션종류', '일수', '수량', '값(원)'] as const;

/**
 * 칸을 쓸 때 지킬 것.
 * - 첫 줄은 칸 이름이다.
 * - 수는 수 칸으로, 글자는 글자 칸으로 쓴다(CSV 처럼 전부 글자로 바꾸지 않는다). 값이 없으면 빈칸.
 * - 묶음 값(크기, 시간, 형식 목록)은 CSV 와 같은 사람이 읽는 꼴의 글자다(export-template.ts 의 서식 설명).
 * - 수식 칸은 쓰지 않는다. "=" 로 시작하는 글자도 글자 칸에 그대로 넣는다. 표 프로그램은 글자 칸을 수식으로 읽지 않으므로
 *   CSV 처럼 앞에 ' 를 붙이지 않는다(붙이면 값이 달라진다).
 */
export const XLSX_RULES = { headerRow: true, formulaCells: false } as const;

/** GET /api/export.xlsx 의 주소 값. template 은 양식 맞춤 파일의 이름이다. 꼴이 틀리면 400, 없는 이름이면 404. */
export const XlsxExportQuerySchema = z.object({
  template: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
});
export type XlsxExportQuery = z.infer<typeof XlsxExportQuerySchema>;

/** 내려받는 파일 이름. */
export function xlsxFileName(template: string): string {
  return `chaeum-products-${template}.xlsx`;
}
