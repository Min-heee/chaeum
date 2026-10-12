// 상품 목록과 양식으로 내려받기. 양식 이름은 서버에서 읽어 넘긴다(목록을 주는 API 경로는 없다).
import type { Metadata } from 'next';
import { listExportTemplates } from '@/server/service';
import { Products, type TemplateInfo } from '../../components/Products';

export const metadata: Metadata = { title: '상품 · 채움' };
export const dynamic = 'force-dynamic';

export default function ProductsPage() {
  let templates: TemplateInfo[];
  try {
    templates = listExportTemplates();
  } catch (err) {
    console.error('[page] 양식 목록을 읽지 못했다:', err instanceof Error ? err.name : 'unknown');
    templates = [{ name: 'default', description: null }];
  }
  return <Products templates={templates} />;
}
