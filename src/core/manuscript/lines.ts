// 줄 주소 (M2-PLAN 2절, M0-B H-B6). 화 안의 위치는 본문(frontmatter 제외)의 0부터 시작하는 줄 번호로 가리킨다.
// 색인과 에디터가 이 모듈 하나로 줄을 센다. 줄 수는 직렬화 결과(serializeC3)와 같다:
// 문단·제목·구분선은 한 줄, 인용은 안의 문단 수만큼, 강제 줄바꿈은 줄을 하나 더한다.

import type { Block, Doc, Inline } from './doc.ts';

/** 인라인 내용을 줄별 글자로 (강제 줄바꿈에서 나뉨, 강조 구분자 없이 보이는 글자만) */
function inlineLines(content: Inline[] = []): string[] {
  const lines = [''];
  for (const n of content) {
    if (n.type === 'hardBreak') lines.push('');
    else if (n.type === 'text') lines[lines.length - 1] += n.text;
  }
  return lines;
}

function blockLines(block: Block): string[] {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return inlineLines(block.content);
    case 'horizontalRule':
      return [''];
    case 'blockquote':
      return (block.content ?? []).flatMap(blockLines);
    default:
      return [];
  }
}

/** 줄마다 화면에 보이는 글자. 색인이 담는 글자다 */
export function visibleLines(doc: Doc): string[] {
  return (doc.content ?? []).flatMap(blockLines);
}

export interface LinePosition {
  /** 최상위 블록 번호 */
  block: number;
  /** 인용 안이면 그 안의 블록 번호, 아니면 null */
  child: number | null;
  /** 그 블록(또는 안쪽 블록) 안에서 몇 번째 줄인가 (강제 줄바꿈이 있을 때만 0이 아님) */
  lineInBlock: number;
}

/** 줄 번호 → 에디터 블록 위치. 줄이 문서 밖이면 null */
export function lineToBlock(doc: Doc, line: number): LinePosition | null {
  if (line < 0) return null;
  let start = 0;
  const blocks = doc.content ?? [];
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b]!;
    if (block.type === 'blockquote') {
      const children = block.content ?? [];
      for (let c = 0; c < children.length; c++) {
        const count = blockLines(children[c]!).length;
        if (line < start + count) return { block: b, child: c, lineInBlock: line - start };
        start += count;
      }
      continue;
    }
    const count = blockLines(block).length;
    if (line < start + count) return { block: b, child: null, lineInBlock: line - start };
    start += count;
  }
  return null;
}
