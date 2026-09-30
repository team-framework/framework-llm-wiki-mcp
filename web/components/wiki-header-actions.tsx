'use client';

import Link from 'next/link';
import { BarChart3, BookOpen } from 'lucide-react';
import { SearchBox } from '@/components/search-box';
import { WikiFeedbackButton } from '@/components/wiki-feedback-widget';

type WikiHeaderActionsProps = { variant: 'compact' | 'sidebar' };

export function WikiHeaderActions({ variant }: WikiHeaderActionsProps) {
  const compact = variant === 'compact';

  return (
    <div className={`wiki-header-actions wiki-header-actions-${variant}`}>
      <SearchBox compact={compact} />
      <WikiFeedbackButton compact={compact} />
      <Link
        className={`wiki-guide-link${compact ? ' wiki-guide-link-compact' : ''}`}
        href="/docs/bot-guide"
        aria-label="Bot 사용법"
        title="Bot 사용법"
      >
        <BookOpen size={16} aria-hidden="true" />
        <span>Bot 사용법</span>
      </Link>
      <Link
        className={`wiki-guide-link wiki-insights-link${compact ? ' wiki-guide-link-compact' : ''}`}
        href="/docs/insights"
        aria-label="위키 사용 현황"
        title="위키 사용 현황"
      >
        <BarChart3 size={16} aria-hidden="true" />
        <span>사용 현황</span>
      </Link>
    </div>
  );
}
