'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { recordWebEvent } from '@/lib/measurements';

export function DocumentViewTracker({ path }: { path: string }) {
  const pathname = usePathname();
  const recordedPathname = useRef<string | null>(null);

  useEffect(() => {
    if (!path || !pathname || recordedPathname.current === pathname) return;
    recordedPathname.current = pathname;
    recordWebEvent({ feature: 'web.document_view', path });
  }, [path, pathname]);

  return null;
}
