// 양식 맞춤 파일의 약속. 내려받는 CSV 의 칸 이름과 순서를 정하는 대응표다.
// 파일은 data/export-templates/<name>.json 에 둔다. 이 표만 바꾸면 다른 마켓의 양식 꼴로 나온다.
import { z } from 'zod';
import { FIELD_KEYS, type FieldKey } from './fields';

/** 기본 틀의 이름. GET /api/export.csv 에 template 을 안 주면 이것을 쓴다. */
export const DEFAULT_EXPORT_TEMPLATE = 'default';

/**
 * 칸 값이 아닌 것 가운데 열로 뽑을 수 있는 것.
 * - product_id, draft_id: 번호        - type: 종류 코드(ad)   - type_label: 종류 이름(광고 지면)
 * - subtype: 갈래                     - title_en, summary_en, title_zh, summary_zh: 다른 언어 글
 * - text_status: 글 넷 가운데 하나라도 확인이 필요하면 needs_review, 아니면 ok. 글이 아직 없으면 빈칸
 * - approved_at: 승인한 시각(ISO 8601)
 */
export const EXPORT_EXTRA_SOURCES = [
  'product_id',
  'draft_id',
  'type',
  'type_label',
  'subtype',
  'title_en',
  'summary_en',
  'title_zh',
  'summary_zh',
  'text_status',
  'approved_at',
] as const;
export type ExportExtraSource = (typeof EXPORT_EXTRA_SOURCES)[number];

/** 열의 값이 나오는 곳: 칸 이름(FIELD_KEYS) 또는 위의 것. */
export const EXPORT_SOURCES: readonly string[] = [...EXPORT_EXTRA_SOURCES, ...FIELD_KEYS];
export type ExportSource = ExportExtraSource | FieldKey;

export function isExportSource(value: string): value is ExportSource {
  return EXPORT_SOURCES.includes(value);
}

/**
 * 값을 글자로 적는 법. 안 주면 'plain'.
 * - plain: 글자·수는 그대로, 참·거짓은 Y/N, 목록과 묶음 값은 아래의 사람이 읽는 꼴
 *     크기 "7x12", 해상도 "1920x1080", 시간 "05:00~01:00(+1)", 기간 옵션 "7일:1500000;14일:2800000",
 *     수량 옵션 "100개:800000", 파일 형식 "jpg;mp4"
 * - json: 값을 JSON 글 그대로(다른 프로그램이 읽을 때)
 * - yn: 참 Y, 거짓 N           - bool: 참 true, 거짓 false
 * - comma: 수에 세 자리 쉼표(1,500,000)
 * - width, height: 크기·해상도의 가로만 / 세로만
 * - open, close: 운영 시간의 시작만 / 끝만("05:00")
 * - next_day: 운영 시간의 끝이 다음 날이면 Y, 아니면 N(시작·끝을 따로 낼 때 이 열이 없으면 "다음 날"이 사라진다)
 * 값이 없으면(null) 어떤 서식이든 빈칸이다. 값의 꼴과 안 맞는 서식이면 plain 으로 적는다.
 */
export const EXPORT_FORMATS = ['plain', 'json', 'yn', 'bool', 'comma', 'width', 'height', 'open', 'close', 'next_day'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const header = z.string().min(1).max(100);

/** 열 하나. from(어느 값에서) 이나 value(늘 같은 글자) 가운데 하나만 적는다. */
export const ExportColumnSchema = z.union([
  z.strictObject({
    /** CSV 첫 줄에 적히는 칸 이름 */
    header,
    /** 값이 나오는 곳 */
    from: z.string().refine(isExportSource, '모르는 칸 이름이다'),
    format: z.enum(EXPORT_FORMATS).optional(),
  }),
  z.strictObject({
    header,
    /** 고정값. 모든 줄에 같은 글자가 들어간다(예: 통화 "KRW"). */
    value: z.string().max(200),
  }),
]);
export type ExportColumn =
  | { header: string; from: ExportSource; format?: ExportFormat }
  | { header: string; value: string };

/**
 * 양식 맞춤 파일 하나.
 * 예: { "name": "default", "columns": [
 *        { "header": "상품명", "from": "name" },
 *        { "header": "판매가", "from": "price_krw" },
 *        { "header": "통화", "value": "KRW" },
 *        { "header": "가로(m)", "from": "size_m", "format": "width" } ] }
 * 그 종류에 없는 칸(굿즈의 size_m)은 빈칸으로 나온다. 한 파일이 세 종류를 함께 담는다.
 */
export const ExportTemplateSchema = z
  .strictObject({
    /** 파일 이름과 같아야 한다(default.json → "default"). 소문자·숫자·줄표만. */
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
    /** (선택) 화면에 보이는 한 줄 설명 */
    description: z.string().max(200).optional(),
    columns: z.array(ExportColumnSchema).min(1).max(80),
  })
  .superRefine((template, ctx) => {
    const seen = new Set<string>();
    template.columns.forEach((column, i) => {
      if (seen.has(column.header)) {
        ctx.addIssue({ code: 'custom', path: ['columns', i, 'header'], message: '같은 칸 이름이 두 번 있다' });
      }
      seen.add(column.header);
    });
  });
export interface ExportTemplate {
  name: string;
  description?: string;
  columns: ExportColumn[];
}

/** 틀 이름의 꼴. 주소의 template= 값을 파일 이름으로 쓰기 전에 꼭 이것으로 본다(경로 글자를 막는다). */
export function isExportTemplateName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);
}

/**
 * CSV 를 쓸 때 지킬 것(내려받기를 만드는 쪽의 약속).
 * - 첫 줄은 칸 이름. 줄 끝은 \r\n. 맨 앞에 BOM 을 붙인다(표 프로그램이 한글을 바로 읽게).
 * - 쉼표·따옴표·줄바꿈이 든 칸은 큰따옴표로 감싸고 안의 따옴표는 두 번 적는다.
 * - =, +, -, @, 탭, 줄 돌림(CR)으로 시작하는 글자 칸은 앞에 ' 를 붙인다(수식으로 읽히지 않게). 수로만 된 칸은 그대로 둔다.
 */
export const CSV_RULES = { bom: true, newline: '\r\n', formulaPrefix: "'", formulaStarts: ['=', '+', '-', '@', '\t', '\r'] } as const;
