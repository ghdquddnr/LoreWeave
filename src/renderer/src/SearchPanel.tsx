// 원고 전체 검색 (M2-PLAN 1·4절). 검색어를 입력하고 Enter를 누르면 찾고, 결과를 누르면 그 줄로 이동한다.

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { snippet } from '../../core/search.ts';
import type { SearchHit, SearchResult } from '../../preload/api.ts';

export interface SearchPanelHandle {
  focus(): void;
}

interface Props {
  /** 검색 직전에 현재 화의 저장 안 된 변경을 저장한다 (결과가 화면과 같도록) */
  beforeSearch(): Promise<unknown>;
  onOpen(hit: SearchHit, match: SearchHit['matches'][number]): void;
  /** 검색 결과를 보여 주는 중인지 (목록 대신) */
  onActiveChange(active: boolean): void;
  active: boolean;
}

export const SearchPanel = forwardRef<SearchPanelHandle, Props>(function SearchPanel(
  { beforeSearch, onOpen, onActiveChange, active },
  ref,
) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<(SearchResult & { query: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({ focus: () => input.current?.select() }), []);

  const search = async () => {
    const q = query;
    if (!q.trim()) return clear();
    setBusy(true);
    setError(null);
    try {
      await beforeSearch();
      setResult({ ...(await window.loreweave.chapters.search(q)), query: q });
      onActiveChange(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    setQuery('');
    setResult(null);
    setError(null);
    onActiveChange(false);
  };

  return (
    <div className="search">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          ref={input}
          type="search"
          aria-label="원고 검색"
          placeholder="원고 검색 (Ctrl+Shift+F)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && clear()}
        />
      </form>
      {busy && <p className="search-summary">찾는 중…</p>}
      {error && <p className="error search-summary">{error}</p>}
      {active && result && !busy && (
        <>
          <p className="search-summary">
            {result.total === 0
              ? `"${result.query}" 없음`
              : `${result.total}줄에서 찾음${result.total > result.hits.length ? ` (처음 ${result.hits.length}줄)` : ''}`}{' '}
            <button type="button" className="link" onClick={clear}>
              목록으로
            </button>
          </p>
          <ol className="search-results" aria-label="검색 결과">
            {result.hits.map((hit) => {
              const match = hit.matches[0]!;
              const { before, hit: found, after } = snippet(hit.text, match);
              return (
                <li key={`${hit.file}:${hit.line}`}>
                  <button type="button" onClick={() => onOpen(hit, match)} title={`${hit.file} ${hit.line + 1}번째 줄`}>
                    <span className="search-where">
                      {hit.title} · {hit.line + 1}줄
                    </span>
                    <span className="search-text">
                      {before}
                      <mark>{found}</mark>
                      {after}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
});
