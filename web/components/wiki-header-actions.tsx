'use client';

import { SearchBox } from '@/components/search-box';
import { WikiChat } from '@/components/wiki-chat';

export function WikiHeaderActions() {
  return (
    <div className="wiki-header-actions">
      <SearchBox />
      <WikiChat />
    </div>
  );
}
