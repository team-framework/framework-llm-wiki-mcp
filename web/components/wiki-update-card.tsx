'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, GitPullRequest, LoaderCircle } from 'lucide-react';

export type WikiUpdate = {
  id: string; summary: string; status: 'pending' | 'published'; pr_url?: string; can_publish?: boolean;
  changes: { action: 'create' | 'update' | 'delete'; path: string; content?: string; before: string | null }[];
};
const actionLabels = { create: '생성', update: '수정', delete: '삭제' };

export function WikiUpdateCard({ proposal }: { proposal: WikiUpdate }) {
  const [update, setUpdate] = useState(proposal);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setUpdate(proposal); setError(null); }, [proposal]);

  async function publish() {
    if (publishing) return;
    setPublishing(true); setError(null);
    try {
      const response = await fetch(`/api/chat/updates/${update.id}/publish`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', cache: 'no-store', body: '{}',
      });
      const value = await response.json();
      if (!response.ok) throw new Error(typeof value.message === 'string' ? value.message : 'PR 생성 결과를 확인하지 못했습니다. 다시 시도해 주세요.');
      if (value.wiki_update?.status !== 'published' || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(value.wiki_update.pr_url)) throw new Error('PR 주소를 확인하지 못했습니다. 다시 시도해 주세요.');
      setUpdate(value.wiki_update);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'PR을 만들지 못했습니다.'); }
    finally { setPublishing(false); }
  }

  return (
    <section className="wiki-update-card" aria-label="문서 변경안">
      <div className="wiki-update-heading"><GitPullRequest size={16} aria-hidden="true" /><strong>{update.status === 'published' ? '문서 PR을 열었습니다' : '문서 변경안'}</strong><span>Framework Bot</span></div>
      <div className="wiki-update-files">
        {update.changes.map((change) => (
          <details key={change.path} className="wiki-update-file">
            <summary><span className={'wiki-update-action wiki-update-action-' + change.action}>{actionLabels[change.action]}</span><span>{change.path}</span></summary>
            <div className="wiki-update-diff">
              {change.before !== null && <div><span className="wiki-update-diff-label">현재 문서</span><pre className="wiki-update-before">{change.before}</pre></div>}
              {change.action !== 'delete' && <div><span className="wiki-update-diff-label">변경 후</span><pre className="wiki-update-after">{change.content}</pre></div>}
              {change.action === 'delete' && <p className="wiki-update-delete-note">이 문서의 전체 내용을 삭제하는 PR을 만듭니다.</p>}
            </div>
          </details>
        ))}
      </div>
      <div className="wiki-update-footer">
        {update.pr_url ? <><span>검토 후 병합하면 위키에 반영됩니다.</span><a href={update.pr_url} target="_blank" rel="noopener noreferrer">PR 보기 <ExternalLink size={13} aria-hidden="true" /></a></> : <>
          <span>{update.can_publish === false ? '요청한 팀원이 PR을 열 수 있습니다.' : '변경 내용을 확인하고 Draft PR을 여세요.'}</span>
          <button type="button" onClick={() => void publish()} disabled={publishing || update.can_publish === false}>
            {publishing ? <><LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> PR 생성 중…</> : 'PR 열기'}
          </button>
        </>}
      </div>
      {error && <p className="wiki-update-error" role="alert">{error}</p>}
    </section>
  );
}
