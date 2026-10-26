// 앱 화면: 왼쪽 검색창과 화 목록(또는 검색 결과), 가운데 에디터, 오른쪽 AI 패널, 아래 저장 상태 (M1~M4 계획 1절).
// 화를 옮기거나 폴더를 바꾸거나 창을 닫기 전에는 항상 현재 화를 먼저 저장한다.

import { useCallback, useEffect, useRef, useState } from 'react';
import { chapterInfo } from '../../core/project/chapters.ts';
import type { QuoteLocation } from '../../core/ai/locate.ts';
import type { AnalysisState, CheckState, ProjectOpened, SearchHit } from '../../preload/api.ts';
import { AnalysisBar } from './AnalysisBar.tsx';
import { ChapterEditor, type ChapterEditorHandle, type Jump, type SaveStatus } from './ChapterEditor.tsx';
import { FactsPanel } from './FactsPanel.tsx';
import { IssuesPanel } from './IssuesPanel.tsx';
import { SearchPanel, type SearchPanelHandle } from './SearchPanel.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';

interface AiState {
  states: Record<string, AnalysisState>;
  checkStates: Record<string, CheckState>;
  totalCostUsd: number;
  recoveredFrom: string | null;
  consent: boolean;
}

const MARK_TITLE: Record<AnalysisState, string> = { none: '', fresh: 'AI 분석됨', stale: 'AI 분석 뒤 바뀜' };

const api = window.loreweave;

const STATUS_TEXT: Record<SaveStatus['kind'], string> = {
  saved: '저장됨',
  unsaved: '저장 대기',
  saving: '저장 중…',
  error: '저장 실패',
  conflict: '저장 멈춤: 다른 프로그램에서 바뀜',
};

function firstReadable(project: ProjectOpened): string | null {
  return project.list.chapters.find((c) => !c.unreadable)?.file ?? null;
}

export function App() {
  const [starting, setStarting] = useState(true);
  const [project, setProject] = useState<ProjectOpened | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  /**
   * 프로젝트를 열 때마다 1씩 는다. 에디터·검색·AI 패널의 key에 넣어, 다른 프로젝트에 같은 이름의 화(001.md)가 있어도
   * 새 프로젝트의 화를 다시 읽게 한다 (같은 폴더를 다시 열 때도 새로 읽는다)
   */
  const [projectGen, setProjectGen] = useState(0);
  const projectGenRef = useRef(0);
  /**
   * 프로젝트를 바꾸는 중 (마지막 저장 직전부터 새 프로젝트를 보일 때까지). 그동안 에디터 입력과 원고 조작을 막는다.
   * main은 열기 처리 중에 root를 먼저 바꾸므로, 이 사이 이전 화면에서 받은 입력은 어디에도 안전하게 저장할 수 없다
   */
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);
  /** 진행 중인 프로젝트 전환의 결과 (새 프로젝트를 열었으면 true). 전환 중이 아니면 null */
  const switchDone = useRef<Promise<boolean> | null>(null);
  /** 새 화·id 재발급을 처리하는 중. 같은 조작을 겹쳐 시작하지 않고, 화 이동도 막는다 (프로젝트 전환은 막지 않는다) */
  const [acting, setActing] = useState(false);
  const actingRef = useRef(false);
  /**
   * 에디터 잠금의 깊이. 전환·새 화·id 재발급이 겹칠 수 있어 깊이가 0이 될 때만 푼다.
   * editorLocked는 새로 마운트되는 에디터가 잠긴 채 시작하게 한다 (setLocked는 지금 에디터를 바로 잠근다)
   */
  const lockDepth = useRef(0);
  const [editorLocked, setEditorLocked] = useState(false);
  const lockEditor = () => {
    if (lockDepth.current++ === 0) {
      editor.current?.setLocked(true);
      setEditorLocked(true);
    }
  };
  /** replaced: 이 조작이 에디터를 새로 만들게 했다 (화 이동·다시 읽기·프로젝트 전환). 그러면 사라질 지금 에디터는 다시 열지 않는다 */
  const unlockEditor = (replaced: boolean) => {
    if (--lockDepth.current === 0) {
      setEditorLocked(false);
      if (!replaced) editor.current?.setLocked(false);
    }
  };
  /**
   * 새 화·id 재발급: 시작하자마자(마지막 저장 전에) 에디터를 잠근다. 응답을 기다리는 동안 받은 입력이
   * 화 이동이나 다시 읽기로 저장되지 않고 사라지는 일이 없게 한다. task는 에디터를 새로 만들게 했으면 true를 돌려준다
   */
  const lockedAction = (task: (gen: number) => Promise<boolean>) =>
    run(async (gen) => {
      if (switchingRef.current || actingRef.current) return;
      actingRef.current = true;
      setActing(true);
      lockEditor();
      let replaced = false;
      try {
        replaced = await task(gen);
      } finally {
        actingRef.current = false;
        setActing(false);
        unlockEditor(replaced);
      }
    });
  const [save, setSave] = useState<{ status: SaveStatus; changesOnReopen: number | null }>({
    status: { kind: 'saved' },
    changesOnReopen: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [jump, setJump] = useState<Jump | null>(null);
  const [ai, setAi] = useState<AiState | null>(null);
  const [aiVersion, setAiVersion] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const editor = useRef<ChapterEditorHandle>(null);
  const search = useRef<SearchPanelHandle>(null);

  const refreshAi = useCallback(() => {
    // 프로젝트를 바꾼 뒤에 도착한 이전 프로젝트의 응답은 버린다
    const gen = projectGenRef.current;
    api.ai.analysisStatus().then(
      (s) => gen === projectGenRef.current && setAi(s),
      (e: Error) => gen === projectGenRef.current && setError(e.message),
    );
  }, []);

  const showProject = useCallback(
    (p: ProjectOpened) => {
      projectGenRef.current += 1;
      setProjectGen(projectGenRef.current);
      setError(null);
      setProject(p);
      setFile(firstReadable(p));
      // 이전 프로젝트의 이동 위치·저장 상태·알림·AI 상태를 지운다 (새 에디터와 AI 상태가 다시 알린다)
      setJump(null);
      setSave({ status: { kind: 'saved' }, changesOnReopen: null });
      setNotice(null);
      setAi(null);
      refreshAi();
    },
    [refreshAi],
  );

  useEffect(() => {
    api.project
      .reopenLast()
      .then((p) => p && showProject(p))
      .catch((e: Error) => setError(e.message))
      .finally(() => setStarting(false));
  }, [showProject]);

  /** 현재 화를 저장한다. 저장 못 한 변경이 남으면 계속할지 묻는다 */
  const leave = useCallback(async (): Promise<boolean> => {
    const clean = (await editor.current?.flush()) ?? true;
    return clean || window.confirm('저장되지 않은 변경이 있습니다. 그래도 계속할까요? (변경은 사라집니다)');
  }, []);

  useEffect(() => {
    const onBlur = () => void editor.current?.flush();
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void editor.current?.flush();
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKey);
    const off = api.app.onBeforeClose(() => void leave().then((ok) => api.app.replyClose(ok)));
    // 다른 프로그램이 화를 바꾸면 분석 상태(분석 뒤 바뀜)도 다시 읽는다
    const offOutside = api.chapters.onChangedOutside(() => refreshAi());
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey);
      off();
      offOutside();
    };
  }, [leave, refreshAi]);

  /**
   * 원고 조작을 실행한다. 조작은 시작할 때의 프로젝트 세대(gen)를 받고, 각 await 뒤에 isCurrent(gen)로 확인한 뒤에만 화면을 바꾼다.
   * 그사이 다른 프로젝트를 열었으면 늦게 온 응답·오류는 지금 화면에 적용하지 않는다 (이미 성공한 생성·id 변경은 원래 프로젝트 파일에 남는다)
   */
  const run = (task: (gen: number) => Promise<void>) => {
    const gen = projectGenRef.current;
    return task(gen).catch((e: Error) => {
      if (gen === projectGenRef.current) setError(e.message);
    });
  };
  const isCurrent = (gen: number) => gen === projectGenRef.current;
  /**
   * 원고 조작 응답 뒤의 후속 요청(목록·다시 읽기) 전에 부른다. 프로젝트 전환 중이면 끝나기를 기다린다:
   * main은 열기 처리 중에 이미 새 프로젝트로 바뀌었을 수 있어, 이전 token으로 보내면 거절되어 거짓 오류가 된다.
   * 전환이 취소·실패했으면 지금 프로젝트 그대로이므로 true (후속 요청을 보낸다), 새 프로젝트가 열렸으면 false
   */
  const settled = async (gen: number) => {
    if (switchDone.current) await switchDone.current;
    return isCurrent(gen);
  };

  const openChapter = (next: string) =>
    run(async (gen) => {
      if (switchingRef.current || actingRef.current || next === file || !(await leave()) || !isCurrent(gen)) return;
      setJump(null);
      setFile(next);
    });

  /** 검색 결과로 이동: 그 화를 열고 찾은 글자를 선택한다 */
  const openResult = (hit: SearchHit, match: SearchHit['matches'][number]) =>
    run(async (gen) => {
      if (switchingRef.current || actingRef.current || (hit.file !== file && !(await leave())) || !isCurrent(gen)) return;
      setFile(hit.file);
      setJump((j) => ({ line: hit.line, from: match.from, to: match.to, seq: (j?.seq ?? 0) + 1 }));
    });

  /** 검사 근거로 이동: 그 화를 열고 근거 문장을 선택한다 */
  const openEvidence = (target: string, at: QuoteLocation) =>
    run(async (gen) => {
      if (switchingRef.current || actingRef.current || (target !== file && !(await leave())) || !isCurrent(gen)) return;
      setFile(target);
      setJump((j) => ({ line: at.line, from: at.start, to: at.end, seq: (j?.seq ?? 0) + 1 }));
    });

  /** 중복 id 해결: 고른 화에 새 id를 넣는다. 그 화가 열려 있으면 저장한 뒤 다시 연다 */
  const reissueId = (target: string) =>
    lockedAction(async (gen) => {
      if (!project || !(await leave()) || !isCurrent(gen)) return false;
      const list = await api.chapters.reissueId(target, project.token);
      // 다른 프로젝트가 열렸으면 그 화면의 에디터가 대신한다 (잠금이 풀리면 열린다)
      if (!(await settled(gen))) return true;
      setProject((p) => p && { ...p, list });
      if (target !== file) return false;
      setReloadKey((k) => k + 1);
      return true;
    });

  const newChapter = () =>
    lockedAction(async (gen) => {
      if (!project || !(await leave()) || !isCurrent(gen)) return false;
      const created = await api.chapters.create(project.token);
      if (!(await settled(gen))) return true;
      const list = await api.chapters.list(project.token);
      if (!isCurrent(gen)) return false;
      setProject((p) => p && { ...p, list });
      setFile(created.file);
      return true;
    });

  const chooseFolder = () =>
    run(async () => {
      if (switchingRef.current) return;
      // 마지막 저장 전에 먼저 잠근다: 이 뒤의 입력은 문서에 들어가지 않고, 그 전의 입력은 아래 leave()가 지금 프로젝트에 저장한다
      switchingRef.current = true;
      setSwitching(true);
      lockEditor();
      let opened = false;
      let done!: (opened: boolean) => void;
      switchDone.current = new Promise((resolve) => (done = resolve));
      try {
        if (!(await leave())) return;
        const p = await api.project.choose();
        if (p) {
          showProject(p);
          opened = true;
        }
      } finally {
        switchingRef.current = false;
        setSwitching(false);
        // 취소·실패·저장 확인 거절이면 지금 에디터를 다시 연다. 열렸으면 새 프로젝트의 새 에디터가 대신한다
        unlockEditor(opened);
        switchDone.current = null;
        done(opened);
      }
    });

  const onStatus = useCallback((status: SaveStatus, changesOnReopen: number | null) => {
    setSave({ status, changesOnReopen });
    if (status.kind !== 'saved') setNotice(null);
  }, []);

  const onReload = useCallback((outside?: boolean) => {
    setReloadKey((k) => k + 1);
    setJump(null);
    setNotice(outside ? '다른 프로그램에서 바뀌어 다시 불러왔습니다' : null);
  }, []);

  const onSaved = useCallback(
    (text: string) => {
      if (!file) return;
      const { title, id } = chapterInfo(text, file);
      setProject((p) =>
        p && { ...p, list: { ...p.list, chapters: p.list.chapters.map((c) => (c.file === file ? { ...c, title, id } : c)) } },
      );
      // 분석·검사한 화를 고치면 "바뀜"이 된다 (이 화를 근거로 쓴 뒤 화의 검사도)
      if (ai && (ai.states[file] === 'fresh' || Object.values(ai.checkStates).includes('fresh'))) refreshAi();
    },
    [file, ai, refreshAi],
  );

  const jumpHere = (at: QuoteLocation) => setJump((j) => ({ line: at.line, from: at.start, to: at.end, seq: (j?.seq ?? 0) + 1 }));

  if (starting) return null;

  if (!project) {
    return (
      <main className="welcome">
        <h1>LoreWeave</h1>
        <p>원고 폴더를 여세요. 폴더 안 `chapters/`의 `001.md`, `002.md` … 를 화로 읽습니다.</p>
        <button onClick={chooseFolder}>원고 폴더 열기</button>
        {error && <p className="error">{error}</p>}
      </main>
    );
  }

  const current = project.list.chapters.find((c) => c.file === file);
  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <strong title={project.name}>{project.name}</strong>
          <button onClick={chooseFolder} title="다른 원고 폴더 열기" disabled={switching}>
            열기
          </button>
          <button onClick={() => setSettingsOpen(true)} title="AI 설정">
            설정
          </button>
        </header>
        <button className="new-chapter" onClick={newChapter} disabled={switching || acting}>
          + 새 화
        </button>
        {ai && !switching && (
          <AnalysisBar
            file={file}
            states={ai.states}
            consent={ai.consent}
            beforeAnalyze={() => editor.current?.flush() ?? Promise.resolve()}
            onAnalyzed={() => {
              refreshAi();
              setAiVersion((v) => v + 1);
            }}
            onNeedKey={() => setSettingsOpen(true)}
          />
        )}
        <SearchPanel
          key={projectGen}
          ref={search}
          active={searching}
          onActiveChange={setSearching}
          beforeSearch={() => editor.current?.flush() ?? Promise.resolve()}
          onOpen={openResult}
        />
        {project.list.duplicateIds.length > 0 && (
          <div className="warning duplicates" role="alert">
            같은 id를 쓰는 화가 있습니다 (파일 복사로 생김). 하나만 남기고 새 id를 주세요.
            {project.list.duplicateIds.map((files) => (
              <ul key={files[0]}>
                {files.map((f, i) => (
                  <li key={f}>
                    {f}{' '}
                    {i > 0 && (
                      <button type="button" className="link" onClick={() => reissueId(f)}>
                        새 id 발급
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ))}
          </div>
        )}
        <nav aria-label="화 목록" hidden={searching}>
          {project.list.chapters.length === 0 && <p className="empty">아직 화가 없습니다.</p>}
          {project.list.chapters.map((c) => (
            <button
              key={c.file}
              className={c.file === file ? 'chapter current' : 'chapter'}
              disabled={c.unreadable}
              title={c.unreadable ? 'UTF-8이 아닌 파일이라 열 수 없습니다' : c.file}
              onClick={() => openChapter(c.file)}
            >
              {c.title}
              {ai && ai.states[c.file] && ai.states[c.file] !== 'none' && (
                <span className={`mark mark-${ai.states[c.file]}`} title={MARK_TITLE[ai.states[c.file]!]} aria-label={MARK_TITLE[ai.states[c.file]!]}>
                  ●
                </span>
              )}
            </button>
          ))}
        </nav>
      </aside>
      <main className="editor-pane">
        {file ? (
          <ChapterEditor
            key={`${projectGen}:${file}:${reloadKey}`}
            ref={editor}
            file={file}
            projectToken={project.token}
            locked={editorLocked}
            onStatus={onStatus}
            onSaved={onSaved}
            onReload={onReload}
            jump={jump}
          />
        ) : (
          <p className="editor-message">왼쪽에서 화를 고르거나 새 화를 만드세요.</p>
        )}
      </main>
      {file && (
        <div className="ai-panel">
          <IssuesPanel
            key={projectGen}
            file={file}
            state={ai?.checkStates[file]}
            version={aiVersion}
            currentLines={() => editor.current?.lines() ?? null}
            onJump={jumpHere}
            onOpenEvidence={openEvidence}
          />
          <FactsPanel
            key={projectGen}
            file={file}
            state={ai?.states[file]}
            version={aiVersion}
            currentLines={() => editor.current?.lines() ?? null}
            onJump={jumpHere}
          />
        </div>
      )}
      <footer className="statusbar" role="status">
        <span>{current?.title ?? ''}</span>
        <span className={`save save-${save.status.kind}`}>
          {STATUS_TEXT[save.status.kind]}
          {save.status.kind === 'error' && `: ${save.status.message}`}
        </span>
        {save.changesOnReopen !== null && (
          <span className="warning">
            {save.changesOnReopen + 1}번째 줄 근처는 다시 열면 다르게 보입니다 (예: `*` 두 개 사이가 기울임이 됨)
          </span>
        )}
        {notice && <span className="notice">{notice}</span>}
        {ai?.recoveredFrom && <span className="warning">AI 분석 파일이 깨져 옮겨 두었습니다: {ai.recoveredFrom}</span>}
        {error && <span className="error">{error}</span>}
      </footer>
      {settingsOpen && (
        <SettingsDialog totalCostUsd={ai?.totalCostUsd ?? 0} onClose={() => setSettingsOpen(false)} onChange={() => refreshAi()} />
      )}
    </div>
  );
}
