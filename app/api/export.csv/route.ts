// 11. CSV 내려받기. kind=products(양식 꼴, template 으로 양식 고르기) 또는 kind=corrections(사람이 고친 값).
import { ExportQuerySchema } from '@/contract/api';
import { exportCsv } from '@/server/service';
import { readQuery, readWorkspace, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route('GET /export.csv', async (request: Request) => {
  const workspaceId = readWorkspace(request);
  const { kind, template } = readQuery(request, ExportQuerySchema);
  const csv = await exportCsv(workspaceId, { kind, template });
  return new Response(csv.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csv.filename}"`,
      'Cache-Control': 'no-store',
    },
  });
});
