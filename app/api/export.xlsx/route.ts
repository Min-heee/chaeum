// 32. XLSX 내려받기. 양식 꼴을 시트 셋(상품 · 옵션 · 안내)으로 넓힌 파일. template 으로 양식을 고른다.
import { XLSX_CONTENT_TYPE, XlsxExportQuerySchema } from '@/contract/tools/xlsx';
import { exportXlsx } from '@/server/export-xlsx';
import { readQuery, readWorkspace, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route('GET /export.xlsx', async (request: Request) => {
  const workspaceId = readWorkspace(request);
  const { template } = readQuery(request, XlsxExportQuerySchema);
  const xlsx = await exportXlsx(workspaceId, { template, now: new Date() });
  return new Response(new Uint8Array(xlsx.body), {
    status: 200,
    headers: {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="${xlsx.filename}"`,
      'Content-Length': String(xlsx.body.byteLength),
      'Cache-Control': 'no-store',
    },
  });
});
