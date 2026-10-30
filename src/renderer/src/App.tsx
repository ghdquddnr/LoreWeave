// 앱 화면: 왼쪽 검색창과 화 목록(또는 검색 결과), 가운데 에디터, 오른쪽 AI 패널, 아래 저장 상태 (M1~M4 계획 1절).
// 화를 옮기거나 폴더를 바꾸거나 창을 닫기 전에는 항상 현재 화를 먼저 저장한다.

import { useCallback, useEffect, useRef, useState } from 'react';
import { chapterInfo } from '../../core/project/chapters.ts';
import type { QuoteLocation } from '../../core/ai/locate.ts';
import type { AnalysisState, AppearanceBootstrap, CheckState, ProjectOpened, SearchHit } from '../../preload/api.ts';
import { AnalysisBar, type AnalysisBarHandle } from './AnalysisBar.tsx';
import { ActivityBar, ChapterTabs } from './Shell.tsx';
import { ChapterEditor, type ChapterEditorHandle, type Jump, type SaveStatus } from './ChapterEditor.tsx';
import { CommandPalette, type PaletteCommand } from './CommandPalette.tsx';
import { ErrorNote } from './ErrorNote.tsx';
import { FactsPanel } from './FactsPanel.tsx';
import { IssuesPanel } from './IssuesPanel.tsx';
import { SearchPanel, type SearchPanelHandle } from './SearchPanel.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import type { SystemDarkStore } from './systemDark.ts';
import { friendlyError } from './userError.ts';
import { THEMES } from '../../core/appearance.ts';
import { useAppearance } from './useAppearance.ts';

interface AiState {
  states: Record<string, AnalysisState>;
  checkStates: Record<string, CheckState>;
  issueCounts: Record<string, number>;
  totalCostUsd: number;
  recoveredFrom: string | null;
  consent: boolean;
}

const MARK_TITLE: Record<AnalysisState, string> = { none: '', fresh: 'AI 분석됨', stale: 'AI 분석 뒤 바뀜' };

const api = window.loreweave;

/** 저장 상태는 색만으로 구분하지 않는다: 글자 앞에 기호를 함께 둔다 (스크린리더에는 글자만 읽힌다) */
const STATUS_SYMBOL: Record<SaveStatus['kind'], string> = { saved: '✓', unsaved: '●', saving: '…', error: '✕', conflict: '⚠' };

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

export function App({ boot, systemDark }: { boot: AppearanceBootstrap; systemDark: SystemDarkStore }) {
  const appearance = useAppearance(boot, systemDark);
  const [starting, setStarting] = useState(true);
  const [project, setProject] = useState<ProjectOpened | null>(null);
  const projectRef = useRef<ProjectOpened | null>(null);
  projectRef.current = project;
  const [file, setFile] = useState<string | null>(null);
  /**
   * 열린 화 탭: 파일 이름만 가진다 (제목은 화 목록에서 읽는다). 항상 file이 있으면 tabs에 들어 있다.
   * 에디터는 지금 화 하나뿐이라 미저장 입력을 가진 탭은 최대 하나이고, 탭 전환·닫기는 openChapter/leave와 같은 저장 경로를 거친다.
   * 프로젝트를 열 때(같은 폴더 다시 열기 포함)마다 새로 시작한다. 디스크에 남기지 않는다.
   */
  const [tabs, setTabs] = useState<string[]>([]);
  const tabsRef = useRef<string[]>([]);
  tabsRef.current = tabs;
  const fileRef = useRef<string | null>(null);
  fileRef.current = file;
  /** 에디터 도구줄과 탐색기 "AI 작업" 자리 (AnalysisBar가 portal로 그린다) */
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const [explorerSlot, setExplorerSlot] = useState<HTMLElement | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  /**
   * 프로젝트를 열 때마다 1씩 는다. 에디터·검색·AI 패널의 key에 넣어, 다른 프로젝트에 같은 이름의 화(001.md)가 있어도
   * 새 프로젝트의 화를 다시 읽게 한다 (같은 폴더를 다시 열 때도 새로 읽는다)
   */
  const [projectGen, setProjectGen] = useState(0);
  const projectGenRef = useRef(0);
  /** 지금 화면의 프로젝트 token (AI 상태 읽기에 함께 보낸다) */
  const projectTokenRef = useRef(0);
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
  /** 상태줄 오류: 기본 안내(error)와 펼쳐 보는 기술 상세(errorDetail)를 나눠 가진다 */
  const [error, setErrorText] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState('');
  const [errorOpen, setErrorOpen] = useState(false);
  const setError = useCallback((message: string | null, detail = '') => {
    setErrorText(message);
    setErrorDetail(detail);
    setErrorOpen(false);
  }, []);
  const fail = useCallback(
    (e: unknown, prefix = '') => {
      const f = friendlyError(e);
      setError(prefix + f.summary, f.detail);
    },
    [setError],
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [saveDetailOpen, setSaveDetailOpen] = useState(false);
  const paletteOpener = useRef<HTMLElement | null>(null);
  const aiRef = useRef<AnalysisBarHandle>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 새 편집기(다른 화·다시 불러오기·다른 프로젝트)는 저장된 디스크 내용으로 시작한다. 편집기는 처음에 상태를 알리지 않으므로, 이전 편집기의 '저장 멈춤'·'저장 실패'가 남아 있지 않게 여기서 되돌린다
  useEffect(() => {
    setSave({ status: { kind: 'saved' }, changesOnReopen: null });
  }, [file, reloadKey, projectGen]);
  const [searching, setSearching] = useState(false);
  const [jump, setJump] = useState<Jump | null>(null);
  /** 본문에 밑줄로 표시할 문장들 (IssuesPanel이 보고하는 최신 검사 결과, 표시 전용). 화를 바꾸면 패널이 비운다 */
  /** 편집기가 새로 만들어질 때마다 늘어, 패널이 지금 본문과 인용 위치를 다시 대조하게 한다 */
  const [, setEditorTick] = useState(0);
  const [reviewMarks, setReviewMarks] = useState<{ file: string; quotes: string[] }>({ file: '', quotes: [] });
  const [ai, setAi] = useState<AiState | null>(null);
  const [aiVersion, setAiVersion] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const editor = useRef<ChapterEditorHandle>(null);
  const search = useRef<SearchPanelHandle>(null);

  const refreshAi = useCallback(() => {
    // 프로젝트를 바꾼 뒤에 도착한 이전 프로젝트의 응답은 버린다. main도 이전 token의 요청은 거절한다:
    // 전환 중이면 끝나기를 기다려, 새 프로젝트가 열렸으면 그 거절을 오류로 보이지 않는다
    const gen = projectGenRef.current;
    api.ai.analysisStatus(projectTokenRef.current).then(
      (s) => gen === projectGenRef.current && setAi(s),
      async (e: Error) => {
        if (switchDone.current) await switchDone.current;
        if (gen === projectGenRef.current) fail(e);
      },
    );
  }, [fail]);

  const showProject = useCallback(
    (p: ProjectOpened) => {
      projectGenRef.current += 1;
      projectTokenRef.current = p.token;
      setProjectGen(projectGenRef.current);
      if (p.rememberError) fail(p.rememberError, '폴더는 열었지만 다음 실행 때 다시 열 폴더로 기억하지 못했습니다: ');
      else setError(null);
      setProject(p);
      const first = firstReadable(p);
      setFile(first);
      setTabs(first ? [first] : []);
      // 이전 프로젝트의 이동 위치·저장 상태·알림·AI 상태를 지운다 (새 에디터와 AI 상태가 다시 알린다)
      setJump(null);
      setSave({ status: { kind: 'saved' }, changesOnReopen: null });
      setNotice(null);
      setAi(null);
      refreshAi();
    },
    [refreshAi, fail, setError],
  );

  useEffect(() => {
    api.project
      .reopenLast()
      .then((p) => p && showProject(p))
      .catch((e: Error) => fail(e))
      .finally(() => setStarting(false));
  }, [showProject, fail]);

  const openPalette = () => {
    if (projectRef.current === null) return;
    paletteOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPaletteOpen(true);
  };
  /** 팔레트를 닫는다. restore: 연 곳으로 포커스를 돌린다 (편집기에서 열었으면 PM 상태의 선택으로 되돌린다) */
  const closePalette = (restore: boolean) => {
    setPaletteOpen(false);
    const opener = paletteOpener.current;
    paletteOpener.current = null;
    if (!restore || !opener) return;
    // 닫는 렌더가 끝난 뒤에 돌려준다
    setTimeout(() => {
      if (opener.closest('.ProseMirror')) editor.current?.focus();
      else if (opener.isConnected) opener.focus();
    }, 0);
  };

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
      // 명령 팔레트: 한글 조합 중이거나 다른 대화상자(설정·AI 실행 확인·팔레트)가 떠 있으면 열지 않는다
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (e.isComposing || e.repeat || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
        openPalette();
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
      if (gen === projectGenRef.current) fail(e);
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

  /** 탭을 (없으면) 더하고 그 화로 옮긴다 */
  const activate = (next: string) => {
    setTabs((t) => (t.includes(next) ? t : [...t, next]));
    setFile(next);
  };

  const openChapter = (next: string) =>
    run(async (gen) => {
      if (switchingRef.current || actingRef.current || next === file || !(await leave()) || !isCurrent(gen)) return;
      setJump(null);
      activate(next);
    });

  /**
   * 탭 닫기. 지금 화가 아닌 탭은 목록에서 빼기만 한다 (미저장 입력은 지금 화에만 있다).
   * 지금 화를 닫으면 먼저 저장하고(저장 못 하면 화 이동과 같이 계속할지 묻고, 거절하면 그대로 둔다) 오른쪽, 없으면 왼쪽 탭으로 간다.
   * 마지막 탭을 닫으면 화 없음(안내 화면)이 된다. 저장하는 동안 사용자가 다른 화로 옮겼으면 그 선택을 존중하고 탭만 뺀다.
   */
  const closeTab = (target: string) =>
    run(async (gen) => {
      if (switchingRef.current || actingRef.current) return;
      if (target !== file) {
        setTabs((t) => t.filter((f) => f !== target));
        return;
      }
      if (!(await leave()) || !isCurrent(gen)) return;
      const list = tabsRef.current;
      const at = list.indexOf(target);
      const neighbor = list[at + 1] ?? list[at - 1] ?? null;
      setTabs((t) => t.filter((f) => f !== target));
      if (fileRef.current !== target) return;
      setJump(null);
      setFile(neighbor);
      if (neighbor === null) {
        setSave({ status: { kind: 'saved' }, changesOnReopen: null });
        setNotice(null);
      }
    });

  /** 검색 결과로 이동: 그 화를 열고 찾은 글자를 선택한다 */
  const openResult = (hit: SearchHit, match: SearchHit['matches'][number]) =>
    run(async (gen) => {
      if (switchingRef.current || actingRef.current || (hit.file !== file && !(await leave())) || !isCurrent(gen)) return;
      activate(hit.file);
      setJump((j) => ({ line: hit.line, from: match.from, to: match.to, seq: (j?.seq ?? 0) + 1 }));
    });

  /** 검사 근거로 이동: 그 화를 열고, 저장된 위치 대신 지금 본문에서 근거 문장을 다시 찾아 선택한다 (못 찾으면 알린다) */
  const openEvidence = (target: string, quote: string) =>
    run(async (gen) => {
      if (switchingRef.current || actingRef.current || (target !== file && !(await leave())) || !isCurrent(gen)) return;
      activate(target);
      setNotice(null);
      setJump((j) => ({ quote, seq: (j?.seq ?? 0) + 1 }));
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
      activate(created.file);
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

  const onQuoteMissing = useCallback(
    (quote: string) => setNotice(`근거 문장을 지금 원고에서 찾을 수 없습니다 (지워졌거나 바뀌었습니다): “${quote}”`),
    [],
  );

  const jumpHere = (at: QuoteLocation | null) =>
    setJump((j) => ({ ...(at ? { line: at.line, from: at.start, to: at.end } : { clear: true as const }), seq: (j?.seq ?? 0) + 1 }));

  if (starting) return null;

  if (!project) {
    return (
      <main className="welcome">
        <h1>LoreWeave</h1>
        <p>원고 폴더를 여세요. 폴더 안 `chapters/`의 `001.md`, `002.md` … 를 화로 읽습니다.</p>
        <p className="muted">원고 파일은 이 컴퓨터의 폴더에 저장됩니다. AI 분석은 작가가 동의하고 버튼을 누를 때에만 본문을 OpenAI로 보냅니다.</p>
        <div className="row">
          <button onClick={chooseFolder}>원고 폴더 열기</button>
          <button onClick={() => setSettingsOpen(true)}>환경설정</button>
        </div>
        {error && (
          <p className="error">
            <ErrorNote error={{ summary: error, detail: errorDetail }} />
          </p>
        )}
        {settingsOpen && <SettingsDialog appearance={appearance} totalCostUsd={0} onClose={() => setSettingsOpen(false)} onChange={() => undefined} />}
      </main>
    );
  }

  const current = project.list.chapters.find((c) => c.file === file);
  const titleOf = (f: string) => project.list.chapters.find((c) => c.file === f)?.title ?? f;
  const busy = switching || acting;
  const saveError = save.status.kind === 'error' ? friendlyError(save.status.message) : null;
  const pendingAnalysis = ai ? Object.values(ai.states).filter((s) => s !== 'fresh').length : 0;
  /**
   * 명령 팔레트: 지금 실제로 있는 동작만. 모두 기존 경로(화 만들기·폴더 열기·저장·검색·설정·AI 컨트롤러·탭 닫기·외관 설정)를 부른다.
   * AI 명령은 도구줄·탐색기와 같은 AnalysisBar 컨트롤러 하나를 거치므로 실행 확인(동의·비용)도 같다.
   */
  const commands: PaletteCommand[] = [
    { id: 'new-chapter', label: '새 화 만들기', hint: '화 목록 끝에 빈 화를 더합니다', disabled: busy ? '다른 조작 중' : undefined, run: () => void newChapter() },
    { id: 'open-folder', label: '원고 폴더 열기…', hint: '다른 원고 폴더로 바꿉니다', disabled: switching ? '폴더를 바꾸는 중' : undefined, run: () => void chooseFolder() },
    { id: 'save', label: '현재 화 저장', shortcut: 'Ctrl+S', disabled: file ? undefined : '열린 화 없음', run: () => void editor.current?.flush() },
    { id: 'search', label: '원고 전체 검색', shortcut: 'Ctrl+Shift+F', run: () => search.current?.focus() },
    { id: 'settings', label: '환경설정 열기', hint: '테마·글꼴·AI 키와 모델', run: () => setSettingsOpen(true) },
    { id: 'analyze', label: '이 화 분석', hint: '실행 전에 범위와 예상 비용을 확인합니다', disabled: !file ? '열린 화 없음' : !ai || switching ? '준비 중' : undefined, run: () => aiRef.current?.analyzeCurrent() },
    { id: 'analyze-pending', label: `남은 화 분석 (${pendingAnalysis})`, hint: '분석하지 않았거나 분석 뒤 바뀐 화', disabled: !ai || switching ? '준비 중' : pendingAnalysis === 0 ? '남은 화 없음' : undefined, run: () => aiRef.current?.analyzePending() },
    { id: 'check', label: '이 화 검사', hint: '앞 화와 비교해 문제 가능성을 찾습니다', disabled: !file ? '열린 화 없음' : !ai || switching ? '준비 중' : undefined, run: () => aiRef.current?.checkCurrent() },
    { id: 'reload-ai', label: 'AI 분석·검사 결과 다시 읽기', disabled: !ai ? '준비 중' : undefined, run: () => { refreshAi(); setAiVersion((v) => v + 1); } },
    { id: 'close-tab', label: '현재 탭 닫기', disabled: file ? undefined : '열린 화 없음', run: () => file && void closeTab(file) },
    ...THEMES.map((t) => ({
      id: `theme-${t.id}`,
      label: `테마: ${t.label}`,
      hint: t.scheme === 'dark' ? '다크' : '라이트',
      run: () => appearance.update({ theme: t.id, followSystem: false }),
    })),
  ];

  /**
   * 탐색기 상태 배지 (색만으로 구분하지 않는다: 기호 + 접근 이름). 검사·분석에서 읽은 실제 값만 쓴다.
   *   검사 뒤 본문이 바뀜 ◐ · 검사 최신이고 문제 가능성 n개 n · 검사 최신이고 없음 ✓ · (검사 전) 분석 최신 ✓ · 분석 뒤 바뀜 ◐ · 아무것도 안 함 –(CSS)
   * 오래된(stale) 검사의 숫자는 확정처럼 보이지 않게 숫자를 내지 않는다.
   */
  const badgeOf = (f: string): { kind: string; glyph: string; label: string } | null => {
    if (!ai) return null;
    const check = ai.checkStates[f];
    const count = ai.issueCounts[f];
    if (check === 'stale') return { kind: 'stale', glyph: '◐', label: '검사한 뒤 본문이 바뀜' };
    if (check === 'fresh') {
      return count && count > 0
        ? { kind: 'issues', glyph: String(count), label: `문제 가능성 ${count}개` }
        : { kind: 'fresh', glyph: '✓', label: '검사함: 문제 가능성 없음' };
    }
    const analysis = ai.states[f];
    if (analysis === 'fresh' || analysis === 'stale') return { kind: analysis, glyph: analysis === 'fresh' ? '✓' : '◐', label: MARK_TITLE[analysis] };
    return null;
  };

  return (
    <div className="shell">
      <header className="titlebar">
        <span className="brand">LoreWeave</span>
        <button type="button" className="search-trigger" title="명령 팔레트 (Ctrl+K)" onClick={openPalette}>
          <span aria-hidden="true">⌕</span> 명령 팔레트 <kbd>Ctrl+K</kbd>
        </button>
        <button onClick={chooseFolder} title="다른 원고 폴더 열기" disabled={switching}>
          열기
        </button>
        {/* 활동 막대가 숨는 좁은 창(<760px)에서만 보이는 설정 진입점 (CSS가 넓을 때는 display:none이라 접근 이름이 겹치지 않는다) */}
        <button type="button" className="titlebar-settings" title="환경설정" onClick={() => setSettingsOpen(true)}>
          설정
        </button>
      </header>
      <div className="shell-body">
        <ActivityBar
          searching={searching}
          onExplorer={() => search.current?.clear()}
          onSearch={() => search.current?.focus()}
          onSettings={() => setSettingsOpen(true)}
        />
        <aside className="sidebar">
          <header>
            <strong title={project.name}>{project.name}</strong>
            <button className="new-chapter" onClick={newChapter} disabled={busy}>
              + 새 화
            </button>
          </header>
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
            <h2 className="section-label">원고</h2>
            {project.list.chapters.length === 0 && <p className="empty">아직 화가 없습니다. 위의 [+ 새 화]로 만드세요.</p>}
            {project.list.chapters.map((c) => (
              <button
                key={c.file}
                className={c.file === file ? 'chapter current' : 'chapter'}
                data-no={c.file.replace(/\.md$/, '')}
                data-ai={ai && !c.unreadable && !badgeOf(c.file) ? 'none' : undefined}
                aria-current={c.file === file ? 'page' : undefined}
                disabled={c.unreadable}
                title={c.unreadable ? 'UTF-8이 아닌 파일이라 열 수 없습니다' : c.file}
                onClick={() => openChapter(c.file)}
              >
                {c.title}
                {(() => {
                  const badge = badgeOf(c.file);
                  return badge && (
                    <span className={`mark mark-${badge.kind}`} title={badge.label} aria-label={badge.label}>
                      {badge.glyph}
                    </span>
                  );
                })()}
              </button>
            ))}
          </nav>
          <section className="ai-work" aria-label="AI 작업">
            <h2 className="section-label">AI 작업</h2>
            <div ref={setExplorerSlot} />
            <p className="local-note">
              원고 파일은 이 컴퓨터의 폴더에 저장됩니다. AI는 작가가 버튼을 눌러 동의한 때에만 그 화의 본문을 OpenAI로 보냅니다.
            </p>
          </section>
        </aside>
        <section className="workspace" aria-label="원고 작업 영역">
          {tabs.length > 0 && (
            <ChapterTabs tabs={tabs} current={file} titleOf={titleOf} disabled={busy} onSelect={openChapter} onClose={closeTab} />
          )}
          {file && (
            <div className="editor-toolbar">
              <span className="file-path" title={`chapters/${file}`}>
                chapters/{file}
              </span>
              <div ref={setToolbarSlot} className="toolbar-actions" />
            </div>
          )}
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
                onQuoteMissing={onQuoteMissing}
                marks={reviewMarks.file === file ? reviewMarks.quotes : undefined}
                onReady={() => setEditorTick((t) => t + 1)}
              />
            ) : (
              <p className="editor-message">
                {project.list.chapters.length === 0 ? '아직 화가 없습니다. 왼쪽 위의 [+ 새 화]로 첫 화를 만드세요.' : '왼쪽에서 화를 고르거나 새 화를 만드세요.'}
              </p>
            )}
          </main>
        </section>
        {file && (
          <div className="ai-panel">
            <IssuesPanel
              // 형제(FactsPanel)와 key가 같으면 React가 이전 프로젝트의 패널을 지우지 못하고 새 패널 옆에 남긴다
              key={`issues:${projectGen}`}
              file={file}
              projectToken={project.token}
              locked={switching}
              state={ai?.checkStates[file]}
              version={aiVersion}
              currentLines={() => editor.current?.lines() ?? null}
              onJump={jumpHere}
              onOpenEvidence={openEvidence}
              onMarks={(quotes) => setReviewMarks({ file, quotes })}
              onDismissed={refreshAi}
            />
            <FactsPanel
              key={`facts:${projectGen}`}
              file={file}
              projectToken={project.token}
              locked={switching}
              state={ai?.states[file]}
              version={aiVersion}
              currentLines={() => editor.current?.lines() ?? null}
              onJump={jumpHere}
            />
          </div>
        )}
      </div>
      <footer className="statusbar" role="status">
        <span>{current?.title ?? ''}</span>
        <span className={`save save-${save.status.kind}`}>
          <span aria-hidden="true">{STATUS_SYMBOL[save.status.kind]}</span>{' '}
          <span>
            {STATUS_TEXT[save.status.kind]}
            {save.status.kind === 'error' && `: ${saveError?.summary}.`}
          </span>
          {save.status.kind === 'error' && (
            <>
              {' '}
              <span>입력은 이 화면에 남아 있고 디스크에는 아직 저장되지 않았습니다. Ctrl+S로 다시 저장할 수 있습니다.</span>
              {saveError?.detail && (
                <>
                  {' '}
                  <button type="button" className="link" aria-expanded={saveDetailOpen} onClick={() => setSaveDetailOpen((v) => !v)}>
                    {saveDetailOpen ? '상세 닫기' : '기술 상세'}
                  </button>
                </>
              )}
            </>
          )}
        </span>
        {save.changesOnReopen !== null && (
          <span className="warning">
            <span aria-hidden="true">⚠</span> {save.changesOnReopen + 1}번째 줄 근처는 다시 열면 다르게 보입니다 (예: `*` 두 개 사이가 기울임이 됨)
          </span>
        )}
        {notice && (
          <span className="notice">
            <span aria-hidden="true">ℹ</span> {notice}
          </span>
        )}
        {ai?.recoveredFrom && (
          <span className="warning">
            <span aria-hidden="true">⚠</span> AI 분석 파일이 깨져 옮겨 두었습니다: {ai.recoveredFrom}
          </span>
        )}
        {error && (
          <span className="error">
            <span aria-hidden="true">✕</span> {error}
            {errorDetail && (
              <>
                {' '}
                <button type="button" className="link" aria-expanded={errorOpen} onClick={() => setErrorOpen((v) => !v)}>
                  {errorOpen ? '상세 닫기' : '기술 상세'}
                </button>
              </>
            )}
          </span>
        )}
        {ai && ai.totalCostUsd > 0 && <span className="cost">이 프로젝트 AI 비용 ${ai.totalCostUsd.toFixed(4)}</span>}
      </footer>
      {((saveDetailOpen && saveError?.detail) || (errorOpen && errorDetail)) && (
        <div className="tech-popover" role="note" aria-label="기술 상세">
          {saveDetailOpen && saveError?.detail && <code>{saveError.detail}</code>}
          {errorOpen && errorDetail && <code>{errorDetail}</code>}
        </div>
      )}
      {ai && !switching && (
        <AnalysisBar
          ref={aiRef}
          file={file}
          projectToken={project.token}
          states={ai.states}
          consent={ai.consent}
          beforeAnalyze={() => editor.current?.flush() ?? Promise.resolve()}
          onAnalyzed={() => {
            refreshAi();
            setAiVersion((v) => v + 1);
          }}
          onNeedKey={() => setSettingsOpen(true)}
          lockInput={() => {
            lockEditor();
            let released = false;
            return () => {
              if (released) return;
              released = true;
              unlockEditor(false);
            };
          }}
          toolbarSlot={toolbarSlot}
          explorerSlot={explorerSlot}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          commands={commands}
          onCancel={() => closePalette(true)}
          onRun={(c) => {
            // 닫은 뒤 실행한다 (실행이 포커스를 옮기고, Enter의 키 입력이 새 포커스로 가지 않게). 포커스를 옮기는 명령은 원래 자리로 돌려주지 않는다
            const movesFocus = ['new-chapter', 'open-folder', 'search', 'settings', 'analyze', 'analyze-pending', 'check'].includes(c.id);
            closePalette(!movesFocus);
            setTimeout(c.run, 0);
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog appearance={appearance} totalCostUsd={ai?.totalCostUsd ?? 0} onClose={() => setSettingsOpen(false)} onChange={() => refreshAi()} />
      )}
    </div>
  );
}
