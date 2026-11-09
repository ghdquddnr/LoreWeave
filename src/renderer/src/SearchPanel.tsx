// 원고 전체 검색 (M2-PLAN 1·4절). 검색어를 입력하고 Enter를 누르면 찾고, 결과를 누르면 그 줄로 이동한다.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { snippet } from '../../core/search.ts';
import type { SearchHit, SearchResult } from '../../preload/api.ts';
import { ErrorNote } from './ErrorNote.tsx';
import { friendlyError, friendlyReadError } from './userError.ts';

export interface SearchPanelHandle {
  focus(): void;
  /** 검색어와 결과를 지우고 화 목록으로 돌아간다 */
  clear(): void;
}

interface Props {
  /** 검색 직전에 현재 화의 저장 안 된 변경을 저장한다 (결과가 화면과 같도록). false면 저장하지 못한 것이다 (편집기가 없으면 undefined) */
  beforeSearch(): Promise<boolean | void>;
  onOpen(hit: SearchHit, match: SearchHit['matches'][number]): void;
  /** 새 검색 결과가 실제로 화면에 게시됐다 (실패·취소·대체된 요청은 부르지 않는다) */
  onResultShown?(): void;
  /** 검색 결과를 보여 주는 중인지 (목록 대신) */
  onActiveChange(active: boolean): void;
  active: boolean;
}

const NOT_SAVED = 'not-saved';
const NOT_SAVED_NOTE = '저장하지 못해 검색하지 않았습니다. 저장 문제(저장 상태 표시)를 해결한 뒤 다시 검색하세요. 입력한 글은 그대로입니다.';

export const SearchPanel = forwardRef<SearchPanelHandle, Props>(function SearchPanel(
  { beforeSearch, onOpen, onResultShown, onActiveChange, active },
  ref,
) {
  const input = useRef<HTMLInputElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  /** 한글 등 조합 중이다 (compositionstart~end). 조합 중의 Enter(확정)·Escape(조합 취소)는 검색 실행·검색어 지우기가 아니다 */
  const composing = useRef(false);
  /** 마지막 keydown이 조합에 속했다 (isComposing, 또는 IME가 처리한 키 keyCode 229). 그 키가 일으킨 form submit을 걸러 낸다 */
  const composingKey = useRef(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<(SearchResult & { query: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 검색 요청 실패의 기술 상세 원문 (저장 단계 안내에는 없다). 기본 안내와 함께 지우고, 새 실패마다 접힌 채 시작한다 */
  const [errorDetail, setErrorDetail] = useState('');
  const errorId = useRef(0);
  /** 검색 요청(chapters:search) 단계가 실패했다 ([다시 검색]을 보인다). 저장 단계 실패와 구분한다: 저장 문제에는 검색 재시도 버튼을 붙이지 않는다 */
  const [searchFailed, setSearchFailed] = useState(false);
  /** 가장 최근 요청이 진행 중이다 ([다시 검색] 중복 클릭을 막는다. Enter의 새 검색은 이전처럼 최신 요청이 이긴다) */
  const inflight = useRef(false);


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
    inflight.current = true;
    setBusy(true);
    setError(null);
    setErrorDetail('');
    setSearchFailed(false);
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
      onResultShown?.();
      onActiveChange(true);
    } catch (e) {
      if (mine === seq.current) {
        if (!searched) {
          // 저장 단계에서 멈췄다: 이전 검색 결과를 이 검색의 결과처럼 남기지 않고 화 목록으로 돌아간다 (검색어는 남겨 다시 검색할 수 있다)
          setResult(null);
          onActiveChange(false);
          setError(e instanceof Error && e.message === NOT_SAVED ? NOT_SAVED_NOTE : `저장 중 오류로 검색하지 않았습니다: ${friendlyError(e).summary}`);
        } else {
          // 검색 요청이 실패했다: 이전 검색의 결과·개수·없음 안내를 이 검색의 결과처럼 남기지 않고 화 목록으로 돌아간다 (검색어는 남겨 Enter로 다시 검색할 수 있다. 실패를 0건 성공으로 보이지 않는다)
          setResult(null);
          onActiveChange(false);
          // 검색은 읽기다: EPERM/EACCES를 쓰기·저장 실패로 설명하지 않는다. IPC 문구·영문 오류·경로·코드는 기본 안내에서 빼고 펼치는 기술 상세에 원문으로 둔다
          const friendly = friendlyReadError(e, '검색 중 오류가 발생했습니다');
          errorId.current++;
          setError(friendly.summary);
          setErrorDetail(friendly.detail);
          setSearchFailed(true);
        }
      }
    } finally {
      if (mine === seq.current) {
        inflight.current = false;
        // 사용자가 키보드로 [검색 취소]를 골라 둔 채 완료되면 그 버튼이 곧 사라진다: 포커스가 BODY로 잃어지지 않게 검색창으로 옮긴다. 다른 곳(검색창·다른 컨트롤)에 포커스가 있으면 건드리지 않는다
        if (cancelButton.current && document.activeElement === cancelButton.current) input.current?.focus();
        setBusy(false);
      }
    }
  };

  /** [다시 검색]: 누른 순간 입력창의 검색어로 기존 search()(저장 전 flush → 검색)를 그대로 쓴다. 빈 검색어·조합 중·진행 중에는 시작하지 않는다 */
  const retrySearch = () => {
    // 실제 조합 중(compositionstart~end)에만 막는다. composingKey는 IME 키가 만든 form submit을 거르는 이력이라 포인터로 누른 버튼에는 적용하지 않는다 (조합이 끝난 뒤 키 입력 없이 누른 버튼이 영구히 막히지 않게)
    if (inflight.current || !query.trim() || composing.current) return;
    // 누른 [다시 검색] 버튼은 검색이 시작되면 곧 사라진다: 포커스가 BODY로 잃어지지 않게 같은 패널의 검색창으로 옮긴다 (선택은 건드리지 않고, 진행 중·성공·재실패 어디서도 Enter로 다시 검색할 수 있다)
    const pressed = document.activeElement;
    if (pressed instanceof HTMLButtonElement && pressed.closest('.search')) input.current?.focus();
    void search();
  };

  const clear = () => {
    seq.current++; // 진행 중인 요청도 무효화한다
    inflight.current = false;
    setSearchFailed(false);
    setQuery('');
    setResult(null);
    setError(null);
    setErrorDetail('');
    setBusy(false);
    onActiveChange(false);
  };

  /**
   * [검색 취소]: 지금 검색의 결과 게시를 무효화하는 UI 취소다. 화 목록으로 돌아가고 입력한 검색어는 남긴다 (clear()와 달리 검색어를 지우지 않는다).
   * 이미 시작된 저장 flush·main의 검색은 중단되지 않는다: flush가 끝나도 이 요청의 검색은 보내지 않고(seq 불일치), 늦게 온 검색 성공·실패는 결과·오류·찾는 중을 되살리지 않는다.
   */
  const cancelSearch = () => {
    seq.current++;
    inflight.current = false;
    setBusy(false);
    setError(null);
    setErrorDetail('');
    setSearchFailed(false);
    setResult(null);
    onActiveChange(false);
    // 취소를 누른 그 순간에만 검색 입력창으로 돌아온다 (취소 버튼은 곧 사라져 포커스가 body로 떨어지지 않게). 캐럿은 입력 끝: 입력한 검색어를 바로 고칠 수 있다. 늦게 오는 응답은 포커스를 건드리지 않는다
    const el = input.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  };

  useImperativeHandle(ref, () => ({ focus: () => input.current?.select(), clear }));

  return (
    <div className="search">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          // 조합을 확정하는 Enter가 만든 submit은 검색이 아니다. 조합이 끝난 뒤의 일반 Enter는 이 플래그가 꺼져 있어 정상 검색한다
          if (composing.current || composingKey.current) {
            composingKey.current = false;
            return;
          }
          void search();
        }}
      >
        <input
          ref={input}
          // type="search"가 아니라 text + role="searchbox": 검색 입력란의 기본 Escape는 입력 전체를 지워, 조합 중 Escape(조합 취소)에서도 확정한 검색어까지 사라진다. 접근 가능한 이름·역할은 그대로다
          type="text"
          role="searchbox"
          enterKeyHint="search"
          aria-label="원고 검색"
          placeholder="원고 검색 (Ctrl+Shift+F)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(e) => {
            composingKey.current = e.nativeEvent.isComposing || e.keyCode === 229;
            // 조합 중의 Escape는 IME의 조합 취소다: 검색어·결과·진행 요청을 지우지 않는다 (기본 동작도 막지 않는다)
            if (e.key === 'Escape' && !composing.current && !composingKey.current) clear();
          }}
        />
      </form>
      {busy && (
        <p className="search-summary">
          찾는 중…{' '}
          <button ref={cancelButton} type="button" className="link" onClick={cancelSearch}>
            검색 취소
          </button>
        </p>
      )}
      {error && (
        <p className="error search-summary">
          {searchFailed ? <ErrorNote key={errorId.current} prefix="검색하지 못했습니다" error={{ summary: error, detail: errorDetail }} /> : error}
          {searchFailed && (
            <>
              {' '}
              <button type="button" className="link" disabled={!query.trim()} onClick={retrySearch}>
                다시 검색
              </button>
            </>
          )}
        </p>
      )}
      {active && result && !busy && (
        <>
          <p className="search-summary">
            {/* 요약의 검색어는 실제 게시된 결과의 검색어(result.query)다. 입력창의 현재 글자(query)가 아니다: 입력만 바꿔도 표시된 결과의 검색어는 새 검색이 성공할 때까지 그대로다 */}
            <span className="search-query">"{result.query}"</span>{' '}
            {result.total === 0 ? '없음' : `${result.total}줄에서 찾음${result.total > result.hits.length ? ` (처음 ${result.hits.length}줄)` : ''}`}{' '}
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
