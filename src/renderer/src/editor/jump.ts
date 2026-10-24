// 줄 주소 → 에디터 위치 (M2-PLAN 2절). 검색 결과와 M4 "근거로 이동"이 쓴다.
// 줄 → 블록은 core의 lineToBlock이 정하고, 여기서는 그 블록 안의 글자 위치를 ProseMirror 위치로 바꾼다.

import type { Editor } from '@tiptap/core';
import type { Doc } from '../../../core/manuscript/doc.ts';
import { lineToBlock } from '../../../core/manuscript/lines.ts';

/**
 * 본문 줄 line 안의 글자 범위 [from, to) (보이는 글자 기준 UTF-16 위치)를 에디터 위치로 바꾼다.
 * 줄이 문서 밖이면 null.
 */
export function lineRangeToPositions(editor: Editor, line: number, from: number, to: number): { from: number; to: number } | null {
  const pos = lineToBlock(editor.getJSON() as Doc, line);
  if (!pos) return null;
  const doc = editor.state.doc;
  let start = 0;
  for (let i = 0; i < pos.block; i++) start += doc.child(i).nodeSize;
  let node = doc.child(pos.block);
  if (pos.child !== null) {
    start += 1; // 인용 블록 안으로
    for (let j = 0; j < pos.child; j++) start += node.child(j).nodeSize;
    node = node.child(pos.child);
  }
  const contentStart = start + 1;
  let lineInBlock = 0;
  let column = 0;
  let a: number | null = null;
  let b: number | null = null;
  node.forEach((child, offset) => {
    if (child.type.name === 'hardBreak') {
      lineInBlock++;
      column = 0;
      return;
    }
    if (!child.isText || lineInBlock !== pos.lineInBlock) return;
    const length = child.text!.length;
    if (a === null && from >= column && from <= column + length) a = contentStart + offset + (from - column);
    if (b === null && to >= column && to <= column + length) b = contentStart + offset + (to - column);
    column += length;
  });
  return { from: a ?? contentStart, to: b ?? a ?? contentStart };
}
