import type { Metadata } from 'next';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import { InsightsDashboard } from '@/components/insights-dashboard';

export const metadata: Metadata = {
  title: '위키 사용 현황',
  description: '위키 사용량과 팀 의견을 확인합니다.',
};

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function WikiInsightsPage() {
  return (
    <DocsPage>
      <DocsTitle>위키 사용 현황</DocsTitle>
      <DocsDescription>팀의 위키 이용 흐름과 개선 의견을 확인합니다.</DocsDescription>
      <DocsBody><InsightsDashboard /></DocsBody>
    </DocsPage>
  );
}
