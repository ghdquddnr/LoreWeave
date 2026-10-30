// 검토 표시 (P3): 문제 가능성 문장의 물결 밑줄과 문단 거터의 점. 표시 전용이다.
// ProseMirror 장식(Decoration)만 쓰므로 문서 모델·직렬화·undo 기록에 들어가지 않고, 복사·붙여넣기·검색에도 섞이지 않는다.
// 위치는 호출한 쪽이 "지금 본문에서 인용을 다시 찾아" 검증한 범위만 넘긴다. 문서가 바뀌면 장식은 편집을 따라 움직이고, 호출한 쪽이 조용해질 때 다시 검증한다.

import { Extension } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface MarkRange {
  from: number;
  to: number;
}

export const reviewMarksKey = new PluginKey<DecorationSet>('reviewMarks');

function build(doc: Node, ranges: MarkRange[]): DecorationSet {
  const decorations: Decoration[] = [];
  const blocks = new Set<number>();
  for (const { from, to } of ranges) {
    if (from >= to || to > doc.content.size) continue;
    decorations.push(Decoration.inline(from, to, { class: 'issue-mark' }));
    const $from = doc.resolve(from);
    const before = $from.before();
    if (!blocks.has(before)) {
      blocks.add(before);
      decorations.push(Decoration.node(before, $from.after(), { class: 'has-issue' }));
    }
  }
  return DecorationSet.create(doc, decorations);
}

export const ReviewMarks = Extension.create({
  name: 'reviewMarks',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: reviewMarksKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const ranges = tr.getMeta(reviewMarksKey) as MarkRange[] | undefined;
            if (ranges) return build(tr.doc, ranges);
            return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
          },
        },
        props: {
          decorations: (state) => reviewMarksKey.getState(state),
        },
      }),
    ];
  },
});
