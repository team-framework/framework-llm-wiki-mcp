'use client';

import { useState } from 'react';
import type { ResolvedWikiLink } from '@/lib/api';
import { WikiMarkdown } from '@/components/wiki-markdown';

type WikiNoteContentProps = {
  sourceBody: string;
  displayBody?: string;
  stale: boolean;
  resolvedLinks: ResolvedWikiLink[];
};

export function WikiNoteContent({ sourceBody, displayBody, stale, resolvedLinks }: WikiNoteContentProps) {
  const hasDisplay = Boolean(displayBody?.trim());
  const [showSource, setShowSource] = useState(!hasDisplay || stale);

  return (
    <>
      {stale && hasDisplay && (
        <p className="wiki-display-stale" role="note">
          표시 본문이 원문 변경 전 작성됐습니다. 최신 원문을 기본으로 보여줍니다.
        </p>
      )}
      {hasDisplay && (
        <div className="wiki-note-body-controls">
          <button type="button" onClick={() => setShowSource((value) => !value)}>
            {showSource ? (stale ? '오래된 표시 본문 보기' : '표시 본문 보기') : '원문 보기'}
          </button>
          <span>{showSource ? 'Markdown 원문' : '읽기 쉬운 표시 본문'}</span>
        </div>
      )}
      <WikiMarkdown markdown={showSource ? sourceBody : displayBody ?? sourceBody} resolvedLinks={resolvedLinks} />
    </>
  );
}
