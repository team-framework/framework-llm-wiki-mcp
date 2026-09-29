import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import { WikiMarkdown } from '@/components/wiki-markdown';
import { loadWikiNote, loadWikiTree } from '@/lib/api';
import { documentHeadings } from '@/lib/markdown';
import { decodeDocumentPath, documentHref, stripLeadingTitleHeading } from '@/lib/links';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteProps = { params: Promise<{ slug?: string[] }> };

function displayMetadata(value: unknown) {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return [];
}

function unavailableMessage(reason: 'unauthorized' | 'not-found' | 'unavailable' | 'invalid') {
  if (reason === 'not-found') return '요청한 문서를 찾을 수 없습니다.';
  if (reason === 'unauthorized') return '이 문서를 보려면 팀 계정으로 로그인해야 합니다.';
  return '문서를 불러오지 못했습니다. 잠시 후 다시 시도하세요.';
}

async function WikiIndex() {
  const result = await loadWikiTree();
  if (!result.ok) {
    return (
      <DocsPage>
        <DocsTitle>Framework 위키</DocsTitle>
        <DocsDescription>팀의 기술 문서와 프로젝트 기록을 검색하고 읽어 보세요.</DocsDescription>
        <DocsBody>
          <p>{unavailableMessage(result.reason)}</p>
          {result.reason === 'unauthorized' && <p><a href="/auth/github/login">GitHub로 로그인</a></p>}
        </DocsBody>
      </DocsPage>
    );
  }

  const groups = new Map<string, typeof result.data>();
  for (const note of result.data) {
    const name = typeof note.domain === 'string' && note.domain.trim()
      ? note.domain.trim()
      : note.path.split('/')[0] || '기타 문서';
    groups.set(name, [...(groups.get(name) ?? []), note]);
  }

  const orderedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko'));
  return (
    <DocsPage>
      <DocsTitle>Framework 위키</DocsTitle>
      <DocsDescription>팀의 기술 문서와 프로젝트 기록을 검색하고 읽어 보세요.</DocsDescription>
      <DocsBody>
        <p>현재 {result.data.length.toLocaleString('ko-KR')}개 문서를 제공하고 있습니다. 주제를 고르거나 위쪽 검색창에서 키워드를 입력하세요.</p>
        <h2>주제별 문서</h2>
        {orderedGroups.length > 0 ? (
          <div className="wiki-overview-grid">
            {orderedGroups.map(([name, notes]) => {
              const first = notes[0];
              return (
                <Link className="wiki-overview-card" href={documentHref(first.path)} key={name}>
                  <strong>{name}</strong>
                  <span>{notes.length}개 문서 · {first.title}</span>
                </Link>
              );
            })}
          </div>
        ) : (
          <p>표시할 문서가 없습니다.</p>
        )}
        <h2>위키 Agent</h2>
        <p>Discord에서는 Agent를 멘션하거나 Agent 답글에 회신해 논의할 수 있습니다. 이 화면의 <strong>위키 Agent</strong> 버튼으로도 위키 내용을 질문할 수 있습니다.</p>
      </DocsBody>
    </DocsPage>
  );
}

export default async function WikiDocumentPage({ params }: RouteProps) {
  const { slug = [] } = await params;
  if (slug.length === 0) return <WikiIndex />;

  const path = decodeDocumentPath(slug);
  const result = await loadWikiNote(path);
  if (!result.ok && result.reason === 'not-found') notFound();

  if (!result.ok) {
    return (
      <DocsPage>
        <DocsTitle>문서를 불러올 수 없습니다</DocsTitle>
        <DocsBody>
          <div className="wiki-auth-card" role="status">
            <p>{unavailableMessage(result.reason)}</p>
            {result.reason === 'unauthorized' && <a href="/auth/github/login">GitHub로 로그인</a>}
            <p><Link href="/docs">위키 첫 화면으로 돌아가기</Link></p>
          </div>
        </DocsBody>
      </DocsPage>
    );
  }

  const note = result.data;
  const body = stripLeadingTitleHeading(note.body, note.title);
  const description = typeof note.metadata.question === 'string' ? note.metadata.question : undefined;
  const metadata = [
    ...displayMetadata(note.metadata.domain).map((value) => `주제 · ${value}`),
    ...displayMetadata(note.metadata.owner).map((value) => `담당 · ${value}`),
    ...(typeof note.metadata.verification === 'string' ? [`검증 · ${note.metadata.verification}`] : []),
  ];

  return (
    <DocsPage toc={documentHeadings(body)}>
      <DocsTitle>{note.title}</DocsTitle>
      <DocsDescription>{description}</DocsDescription>
      {metadata.length > 0 && (
        <div className="wiki-note-meta" aria-label="문서 정보">
          {metadata.map((item) => <span key={item}>{item}</span>)}
        </div>
      )}
      <DocsBody>
        <WikiMarkdown markdown={body} resolvedLinks={note.resolved_links ?? []} />
      </DocsBody>
    </DocsPage>
  );
}
