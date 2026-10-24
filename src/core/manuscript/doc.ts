// 원고 문서 모델. TipTap(ProseMirror) JSON과 같은 모양이라 에디터의 getJSON() 결과를 그대로 받는다.
// 지원 서브셋 (ADR 0002 결정 1): 문단, 제목, 구분선, 인용, 굵게, 기울임, 강제 줄바꿈.

export type MarkType = 'bold' | 'italic';

export interface Mark {
  type: MarkType;
}

export interface TextNode {
  type: 'text';
  text: string;
  marks?: Mark[];
}

export interface HardBreak {
  type: 'hardBreak';
}

export type Inline = TextNode | HardBreak;

export interface Paragraph {
  type: 'paragraph';
  content?: Inline[];
}

export interface Heading {
  type: 'heading';
  attrs: { level: number };
  content?: Inline[];
}

export interface HorizontalRule {
  type: 'horizontalRule';
}

export interface Blockquote {
  type: 'blockquote';
  content?: Block[];
}

export type Block = Paragraph | Heading | HorizontalRule | Blockquote;

export interface Doc {
  type: 'doc';
  content?: Block[];
}

const markKey = (n: TextNode) =>
  (n.marks ?? [])
    .map((m) => m.type)
    .sort()
    .join('+');

const withMarks = (text: string, from: TextNode): TextNode =>
  from.marks?.length ? { type: 'text', text, marks: from.marks } : { type: 'text', text };

/**
 * 같은 내용을 같은 모양으로 맞춘다: 빈 글자 노드 제거, 강조 앞뒤 공백을 강조 밖으로, 이웃한 같은 강조 합치기.
 * 저장 전 검사에서 에디터 문서와 다시 읽은 문서를 비교할 때 쓴다.
 */
export function canonicalInline(content: Inline[] = []): Inline[] {
  const split: Inline[] = [];
  for (const n of content) {
    if (n.type !== 'text') {
      split.push(n);
      continue;
    }
    if (!n.marks?.length) {
      split.push(n);
      continue;
    }
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(n.text)!;
    if (lead) split.push({ type: 'text', text: lead });
    if (core) split.push(withMarks(core, n));
    if (trail) split.push({ type: 'text', text: trail });
  }
  const out: Inline[] = [];
  for (const n of split) {
    if (n.type === 'text' && n.text === '') continue;
    const prev = out.at(-1);
    if (n.type === 'text' && prev?.type === 'text' && markKey(prev) === markKey(n)) {
      out[out.length - 1] = withMarks(prev.text + n.text, prev);
    } else {
      out.push(n.type === 'text' ? withMarks(n.text, n) : n);
    }
  }
  return out;
}

function canonicalBlock(b: Block): unknown {
  switch (b.type) {
    case 'paragraph':
      return { type: 'paragraph', content: canonicalInline(b.content) };
    case 'heading':
      return { type: 'heading', level: b.attrs.level, content: canonicalInline(b.content) };
    case 'horizontalRule':
      return { type: 'horizontalRule' };
    case 'blockquote':
      return { type: 'blockquote', content: (b.content ?? []).map(canonicalBlock) };
  }
}

/** 두 문서가 같은 내용인지 비교한다. 다르면 처음 달라지는 최상위 블록 번호(0부터), 같으면 -1. */
export function firstDifference(a: Doc, b: Doc): number {
  const ca = (a.content ?? []).map((x) => JSON.stringify(canonicalBlock(x)));
  const cb = (b.content ?? []).map((x) => JSON.stringify(canonicalBlock(x)));
  for (let i = 0; i < Math.max(ca.length, cb.length); i++) if (ca[i] !== cb[i]) return i;
  return -1;
}
