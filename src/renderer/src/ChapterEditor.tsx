// 화 하나를 열어 편집하고 자동 저장한다 (M1-PLAN 1·4절).
//   - 입력이 멈추고 1.5초 뒤 저장, 부모가 flush()로 즉시 저장 (화 이동, 창 포커스 잃음, Ctrl+S, 종료)
//   - 저장은 한 번에 하나씩. 저장 중에 입력이 있으면 끝난 뒤 다시 저장한다
//   - 디스크가 다른 프로그램에서 바뀌었으면 자동 저장을 멈추고 사용자에게 묻는다

import { Selection } from '@tiptap/pm/state';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { openManuscript, serializeManuscript, type Doc, type Envelope } from '../../core/manuscript/index.ts';
import { editorProps, extensions } from './editor/extensions.ts';
import { lineRangeToPositions } from './editor/jump.ts';
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
export type Jump = ({ line: number; from: number; to: number } | { quote: string } | { clear: true }) & { seq: number };

export interface ChapterEditorHandle {
  /** 저장할 것이 있으면 저장한다. 끝난 뒤 저장 안 된 변경이 남아 있으면 false */
  flush(): Promise<boolean>;
  /** 지금 에디터 본문의 줄별 글자 (M2 줄 주소). 아직 열리는 중이면 null */
  lines(): string[] | null;
  /** 입력·붙여넣기를 바로 막거나 푼다 (프로젝트를 바꾸는 동안). React 다시 그리기를 기다리지 않는다 */
  setLocked(locked: boolean): void;
}

interface Props {
  file: string;
  /** 이 화를 연 프로젝트의 token. 읽기·쓰기에 함께 보낸다 (프로젝트가 바뀌면 main이 거절한다) */
  projectToken: number;
  onStatus(status: SaveStatus, changesOnReopen: number | null): void;
  onSaved(text: string): void;
  /** 디스크 내용을 다시 불러온다 (부모가 이 컴포넌트를 새로 만든다). outside: 다른 프로그램의 변경 때문에 자동으로 */
  onReload(outside?: boolean): void;
  jump?: Jump | null;
  /** jump의 quote를 지금 본문에서 찾지 못했다 (지워졌거나 바뀜). 아무것도 선택하지 않는다 */
  onQuoteMissing?(quote: string): void;
  /** true면 읽기 전용 (프로젝트를 바꾸는 동안 열린 에디터) */
  locked?: boolean;
}

interface Loaded {
  envelope: Envelope;
  doc: Doc;
  hash: string;
}

export const ChapterEditor = forwardRef<ChapterEditorHandle, Props>(function ChapterEditor(props, ref) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.loreweave.chapters.read(props.file, props.projectToken).then(
      ({ text, hash }) => {
        if (!cancelled) setLoaded({ ...openManuscript(text), hash });
      },
      (e: Error) => {
        if (!cancelled) setLoadError(e.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.file, props.projectToken]);

  if (loadError) return <p className="editor-message">이 화를 열 수 없습니다: {loadError}</p>;
  if (!loaded) return <p className="editor-message">여는 중…</p>;
  return <LoadedEditor ref={ref} {...props} loaded={loaded} />;
});

const LoadedEditor = forwardRef<ChapterEditorHandle, Props & { loaded: Loaded }>(function LoadedEditor(
  { file, projectToken, loaded, onStatus, onSaved, onReload, jump, onQuoteMissing, locked = false },
  ref,
) {
  const editorRef = useRef<Editor | null>(null);
  const hash = useRef<string | null>(loaded.hash);
  const version = useRef(0);
  const savedVersion = useRef(0);
  // 바깥 변경 충돌을 알린 횟수. 저장이 시작된 뒤 늘었다면 그 저장의 늦은 성공 응답이 충돌을 지우면 안 된다
  const conflictSeq = useRef(0);
  const saving = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 에디터 콜백과 타이머가 최신 상태를 보도록 ref에도 둔다
  const status = useRef<SaveStatus>({ kind: 'saved' });
  const [conflict, setConflict] = useState<{ diskHash: string | null } | null>(null);

  const report = useCallback(
    (next: SaveStatus, changesOnReopen: number | null = null) => {
      status.current = next;
      setConflict(next.kind === 'conflict' ? { diskHash: next.diskHash } : null);
      onStatus(next, changesOnReopen);
    },
    [onStatus],
  );

  const schedule = useCallback((delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveRef.current(), delay);
  }, []);

  /** expected: 덮어쓰기를 고른 경우 디스크의 해시 */
  const save = useCallback(
    async (expected?: string | null): Promise<boolean> => {
      if (saving.current) {
        await saving.current;
        return saveRef.current(expected);
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
    [file, projectToken, loaded.envelope, onSaved, report, schedule],
  );
  const saveRef = useRef(save);
  saveRef.current = save;

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
    // 그래서 한 프레임 뒤(편집기가 화면에 붙은 뒤)에 실행 시점의 포커스를 보고, 시작 위치 선택과 view.focus()를 즉시 한다 (지연 focus를 다시 예약하지 않는다)
    autofocus: false,
    onCreate: ({ editor: created }) => {
      if (jump) return;
      requestAnimationFrame(() => {
        if (created.isDestroyed || created.view.hasFocus()) return;
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
        created.view.dispatch(created.state.tr.setSelection(Selection.atStart(created.state.doc)));
        created.view.focus();
      });
    },
    editable: !locked,
    onUpdate: () => {
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
      // 편집 가능 여부만 바꾸고 변경 알림(onUpdate)은 내지 않는다
      setLocked: (on) => editor?.setEditable(!on, false),
    }),
    [editor],
  );

  useEffect(() => {
    editor?.setEditable(!locked, false);
  }, [editor, locked]);

  useEffect(() => {
    if (!editor || !jump) return;
    // 찾지 못했으면 이전에 선택해 둔 다른 글자가 근거처럼 남지 않게 선택만 접는다 (본문은 그대로)
    const collapse = () => editor.chain().focus().setTextSelection(editor.state.selection.head).run();
    if ('clear' in jump) {
      collapse();
      return;
    }
    const at = 'quote' in jump ? locateQuote(visibleLines(editor.getJSON() as Doc), jump.quote) : { line: jump.line, start: jump.from, end: jump.to };
    const range = at && lineRangeToPositions(editor, at.line, at.start, at.end);
    if (!range) {
      if ('quote' in jump) onQuoteMissing?.(jump.quote);
      collapse();
      return;
    }
    editor.chain().focus().setTextSelection(range).run();
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
          <button onClick={() => void saveRef.current(conflict.diskHash)}>
            {conflict.diskHash === null ? '내 것으로 다시 만들기' : '내 것으로 덮어쓰기'}
          </button>
          {conflict.diskHash !== null && <button onClick={() => onReload()}>디스크 내용 불러오기 (내 수정은 버림)</button>}
        </div>
      )}
      <EditorContent editor={editor} className="manuscript" />
    </>
  );
});
