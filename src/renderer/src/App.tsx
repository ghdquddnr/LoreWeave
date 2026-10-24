// 앱 화면: 왼쪽 화 목록, 가운데 에디터, 아래 저장 상태 (M1-PLAN 1절).
// 화를 옮기거나 폴더를 바꾸거나 창을 닫기 전에는 항상 현재 화를 먼저 저장한다.

import { useCallback, useEffect, useRef, useState } from 'react';
import { chapterInfo } from '../../core/project/chapters.ts';
import type { ProjectOpened } from '../../preload/api.ts';
import { ChapterEditor, type ChapterEditorHandle, type SaveStatus } from './ChapterEditor.tsx';

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
  const editor = useRef<ChapterEditorHandle>(null);

  const showProject = useCallback((p: ProjectOpened) => {
    setProject(p);
    setFile(firstReadable(p));
  }, []);

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
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKey);
    const off = api.app.onBeforeClose(() => void leave().then((ok) => api.app.replyClose(ok)));
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey);
      off();
    };
  }, [leave]);

  const run = (task: () => Promise<void>) => task().catch((e: Error) => setError(e.message));

  const openChapter = (next: string) =>
    run(async () => {
      if (next === file || !(await leave())) return;
      setFile(next);
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
    setNotice(outside ? '다른 프로그램에서 바뀌어 다시 불러왔습니다' : null);
  }, []);

  const onSaved = useCallback(
    (text: string) => {
      if (!file) return;
      const { title, id } = chapterInfo(text, file);
      setProject((p) =>
        p && { ...p, list: { ...p.list, chapters: p.list.chapters.map((c) => (c.file === file ? { ...c, title, id } : c)) } },
      );
    },
    [file],
  );

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
        </header>
        <button className="new-chapter" onClick={newChapter}>
          + 새 화
        </button>
        {project.list.duplicateIds.length > 0 && (
          <p className="warning">
            같은 id를 쓰는 화가 있습니다 (파일 복사로 생김):{' '}
            {project.list.duplicateIds.map((files) => files.join(', ')).join(' / ')}
          </p>
        )}
        <nav aria-label="화 목록">
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
          />
        ) : (
          <p className="editor-message">왼쪽에서 화를 고르거나 새 화를 만드세요.</p>
        )}
      </main>
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
        {error && <span className="error">{error}</span>}
      </footer>
    </div>
  );
}
