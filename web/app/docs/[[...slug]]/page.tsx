import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { notFound } from 'next/navigation';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import { DocumentViewTracker } from '@/components/document-view-tracker';
import { WikiNoteContent } from '@/components/wiki-note-content';
import { loadWikiNote, loadWikiTree } from '@/lib/api';
import { documentHeadings } from '@/lib/markdown';
import { decodeDocumentPath, documentHref, friendlyDocumentTitle, stripLeadingTitleHeading } from '@/lib/links';

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
        <DocsTitle>Framework Wiki</DocsTitle>
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
      : note.path.includes('/') ? note.path.split('/')[0] : '프로젝트';
    groups.set(name, [...(groups.get(name) ?? []), note]);
  }

  const orderedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko'));
  return (
    <DocsPage>
      <DocsTitle className="wiki-index-title">Framework Wiki</DocsTitle>
      <DocsDescription className="wiki-index-description">팀의 기술 문서와 프로젝트 기록.</DocsDescription>
      <DocsBody>
        <p className="wiki-index-summary">{result.data.length.toLocaleString('ko-KR')}개 문서. 주제를 선택하거나 문서를 검색하세요.</p>
        <div className="wiki-index-section">
          <h2>주제별 문서</h2>
          <span>{orderedGroups.length}개 주제</span>
        </div>
        {orderedGroups.length > 0 ? (
          <ul className="wiki-overview-list">
            {orderedGroups.map(([name, notes]) => {
              const first = notes[0];
              return (
                <li key={name}>
                  <Link className="wiki-overview-link" href={documentHref(first.path)}>
                    <span>
                      <strong>{name}</strong>
                      <span className="wiki-overview-preview">{friendlyDocumentTitle(first.title, first.path)}</span>
                    </span>
                    <span className="wiki-overview-count">{notes.length}개 문서</span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p>표시할 문서가 없습니다.</p>
        )}
        <div className="wiki-index-help">
          <p>문서에서 답을 찾기 어렵다면 위키 Agent에 질문하세요.</p>
          <Link href="/docs/bot-guide">Agent 사용법 <span aria-hidden="true">↗</span></Link>
        </div>
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
  const displayTitle = friendlyDocumentTitle(note.display?.title ?? note.title, note.path);
  const sourceBody = stripLeadingTitleHeading(note.body, note.title);
  const displayBody = note.display?.content
    ? stripLeadingTitleHeading(note.display.content, note.display.title ?? displayTitle)
    : undefined;
  const defaultBody = displayBody && !note.display?.stale ? displayBody : sourceBody;
  const description = typeof note.metadata.question === 'string' ? note.metadata.question : undefined;
  const metadata = [
    ...displayMetadata(note.metadata.domain).map((value) => `주제 · ${value}`),
    ...displayMetadata(note.metadata.owner).map((value) => `담당 · ${value}`),
    ...(typeof note.metadata.verification === 'string' ? [`검증 · ${note.metadata.verification}`] : []),
  ];

  return (
    <DocsPage toc={documentHeadings(defaultBody)}>
      <DocumentViewTracker path={note.path} />
      <DocsTitle>{displayTitle}</DocsTitle>
      <DocsDescription>{description}</DocsDescription>
      {metadata.length > 0 && (
        <div className="wiki-note-meta" aria-label="문서 정보">
          {metadata.map((item) => <span key={item}>{item}</span>)}
        </div>
      )}
      <DocsBody>
        <WikiNoteContent
          key={`${note.path}:${note.note_hash ?? ''}`}
          sourceBody={sourceBody}
          displayBody={displayBody}
          stale={note.display?.stale === true}
          resolvedLinks={note.resolved_links ?? []}
        />
      </DocsBody>
    </DocsPage>
  );
}
