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
    api.ai.analysisStatus().then(setAi, (e: Error) => setError(e.message));
  }, []);

  const showProject = useCallback(
    (p: ProjectOpened) => {
      setProject(p);
      setFile(firstReadable(p));
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

  const run = (task: () => Promise<void>) => task().catch((e: Error) => setError(e.message));

  const openChapter = (next: string) =>
    run(async () => {
      if (next === file || !(await leave())) return;
      setJump(null);
      setFile(next);
    });

  /** 검색 결과로 이동: 그 화를 열고 찾은 글자를 선택한다 */
  const openResult = (hit: SearchHit, match: SearchHit['matches'][number]) =>
    run(async () => {
      if (hit.file !== file && !(await leave())) return;
      setFile(hit.file);
      setJump((j) => ({ line: hit.line, from: match.from, to: match.to, seq: (j?.seq ?? 0) + 1 }));
    });

  /** 검사 근거로 이동: 그 화를 열고 근거 문장을 선택한다 */
  const openEvidence = (target: string, at: QuoteLocation) =>
    run(async () => {
      if (target !== file && !(await leave())) return;
      setFile(target);
      setJump((j) => ({ line: at.line, from: at.start, to: at.end, seq: (j?.seq ?? 0) + 1 }));
    });

  /** 중복 id 해결: 고른 화에 새 id를 넣는다. 그 화가 열려 있으면 저장한 뒤 다시 연다 */
  const reissueId = (target: string) =>
    run(async () => {
      if (!project || !(await leave())) return;
      const list = await api.chapters.reissueId(target);
      setProject({ ...project, list });
      if (target === file) setReloadKey((k) => k + 1);
    });

  const newChapter = () =>
    run(async () => {
      if (!project || !(await leave())) return;
      const created = await api.chapters.create();
      setProject({ ...project, list: await api.chapters.list() });
      setFile(created.file);
    });

  const chooseFolder = () =>
    run(async () => {
      if (!(await leave())) return;
      const p = await api.project.choose();
      if (p) showProject(p);
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
          <button onClick={chooseFolder} title="다른 원고 폴더 열기">
            열기
          </button>
          <button onClick={() => setSettingsOpen(true)} title="AI 설정">
            설정
          </button>
        </header>
        <button className="new-chapter" onClick={newChapter}>
          + 새 화
        </button>
        {ai && (
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
            key={`${file}:${reloadKey}`}
            ref={editor}
            file={file}
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
            file={file}
            state={ai?.checkStates[file]}
            version={aiVersion}
            currentLines={() => editor.current?.lines() ?? null}
            onJump={jumpHere}
            onOpenEvidence={openEvidence}
          />
          <FactsPanel
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
