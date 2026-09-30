import type * as PageTree from 'fumadocs-core/page-tree';
import type { WikiTreeEntry } from '@/lib/api';
import { documentHref, friendlyDocumentTitle } from '@/lib/links';

export function createPageTree(notes: WikiTreeEntry[]): PageTree.Root {
  const root: PageTree.Root = {
    type: 'root',
    name: 'Framework Wiki',
    children: [],
  };
  const folders = new Map<string, PageTree.Folder>();
  const sorted = [...notes].sort((a, b) => a.path.localeCompare(b.path, 'ko'));

  for (const note of sorted) {
    const segments = note.path.replace(/\\/g, '/').split('/').filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) continue;

    const directorySegments = segments.slice(0, -1);
    let children = root.children;
    let currentPath = '';

    for (const segment of directorySegments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let folder = folders.get(currentPath);
      if (!folder) {
        folder = {
          type: 'folder',
          name: segment,
          $id: currentPath,
          children: [],
        };
        folders.set(currentPath, folder);
        children.push(folder);
      }
      children = folder.children;
    }

    const page: PageTree.Item = {
      type: 'page',
      name: friendlyDocumentTitle(note.title, note.path),
      url: documentHref(note.path),
      $id: note.path,
    };
    const duplicate = children.some((node) => node.type === 'page' && node.$id === note.path);
    if (!duplicate) children.push(page);
  }

  return root;
}
