// 화 하나를 열어 편집하고 자동 저장한다 (M1-PLAN 1·4절).
//   - 입력이 멈추고 1.5초 뒤 저장, 부모가 flush()로 즉시 저장 (화 이동, 창 포커스 잃음, Ctrl+S, 종료)
//   - 저장은 한 번에 하나씩. 저장 중에 입력이 있으면 끝난 뒤 다시 저장한다
//   - 디스크가 다른 프로그램에서 바뀌었으면 자동 저장을 멈추고 사용자에게 묻는다

import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { openManuscript, serializeManuscript, type Doc, type Envelope } from '../../core/manuscript/index.ts';
import { editorProps, extensions } from './editor/extensions.ts';
import { lineRangeToPositions } from './editor/jump.ts';
import { ConflictCompare } from './ConflictCompare.tsx';
import { ErrorNote } from './ErrorNote.tsx';
import { friendlyReadError } from './userError.ts';
import { reviewMarksKey, type MarkRange } from './editor/reviewMarks.ts';
import { locateQuote } from '../../core/ai/locate.ts';
import { visibleLines } from '../../core/manuscript/lines.ts';

const AUTOSAVE_DELAY_MS = 1500;
const RETRY_DELAY_MS = 5000;

export type SaveStatus =
  | { kind: 'saved' }
  | { kind: 'unsaved' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string }
  | { kind: 'conflict'; diskHash: string | null };

/**
 * 본문 줄 line의 글자 범위 [from, to)를 선택한다. 또는 quote를 지금 에디터 본문(저장 전 입력 포함)에서 찾아 그 문장을 선택한다
 * (저장된 위치는 그 뒤 고친 원고와 맞지 않을 수 있다). seq가 바뀔 때마다 다시 이동한다
 */
/** clear: 인용을 지금 본문에서 찾지 못했을 때, 이전 선택이 근거처럼 남지 않게 선택만 접는다 */
/**
 * line 이동의 text: 검색 당시 그 줄의 글. 있으면 지금 본문에서 같은 줄을 확인한 뒤에만 옮긴다 (검색한 뒤 본문이 바뀌었을 수 있다).
 * pristine: 검색한 뒤 이 편집기가 한 번도 바뀌지 않았다 (옛 좌표가 그대로 맞다). prev/next: 검색 당시 앞뒤 줄 (null은 문서의 처음·끝, undefined는 모름)
 */
export type Jump = ({ line: number; from: number; to: number; text?: string; pristine?: boolean; prev?: string | null; next?: string | null } | { quote: string } | { clear: true }) & { seq: number };

export interface ChapterEditorHandle {
  /** 저장할 것이 있으면 저장한다. 끝난 뒤 저장 안 된 변경이 남아 있으면 false */
  flush(): Promise<boolean>;
  /** 지금 에디터 본문의 줄별 글자 (M2 줄 주소). 아직 열리는 중이면 null */
  lines(): string[] | null;
  /** 이 편집기 인스턴스와 편집 횟수를 합친 표식. 같으면 그 사이 문서가 바뀌지 않았다 (아직 열리는 중이면 null) */
  editId(): string | null;
  /** 입력·붙여넣기를 바로 막거나 푼다 (프로젝트를 바꾸는 동안). React 다시 그리기를 기다리지 않는다 */
  setLocked(locked: boolean): void;
  /** 편집기로 포커스를 돌린다. PM 상태의 선택으로 DOM 선택을 되돌려 놓는다 (팔레트·대화상자를 닫은 뒤) */
  focus(): void;
}

interface Props {
  file: string;
  /** 이 화를 연 프로젝트의 token. 읽기·쓰기에 함께 보낸다 (프로젝트가 바뀌면 main이 거절한다) */
  projectToken: number;
  onStatus(status: SaveStatus, changesOnReopen: number | null): void;
  onSaved(text: string): void;
  /** 이 화를 디스크에서 읽는 데 성공했다 (처음 열기·[디스크 내용 불러오기]·외부 변경 재읽기·[다시 시도]). 읽은 파일 내용으로 표시 제목을 맞추는 데 쓴다. 실패·취소된 읽기는 부르지 않는다 */
  onLoaded?(file: string, projectToken: number, text: string): void;
  /** 디스크 내용을 다시 불러온다 (부모가 이 컴포넌트를 새로 만든다). outside: 다른 프로그램의 변경 때문에 자동으로 */
  onReload(outside?: boolean): void;
  jump?: Jump | null;
  /** 검색 결과 이동(jump)의 줄이 지금 본문에서 사라졌거나 하나로 정할 수 없다. 아무것도 선택하지 않는다 */
  onMatchMissing?(): void;
  /** jump의 quote를 지금 본문에서 찾지 못했다 (지워졌거나 바뀜). 아무것도 선택하지 않는다 */
  onQuoteMissing?(quote: string): void;
  /** true면 읽기 전용 (프로젝트를 바꾸는 동안 열린 에디터) */
  locked?: boolean;
  /**
   * 물결 밑줄과 거터 점을 그릴 문장들 (최신 검사 결과의 문제 가능성). 지금 본문에서 다시 찾아 찾은 것만 그린다 (표시 전용, 문서에 저장하지 않는다)
   */
  marks?: string[];
  /** 편집기가 만들어져 본문을 읽을 수 있게 됐다 (패널이 지금 본문과 대조해 다시 그리게 한다) */
  onReady?(): void;
  /** 탭 닫기 대기 중 사용자가 옮긴 포커스를 시작 포커스가 빼앗지 않게 하는 한 번용 표시 (App이 닫기 때만 채운다) */
  keepFocus?: { current: HTMLElement | null };
}

interface Loaded {
  envelope: Envelope;
  doc: Doc;
  hash: string;
}

export const ChapterEditor = forwardRef<ChapterEditorHandle, Props>(function ChapterEditor(props, ref) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** [다시 시도]로 같은 화를 다시 읽은 횟수 (사용자가 누를 때만 늘어난다. 자동 재시도는 없다) */
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const onLoadedRef = useRef(props.onLoaded);
  onLoadedRef.current = props.onLoaded;

  useEffect(() => {
    let cancelled = false;
    window.loreweave.chapters.read(props.file, props.projectToken).then(
      ({ text, hash }) => {
        if (cancelled) return;
        setLoaded({ ...openManuscript(text), hash });
        onLoadedRef.current?.(props.file, props.projectToken, text);
        setLoadError(null);
        setRetrying(false);
      },
      (e: Error) => {
        if (cancelled) return;
        setLoadError(e.message);
        setRetrying(false);
      },
    );
    // 화·프로젝트가 바뀌거나 다시 시도하면 이전 읽기의 늦은 응답은 버린다
    return () => {
      cancelled = true;
    };
  }, [props.file, props.projectToken, attempt]);

  if (loadError && !retrying)
    return (
      <p className="editor-message">
        {/* 기본 안내에는 IPC 문구·영문 시스템 오류·경로·코드를 두지 않고, 원문은 펼치는 기술 상세에 둔다. 상세의 열림은 이 오류 표시의 수명에만 속한다 (다시 시도·다른 화로 가면 새로 접힌 채 시작) */}
        <ErrorNote
          prefix="이 화를 열 수 없습니다"
          error={friendlyReadError(loadError)}
          retryLabel="다시 시도"
          onRetry={() => {
            setRetrying(true);
            setAttempt((n) => n + 1);
          }}
        />
      </p>
    );
  if (!loaded) return <p className="editor-message">여는 중…</p>;
  return <LoadedEditor ref={ref} {...props} loaded={loaded} />;
});

/**
 * 한 프레임 뒤에, 그 시점의 포커스를 보고 편집기에 포커스를 준다. 입력란(검색창 등)에 포커스가 있으면 주지 않는다.
 * TipTap의 commands.focus / chain().focus()는 view.focus()를 requestAnimationFrame으로 예약해 실행 시점의 포커스를 보지 못한다 —
 * 예약 뒤에 사용자가 검색창을 선택하면 그 선택을 덮고, 이어지는 글자·Enter가 원고로 들어간다. 그래서 선택은 포커스 없이 즉시 설정하고 포커스만 이 함수로 준다
 */
function focusEditorUnlessTyping(target: Editor, keepFocus?: { current: HTMLElement | null }): void {
  requestAnimationFrame(() => {
    // 탭 닫기를 기다리는 사이 사용자가 직접 옮긴 포커스(남은 탭 등)는 이웃 편집기가 만들어진 뒤에도 빼앗지 않는다. 한 번 쓰면 비운다
    const kept = keepFocus?.current ?? null;
    if (keepFocus) keepFocus.current = null;
    if (kept && kept.isConnected && document.activeElement === kept) return;
    if (target.isDestroyed || target.view.hasFocus()) return;
    // 늦게 준비된 편집기·검색 이동이 열린 모달(설정·팔레트·AI 확인)의 키보드 포커스를 빼앗지 않는다: 모달이 닫히면 모달이 연 곳으로 포커스를 돌려준다
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    target.view.focus();
  });
}

let editorInstances = 0;

const LoadedEditor = forwardRef<ChapterEditorHandle, Props & { loaded: Loaded }>(function LoadedEditor(
  { file, projectToken, loaded, onStatus, onSaved, onReload, jump, onQuoteMissing, onMatchMissing, locked = false, marks, onReady, keepFocus },
  ref,
) {
  const editorRef = useRef<Editor | null>(null);
  const hash = useRef<string | null>(loaded.hash);
  const version = useRef(0);
  const [instanceId] = useState(() => ++editorInstances);
  const savedVersion = useRef(0);
  // 바깥 변경 충돌을 알린 횟수. 저장이 시작된 뒤 늘었다면 그 저장의 늦은 성공 응답이 충돌을 지우면 안 된다
  const conflictSeq = useRef(0);
  const saving = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 에디터 콜백과 타이머가 최신 상태를 보도록 ref에도 둔다
  const status = useRef<SaveStatus>({ kind: 'saved' });
  const [conflict, setConflict] = useState<{ diskHash: string | null } | null>(null);
  /** 충돌 안내의 [차이 보기]: 내 화면과 디스크를 읽기 전용으로 비교한다 */
  const [comparing, setComparing] = useState(false);

  const report = useCallback(
    (next: SaveStatus, changesOnReopen: number | null = null) => {
      status.current = next;
      setConflict(next.kind === 'conflict' ? { diskHash: next.diskHash } : null);
      if (next.kind !== 'conflict') setComparing(false);
      onStatus(next, changesOnReopen);
    },
    [onStatus],
  );

  const isComposing = useCallback(() => {
    const ed = editorRef.current;
    return !!ed && !ed.isDestroyed && ed.view.composing;
  }, []);

  const schedule = useCallback((delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // 자동저장·재시도 타이머는 조합(한글 등) 중에 미확정 글자를 디스크에 쓰지 않는다. 폴링하지 않고 그냥 두면 compositionend가 다시 건다.
      // (명시적 flush(이동·창 닫기·blur·Ctrl+S)는 이 경로가 아니라 saveRef를 직접 부르므로 그대로다)
      if (isComposing()) return;
      void saveRef.current(undefined, true);
    }, delay);
  }, [isComposing]);

  /** expected: 덮어쓰기를 고른 경우 디스크의 해시. auto: 자동저장·재시도 타이머가 부른 저장 (명시적 flush는 아니다) */
  const save = useCallback(
    async (expected?: string | null, auto = false): Promise<boolean> => {
      if (saving.current) {
        await saving.current;
        // 자동저장은 기존 쓰기를 기다리는 사이 조합이 시작됐다면 새 미확정 스냅샷을 쓰지 않는다 (compositionend가 다시 건다). 명시적 flush는 기존대로 대기 뒤 최신 본문을 저장한다
        if (auto && isComposing()) return false;
        return saveRef.current(expected, auto);
      }
      const editor = editorRef.current;
      if (!editor || (version.current === savedVersion.current && expected === undefined)) return true;
      if (status.current.kind === 'conflict' && expected === undefined) return false;
      if (timer.current) clearTimeout(timer.current);

      const target = version.current;
      const seq = conflictSeq.current;
      const result = serializeManuscript({ envelope: loaded.envelope, doc: editor.getJSON() as Doc });
      if (!result.ok) {
        report({ kind: 'error', message: '저장하면 글자 일부가 사라져서 저장하지 않았습니다' });
        return false;
      }
      report({ kind: 'saving' });
      const run = (async () => {
        try {
          const write = await window.loreweave.chapters.write(
            file,
            result.text,
            expected === undefined ? hash.current : expected,
            projectToken,
          );
          // 쓰는 동안 바깥 변경 충돌(watcher)이 알려졌다면 그 충돌이 최신 상태다: 이 저장의 결과(성공·conflict·실패)로 해시·저장 상태·충돌 안내를 덮지 않는다
          if (conflictSeq.current !== seq) return false;
          if (write.status === 'conflict') {
            report({ kind: 'conflict', diskHash: write.diskHash });
            return false;
          }
          hash.current = write.hash;
          savedVersion.current = target;
          onSaved(result.text);
          const clean = version.current === target;
          report(clean ? { kind: 'saved' } : { kind: 'unsaved' }, result.changesOnReopen);
          if (!clean) schedule(AUTOSAVE_DELAY_MS);
          return clean;
        } catch (e) {
          if (conflictSeq.current !== seq) return false;
          report({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
          schedule(RETRY_DELAY_MS);
          return false;
        }
      })();
      saving.current = run;
      try {
        return await run;
      } finally {
        saving.current = null;
      }
    },
    [file, projectToken, loaded.envelope, onSaved, report, schedule, isComposing],
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  // 검토 표시: marks를 지금 본문에서 다시 찾아 확인된 범위만 장식으로 건다. 조합 중(한글 등)에는 건드리지 않고 끝난 뒤에 건다
  const marksRef = useRef<string[]>(marks ?? []);
  marksRef.current = marks ?? [];
  const markTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyMarks = useCallback(() => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    if (ed.view.composing) {
      markTimer.current = setTimeout(applyMarks, 300);
      return;
    }
    const ranges: MarkRange[] = [];
    if (marksRef.current.length > 0) {
      const lines = visibleLines(ed.getJSON() as Doc);
      for (const quote of marksRef.current) {
        const at = locateQuote(lines, quote);
        const range = at && lineRangeToPositions(ed, at.line, at.start, at.end);
        if (range && range.from < range.to) ranges.push(range);
      }
    }
    // 메타만 있는 트랜잭션: 문서·선택·undo 기록을 바꾸지 않는다
    ed.view.dispatch(ed.state.tr.setMeta(reviewMarksKey, ranges).setMeta('addToHistory', false));
  }, []);
  const scheduleMarks = useCallback(() => {
    if (markTimer.current) clearTimeout(markTimer.current);
    markTimer.current = setTimeout(applyMarks, 500);
  }, [applyMarks]);

  const editor = useEditor({
    extensions,
    editorProps,
    content: loaded.doc,
    enableInputRules: false,
    enablePasteRules: false,
    shouldRerenderOnTransaction: false,
    // 이동할 곳이 있으면 처음 자리로 포커스를 옮기지 않는다 (나중에 실행돼 선택을 덮어쓴다).
    // 시작 포커스는 TipTap의 autofocus 대신 onCreate에서 준다: autofocus는 편집기가 만들어진 뒤(본문 읽기가 끝난 뒤) 무조건 포커스를 가져가서,
    // 그 사이 사용자가 검색창에 쓰던 글자나 Enter가 원고에 들어간다. 검색창 같은 입력란에 포커스가 있으면 가져가지 않는다 (버튼 등에서 화를 연 경우는 전처럼 편집기가 받는다).
    // 확인은 포커스를 주는 바로 그 시점에 한다: TipTap의 commands.focus는 안에서 requestAnimationFrame으로 view.focus()를 다시 예약해, 예약 뒤에 사용자가 검색창을 고르면 그 선택을 덮어쓴다.
    // 그래서 한 프레임 뒤(편집기가 화면에 붙은 뒤)에 실행 시점의 포커스를 보고 view.focus()를 즉시 한다 (지연 focus를 다시 예약하지 않는다).
    // 선택은 건드리지 않는다: 새 편집기의 기본 선택이 이미 문서 시작이고, 그 사이 같은 화의 검색 결과 이동(jump)이 만든 선택을 시작 위치로 되돌리면 안 된다
    autofocus: false,
    onCreate: ({ editor: created }) => {
      onReady?.();
      if (jump) return;
      focusEditorUnlessTyping(created, keepFocus);
    },
    editable: !locked,
    onUpdate: () => {
      if (marksRef.current.length > 0) scheduleMarks();
      version.current++;
      if (status.current.kind === 'conflict') return;
      report({ kind: 'unsaved' });
      schedule(AUTOSAVE_DELAY_MS);
    },
  });
  editorRef.current = editor;

  useImperativeHandle(
    ref,
    () => ({
      flush: () => saveRef.current(),
      lines: () => (editor ? visibleLines(editor.getJSON() as Doc) : null),
      editId: () => (editor ? `${instanceId}:${version.current}` : null),
      // 편집 가능 여부만 바꾸고 변경 알림(onUpdate)은 내지 않는다
      setLocked: (on) => editor?.setEditable(!on, false),
      focus: () => editor?.view.focus(),
    }),
    [editor],
  );

  useEffect(() => {
    editor?.setEditable(!locked, false);
  }, [editor, locked]);

  // 조합이 끝나면 조합 중 건너뛴 자동저장을 기존 정책(저장 실패 뒤는 재시도 간격, 그 밖은 자동저장 간격)으로 다시 건다: 추가 입력이 없어도 저장된다
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom;
    const onEnd = () => {
      if (status.current.kind === 'conflict' || version.current === savedVersion.current) return;
      schedule(status.current.kind === 'error' ? RETRY_DELAY_MS : AUTOSAVE_DELAY_MS);
    };
    dom.addEventListener('compositionend', onEnd);
    return () => dom.removeEventListener('compositionend', onEnd);
  }, [editor, schedule]);

  const marksKey = (marks ?? []).join('\n');
  useEffect(() => {
    if (editor) scheduleMarks();
  }, [editor, marksKey, scheduleMarks]);

  useEffect(() => {
    if (!editor || !jump) return;
    // 찾지 못했으면 이전에 선택해 둔 다른 글자가 근거처럼 남지 않게 선택만 접는다 (본문은 그대로)
    const collapse = () => {
      editor.commands.setTextSelection(editor.state.selection.head);
      focusEditorUnlessTyping(editor);
    };
    if ('clear' in jump) {
      collapse();
      return;
    }
    const current = visibleLines(editor.getJSON() as Doc);
    let at: { line: number; start: number; end: number } | null;
    if ('quote' in jump) at = locateQuote(current, jump.quote);
    else if (jump.text === undefined) at = { line: jump.line, start: jump.from, end: jump.to };
    else {
      // 검색 결과: 검색한 뒤 이 편집기가 바뀌지 않았으면 옛 좌표가 그대로 맞다. 바뀌었다면 줄 글이 같다는 것만으로 같은 일치라고 보지 않는다 (같은 문장이 반복되면
      // 앞에 문단이 더해진 뒤 옛 좌표에 다른 반복이 놓일 수 있다): 검색 당시 앞뒤 줄까지 같은 줄이 본문에 하나뿐일 때만 그 줄로 간다.
      // 정할 수 없으면 엉뚱한 글자를 일치처럼 선택하지 않는다 (앞뒤 줄 정보가 없는 이동은 같은 자리의 같은 줄, 아니면 같은 줄이 하나뿐일 때)
      let line = -1;
      if (jump.pristine && current[jump.line] === jump.text) line = jump.line;
      else if (jump.prev !== undefined && jump.next !== undefined) {
        const same = current.flatMap((t, i) => (t === jump.text && (current[i - 1] ?? null) === jump.prev && (current[i + 1] ?? null) === jump.next ? [i] : []));
        if (same.length === 1) line = same[0]!;
      } else {
        if (current[jump.line] === jump.text) line = jump.line;
        else {
          const same = current.flatMap((t, i) => (t === jump.text ? [i] : []));
          if (same.length === 1) line = same[0]!;
        }
      }
      at = line < 0 ? null : { line, start: jump.from, end: jump.to };
    }
    const range = at && lineRangeToPositions(editor, at.line, at.start, at.end);
    if (!range) {
      if ('quote' in jump) onQuoteMissing?.(jump.quote);
      else if (jump.text !== undefined) onMatchMissing?.();
      collapse();
      return;
    }
    editor.commands.setTextSelection(range);
    focusEditorUnlessTyping(editor);
    // 찾은 글자를 화면 가운데로 (가장자리에 걸리지 않게)
    const { node } = editor.view.domAtPos(range.from);
    (node instanceof Element ? node : node.parentElement)?.scrollIntoView({ block: 'center' });
    // onQuoteMissing이 바뀌어도 다시 이동하지 않는다 (jump가 바뀔 때만)
  }, [editor, jump]);

  // 다른 프로그램이 이 화를 바꾸면: 저장 안 된 변경이 없으면 다시 불러오고, 있으면 자동 저장을 멈추고 묻는다
  useEffect(
    () =>
      window.loreweave.chapters.onChangedOutside((change) => {
        if (change.file !== file || change.hash === hash.current) return;
        const clean = version.current === savedVersion.current && !saving.current;
        if (clean && change.hash !== null) onReload(true);
        else {
          conflictSeq.current++;
          report({ kind: 'conflict', diskHash: change.hash });
        }
      }),
    [file, onReload, report],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (markTimer.current) clearTimeout(markTimer.current);
    },
    [],
  );

  return (
    <>
      {conflict && (
        <div className="conflict" role="alert">
          <span>
            {conflict.diskHash === null
              ? '이 화 파일이 다른 곳에서 지워졌거나 이름이 바뀌었습니다.'
              : '이 화가 다른 프로그램에서 바뀌었습니다. 자동 저장을 멈췄습니다.'}
          </span>
          <button
            onClick={() => {
              // 지금 알려진 디스크 해시(확인 대상)를 먼저 잡는다. 덮어쓰기는 디스크의 외부 수정이 사라지는 동작이라 먼저 확인하고(삭제 충돌의 다시 만들기는 지울 외부 내용이 없어 그대로),
              // 동의하면 그 해시로 기존 저장 경로를 한 번 실행한다: 그 뒤 디스크가 또 바뀌었다면 해시 검사가 막아 새 바이트를 덮지 않고 충돌로 남는다
              const target = conflict.diskHash;
              if (target !== null && !window.confirm('디스크의 외부 수정이 사라지고 지금 화면의 내용으로 저장됩니다. 계속할까요?')) return;
              void saveRef.current(target);
            }}
          >
            {conflict.diskHash === null ? '내 것으로 다시 만들기' : '내 것으로 덮어쓰기'}
          </button>
          {conflict.diskHash !== null && (
            <button
              onClick={() => {
                // 미저장 수정이 사라지는 동작이라 먼저 확인한다 (화 이동과 같은 window.confirm). 취소하면 편집기·undo·충돌 안내·디스크는 그대로다
                if (window.confirm('저장되지 않은 내 수정이 사라지고 디스크 내용을 불러옵니다. 계속할까요?')) onReload();
              }}
            >
              디스크 내용 불러오기 (내 수정은 버림)
            </button>
          )}
          {conflict.diskHash !== null && (
            <button type="button" aria-expanded={comparing} onClick={() => setComparing((v) => !v)}>
              {comparing ? '차이 닫기' : '차이 보기'}
            </button>
          )}
        </div>
      )}
      {conflict && conflict.diskHash !== null && comparing && editor && (
        <ConflictCompare file={file} projectToken={projectToken} diskHash={conflict.diskHash} editor={editor} />
      )}
      <EditorContent editor={editor} className="manuscript" />
    </>
  );
});
