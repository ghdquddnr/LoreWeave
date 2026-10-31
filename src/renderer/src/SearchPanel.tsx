// 원고 전체 검색 (M2-PLAN 1·4절). 검색어를 입력하고 Enter를 누르면 찾고, 결과를 누르면 그 줄로 이동한다.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { snippet } from '../../core/search.ts';
import type { SearchHit, SearchResult } from '../../preload/api.ts';
import { friendlyError } from './userError.ts';

export interface SearchPanelHandle {
  focus(): void;
  /** 검색어와 결과를 지우고 화 목록으로 돌아간다 */
  clear(): void;
}

interface Props {
  /** 검색 직전에 현재 화의 저장 안 된 변경을 저장한다 (결과가 화면과 같도록). false면 저장하지 못한 것이다 (편집기가 없으면 undefined) */
  beforeSearch(): Promise<boolean | void>;
  onOpen(hit: SearchHit, match: SearchHit['matches'][number]): void;
  /** 검색 결과를 보여 주는 중인지 (목록 대신) */
  onActiveChange(active: boolean): void;
  active: boolean;
}

const NOT_SAVED = 'not-saved';
const NOT_SAVED_NOTE = '저장하지 못해 검색하지 않았습니다. 저장 문제(저장 상태 표시)를 해결한 뒤 다시 검색하세요. 입력한 글은 그대로입니다.';

export const SearchPanel = forwardRef<SearchPanelHandle, Props>(function SearchPanel(
  { beforeSearch, onOpen, onActiveChange, active },
  ref,
) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<(SearchResult & { query: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);


  // 요청 번호: 가장 최근에 시작했고 지우기·새 요청·언마운트로 무효화되지 않은 요청만 결과·오류·찾는 중을 반영한다
  const seq = useRef(0);
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );

  const search = async () => {
    const q = query;
    if (!q.trim()) return clear();
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    let searched = false;
    try {
      const saved = await beforeSearch();
      // 저장하지 못했으면 검색하지 않는다: 디스크만 찾은 "없음/찾음"이 화면의 저장 안 된 본문에 대한 결과처럼 보이면 안 된다 (입력·원고는 건드리지 않는다)
      if (saved === false && mine === seq.current) throw new Error(NOT_SAVED);
      if (mine !== seq.current) return; // 저장을 기다리는 사이 취소됐거나 새 요청이 생겼다: 검색 요청을 보내지 않는다
      searched = true;
      const found = await window.loreweave.chapters.search(q);
      if (mine !== seq.current) return;
      setResult({ ...found, query: q });
      onActiveChange(true);
    } catch (e) {
      if (mine === seq.current) {
        if (!searched) {
          // 저장 단계에서 멈췄다: 이전 검색 결과를 이 검색의 결과처럼 남기지 않고 화 목록으로 돌아간다 (검색어는 남겨 다시 검색할 수 있다)
          setResult(null);
          onActiveChange(false);
          setError(e instanceof Error && e.message === NOT_SAVED ? NOT_SAVED_NOTE : `저장 중 오류로 검색하지 않았습니다: ${friendlyError(e).summary}`);
        } else setError(friendlyError(e).summary);
      }
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  };

  const clear = () => {
    seq.current++; // 진행 중인 요청도 무효화한다
    setQuery('');
    setResult(null);
    setError(null);
    setBusy(false);
    onActiveChange(false);
  };

  useImperativeHandle(ref, () => ({ focus: () => input.current?.select(), clear }));

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
