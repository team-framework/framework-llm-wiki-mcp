import type { PhrasingContent, Root, RootContent, Text } from 'mdast';
import GithubSlugger from 'github-slugger';
import { toString } from 'mdast-util-to-string';
import { visit } from 'unist-util-visit';
import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { TOCItemType } from 'fumadocs-core/toc';
import type { ResolvedWikiLink } from '@/lib/api';
import { documentHref, normalizeNoteReference } from '@/lib/links';

export function documentHeadings(markdown: string): TOCItemType[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const slugger = new GithubSlugger();
  const headings: TOCItemType[] = [];

  function collect(nodes: RootContent[]) {
    for (const node of nodes) {
      if (node.type === 'heading') {
        const title = toString(node)
          .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
          .replace(/\[\[([^\]]+)\]\]/g, '$1')
          .trim();
        if (title) headings.push({ title, url: `#${slugger.slug(title)}`, depth: node.depth });
      }

      if ('children' in node) collect(node.children as RootContent[]);
    }
  }

  collect(tree.children);
  return headings;
}

export const remarkWikiLinks: Plugin<[ResolvedWikiLink[]], Root> = (resolvedLinks) => {
  const lookup = new Map(resolvedLinks.map((entry) => [normalizeNoteReference(entry.link), entry]));

  return (tree) => {
    visit(tree, 'text', (node, index, parent) => {
      if (index === undefined || !parent) return;

      const text = (node as Text).value;
      const pattern = /\[\[([^\]]+)\]\]/g;
      const matches = [...text.matchAll(pattern)];
      if (matches.length === 0) return;

      const replacement: PhrasingContent[] = [];
      let cursor = 0;

      for (const match of matches) {
        const matchIndex = match.index ?? 0;
        if (matchIndex > cursor) replacement.push({ type: 'text', value: text.slice(cursor, matchIndex) });

        const [reference = '', label] = match[1].split('|', 2);
        const target = reference.trim();
        const resolved = lookup.get(normalizeNoteReference(target));
        const children: PhrasingContent[] = [{ type: 'text', value: label?.trim() || target }];

        if (resolved?.status === 'resolved' && resolved.path) {
          const fragment = target.includes('#') ? target.slice(target.indexOf('#') + 1).trim() : '';
          const suffix = fragment ? `#${encodeURIComponent(fragment)}` : '';
          replacement.push({
            type: 'link',
            url: `${documentHref(resolved.path)}${suffix}`,
            children,
          });
        } else {
          replacement.push(...children);
        }

        cursor = matchIndex + match[0].length;
      }

      if (cursor < text.length) replacement.push({ type: 'text', value: text.slice(cursor) });

      const siblings = parent.children as PhrasingContent[];
      siblings.splice(index, 1, ...replacement);
      return index + replacement.length;
    });
  };
};
