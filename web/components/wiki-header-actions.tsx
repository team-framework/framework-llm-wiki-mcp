'use client';

import Link from 'next/link';
import { BookOpen } from 'lucide-react';
import { SearchBox } from '@/components/search-box';
import { WikiChat } from '@/components/wiki-chat';

type WikiHeaderActionsProps = { variant: 'compact' | 'sidebar' };

export function WikiHeaderActions({ variant }: WikiHeaderActionsProps) {
  const compact = variant === 'compact';

  return (
    <div className={`wiki-header-actions wiki-header-actions-${variant}`}>
      <SearchBox compact={compact} />
      <WikiChat compact={compact} />
      <Link
        className={`wiki-guide-link${compact ? ' wiki-guide-link-compact' : ''}`}
        href="/docs/bot-guide"
        aria-label="Bot 사용법"
        title="Bot 사용법"
      >
        <BookOpen size={16} aria-hidden="true" />
        <span>Bot 사용법</span>
      </Link>
    </div>
  );
}
