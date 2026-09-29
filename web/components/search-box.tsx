'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { documentHref } from '@/lib/links';

interface SearchResult {
  path: string;
  title: string;
  excerpt?: string;
}

export function SearchBox() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setLoading(false);
      setUnauthorized(false);
      setFailed(false);
      return;
    }

    setResults([]);
    setLoading(true);
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setUnauthorized(false);
      setFailed(false);
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (response.status === 401) {
          setUnauthorized(true);
          setResults([]);
          return;
        }
        if (!response.ok) throw new Error('검색 요청이 실패했습니다.');

        const data: unknown = await response.json();
        const nextResults = Array.isArray(data)
          ? data.filter((item): item is SearchResult => Boolean(
            item && typeof item === 'object'
            && typeof item.path === 'string'
            && typeof item.title === 'string',
          ))
          : [];
        setResults(nextResults);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setResults([]);
        setFailed(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 240);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (results[0]) router.push(documentHref(results[0].path));
  }

  const showResults = focused && query.trim().length > 0;

  return (
    <form className="wiki-search" role="search" onSubmit={submit}>
      <div className="wiki-search-field">
        <Search size={16} aria-hidden="true" />
        <input
          aria-label="위키 검색"
          autoComplete="off"
          placeholder="위키 검색"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 140)}
        />
      </div>

      {showResults && (
        <div className="wiki-search-results" role="region" aria-label="검색 결과">
          {query.trim().length < 2 && <p className="wiki-search-status">두 글자 이상 입력하세요.</p>}
          {query.trim().length >= 2 && loading && <p className="wiki-search-status">문서를 찾고 있습니다…</p>}
          {unauthorized && (
            <p className="wiki-search-status">
              위키 검색은 로그인 후 사용할 수 있습니다. <a href="/auth/github/login">GitHub 로그인</a>
            </p>
          )}
          {failed && <p className="wiki-search-status">검색을 불러오지 못했습니다. 잠시 후 다시 시도하세요.</p>}
          {!loading && !unauthorized && !failed && query.trim().length >= 2 && results.length === 0 && (
            <p className="wiki-search-status">검색 결과가 없습니다.</p>
          )}
          {results.map((result) => (
            <Link
              className="wiki-search-result"
              href={documentHref(result.path)}
              key={result.path}
              onClick={() => setFocused(false)}
            >
              <span className="wiki-search-result-title">{result.title}</span>
              <span className="wiki-search-result-path">{result.path}</span>
              {result.excerpt && <span className="wiki-search-result-excerpt">{result.excerpt}</span>}
            </Link>
          ))}
          {query.trim().length >= 2 && !loading && results.length > 0 && (
            <p className="wiki-search-footnote">의미·키워드 검색 · Enter를 눌러 첫 번째 결과 열기</p>
          )}
        </div>
      )}
    </form>
  );
}
