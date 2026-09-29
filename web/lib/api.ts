import { headers } from 'next/headers';

export interface WikiTreeEntry {
  path: string;
  title: string;
  domain?: string | string[] | null;
}

export interface ResolvedWikiLink {
  link: string;
  status: 'resolved' | 'ambiguous' | 'unresolved';
  path?: string;
  candidates?: string[];
}

export interface WikiNote {
  path: string;
  title: string;
  content: string;
  body: string;
  metadata: Record<string, unknown>;
  resolved_links: ResolvedWikiLink[];
}

export type LoadResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; reason: 'unauthorized' | 'not-found' | 'unavailable' | 'invalid' };

function apiUrl(path: string) {
  const baseUrl = process.env.WIKI_API_URL?.trim() || 'http://127.0.0.1:3100';
  return new URL(path, `${baseUrl.replace(/\/+$/, '')}/`);
}

async function forwardedHeaders() {
  const requestHeaders = await headers();
  const result = new Headers();
  const cookie = requestHeaders.get('cookie');
  const authorization = requestHeaders.get('authorization');

  if (cookie) result.set('cookie', cookie);
  if (authorization) result.set('authorization', authorization);

  return result;
}

async function requestWiki(path: string) {
  try {
    const response = await fetch(apiUrl(path), {
      headers: await forwardedHeaders(),
      cache: 'no-store',
      redirect: 'manual',
    });

    if (!response.ok) {
      return {
        ok: false as const,
        status: response.status,
        reason: response.status === 401 ? 'unauthorized' as const : response.status === 404 ? 'not-found' as const : 'unavailable' as const,
      };
    }

    return { ok: true as const, status: response.status, data: await response.json() as unknown };
  } catch {
    return { ok: false as const, status: 503, reason: 'unavailable' as const };
  }
}

function isTreeEntry(value: unknown): value is WikiTreeEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.path === 'string' && typeof entry.title === 'string';
}

function isWikiNote(value: unknown): value is WikiNote {
  if (!value || typeof value !== 'object') return false;
  const note = value as Record<string, unknown>;
  return typeof note.path === 'string'
    && typeof note.title === 'string'
    && typeof note.body === 'string'
    && !!note.metadata
    && typeof note.metadata === 'object'
    && Array.isArray(note.resolved_links)
    && note.resolved_links.every((link) => Boolean(
      link && typeof link === 'object'
      && typeof (link as Record<string, unknown>).link === 'string'
      && ['resolved', 'ambiguous', 'unresolved'].includes(String((link as Record<string, unknown>).status)),
    ));
}

export async function loadWikiTree(): Promise<LoadResult<WikiTreeEntry[]>> {
  const response = await requestWiki('/api/tree');
  if (!response.ok) return response;
  if (!Array.isArray(response.data) || !response.data.every(isTreeEntry)) {
    return { ok: false, status: 502, reason: 'invalid' };
  }

  return { ok: true, data: response.data };
}

export async function loadWikiNote(path: string): Promise<LoadResult<WikiNote>> {
  const query = new URLSearchParams({ path });
  const response = await requestWiki(`/api/note?${query.toString()}`);
  if (!response.ok) return response;
  if (!isWikiNote(response.data)) return { ok: false, status: 502, reason: 'invalid' };

  return { ok: true, data: response.data };
}
