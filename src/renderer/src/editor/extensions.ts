// 에디터 스키마와 입력 설정 (ADR 0002 결정 1·6, M1-PLAN 3절).
// 원고 형식(C3)이 표현할 수 있는 것만 남긴다: 문단, 제목, 구분선, 인용(문단만), 굵게, 기울임.

import { Extension, type EditorOptions } from '@tiptap/core';
import Blockquote from '@tiptap/extension-blockquote';
import { Fragment, Slice } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';

/** C3에는 문단 안 줄바꿈이 없으므로 Shift+Enter도 새 문단으로 만든다 */
const LineIsParagraph = Extension.create({
  name: 'lineIsParagraph',
  addKeyboardShortcuts() {
    return { 'Shift-Enter': ({ editor }) => editor.commands.splitBlock() };
  },
});

export const extensions = [
  StarterKit.configure({
    bulletList: false,
    orderedList: false,
    listItem: false,
    listKeymap: false,
    code: false,
    codeBlock: false,
    strike: false,
    underline: false,
    link: false,
    hardBreak: false,
    blockquote: false,
    // 마지막 블록이 문단이 아니면 빈 문단을 붙인다. 원고를 바꾸므로 끈다
    trailingNode: false,
  }),
  // 인용 안에는 문단만 (C3의 `> ` 줄은 문단으로만 읽힌다)
  Blockquote.extend({ content: 'paragraph+' }),
  LineIsParagraph,
];

/** 붙여넣기는 서식을 지우고 글자만, 줄마다 문단으로 넣는다. 바깥에서 끌어다 놓기는 받지 않는다 */
export const editorProps: EditorOptions['editorProps'] = {
  handlePaste(view, event) {
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return true;
    const { schema, tr } = view.state;
    const paragraphs = text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => schema.nodes['paragraph']!.create(null, line ? schema.text(line) : null));
    view.dispatch(tr.replaceSelection(new Slice(Fragment.from(paragraphs), 1, 1)).scrollIntoView());
    return true;
  },
  handleDrop: (_view, _event, _slice, moved) => !moved,
  handleDOMEvents: {
    // 키 처리(Enter 등)는 PM 상태의 선택을 쓴다. PM은 DOM 선택 변경을 selectionchange 이벤트로만 알아채고, keydown의 forceFlush는 예약된 flush가 있을 때만 일한다.
    // 그래서 클릭이 만든 DOM 선택 변경보다 키가 먼저 오면 Enter가 옛 선택(문서 시작)에서 문단을 쪼개 입력이 엉뚱한 곳에 들어갔다.
    // 키를 처리하기 전에 지금의 DOM 선택을 PM 상태에 반영한다 (조합 중인 입력(한글 등)은 건드리지 않는다).
    keydown(view, event) {
      if (event.isComposing || event.keyCode === 229 || view.composing) return false;
      const observer = (view as unknown as { domObserver?: { forceFlush?: () => void; flush?: () => void } }).domObserver;
      observer?.forceFlush?.();
      observer?.flush?.();
      return false;
    },
  },
};
