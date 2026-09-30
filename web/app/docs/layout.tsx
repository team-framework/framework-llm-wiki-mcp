import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { WikiHeaderActions } from '@/components/wiki-header-actions';
import { WikiBrand } from '@/components/wiki-brand';
import { loadWikiTree } from '@/lib/api';
import { createPageTree } from '@/lib/page-tree';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function LoginRequired() {
  return (
    <main className="wiki-login">
      <WikiBrand />
      <h1>로그인이 필요합니다</h1>
      <p>팀 GitHub 계정으로 로그인해 Framework Wiki를 읽으세요.</p>
      <a className="wiki-login-link" href="/auth/github/login">
        GitHub로 로그인
      </a>
    </main>
  );
}

function WikiUnavailable() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-6">
      <div className="wiki-auth-card" role="status">
        위키 서버에 연결하지 못했습니다. 잠시 후 페이지를 새로고침해 주세요.
      </div>
    </div>
  );
}

export default async function WikiDocsLayout({ children }: { children: ReactNode }) {
  const result = await loadWikiTree();
  const tree = createPageTree(result.ok ? result.data : []);

  return (
    <DocsLayout
      tree={tree}
      nav={{
        title: <WikiBrand />,
        url: '/docs',
        children: <WikiHeaderActions variant="compact" />,
      }}
      sidebar={{ banner: <WikiHeaderActions variant="sidebar" /> }}
      searchToggle={{ enabled: false }}
    >
      {!result.ok && result.reason === 'unauthorized'
        ? <LoginRequired />
        : <>{!result.ok && <WikiUnavailable />}{children}</>}
    </DocsLayout>
  );
}
