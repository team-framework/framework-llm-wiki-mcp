import GithubSlugger from 'github-slugger';

export function documentHref(path: string) {
  const segments = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..');

  return segments.length ? `/docs/${segments.map(encodeURIComponent).join('/')}` : '/docs';
}

export function decodeDocumentPath(segments: string[]) {
  return segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }).join('/');
}

export function friendlyDocumentTitle(title: string, path = '') {
  const fallback = path.split(/[\\/]/).filter(Boolean).at(-1)?.replace(/\.md$/i, '') ?? '';
  const initial = title.trim() || fallback;
  return initial
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\.md$/i, '')
    .replace(/__\d+(?=$|[\s.)_-])/g, '')
    .replace(/^__\d+[_\s.-]*/, '')
    .trim() || fallback.replace(/__\d+(?=$|[\s.)_-])/g, '').replace(/^__\d+[_\s.-]*/, '');
}

export function normalizeNoteReference(value: string) {
  return value
    .split('#', 1)[0]
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.md$/i, '')
    .trim()
    .toLocaleLowerCase();
}

export function headingId(heading: string) {
  const slugger = new GithubSlugger();
  return slugger.slug(heading);
}

export function stripLeadingTitleHeading(markdown: string, title: string) {
  const match = markdown.match(/^\s*#\s+([^\n]+)\s*(?:\r?\n|$)/);
  if (!match || match[1].trim().toLocaleLowerCase() !== title.trim().toLocaleLowerCase()) return markdown;
  return markdown.slice(match[0].length).replace(/^\s*\r?\n/, '');
}
