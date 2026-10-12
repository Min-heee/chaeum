// API 탭: 화면에서 누른 것과 같은 일을 하는 curl.
import type { Metadata } from 'next';
import { ApiGuide } from '../../components/ApiGuide';

export const metadata: Metadata = { title: 'API · 채움' };

export default function ApiGuidePage() {
  return <ApiGuide />;
}
