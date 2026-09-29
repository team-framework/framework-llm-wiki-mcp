'use client';

import type { ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import type { ResolvedWikiLink } from '@/lib/api';
import { remarkWikiLinks } from '@/lib/markdown';

function MarkdownAnchor({ href, children, ...props }: ComponentProps<'a'>) {
  const external = href?.startsWith('https://') || href?.startsWith('http://');
  return (
    <a href={href} {...props} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
      {children}
    </a>
  );
}

export function WikiMarkdown({ markdown, resolvedLinks = [] }: { markdown: string; resolvedLinks?: ResolvedWikiLink[] }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, [remarkWikiLinks, resolvedLinks]]}
      rehypePlugins={[rehypeSlug]}
      components={{ a: MarkdownAnchor }}
    >
      {markdown}
    </ReactMarkdown>
  );
}
