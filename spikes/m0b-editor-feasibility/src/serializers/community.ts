// (b) 커뮤니티 `tiptap-markdown`. markdown-it → HTML → 에디터 스키마로 읽고, prosemirror-markdown으로 쓴다.
// 에디터 인스턴스가 필요하므로 화면에 붙이지 않은 에디터를 하나 만들어 둔다. Node에서는 DOM이 필요하다 (src/dom.ts).
// 기본 옵션 그대로 쓴다 (html: true, breaks: false).

import { Editor } from '@tiptap/core';
import { Markdown, type MarkdownStorage } from 'tiptap-markdown';
import { baseExtensions } from '../editor/extensions.ts';
import type { Converter, PMNode } from '../roundtrip.ts';

export function communityConverter(): Converter {
  const editor = new Editor({
    extensions: [...baseExtensions(), Markdown],
    enableInputRules: false,
    enablePasteRules: false,
  });
  const storage = editor.storage as unknown as { markdown: MarkdownStorage };
  return {
    name: 'community',
    parse(body) {
      editor.commands.setContent(body, { emitUpdate: false });
      return editor.getJSON() as PMNode;
    },
    serialize(doc) {
      editor.commands.setContent(doc, { emitUpdate: false });
      return storage.markdown.getMarkdown();
    },
  };
}
