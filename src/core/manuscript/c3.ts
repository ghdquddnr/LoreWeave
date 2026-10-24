// C3 원고 형식 ⇄ 문서 모델 (ADR 0002 결정 2).
// 한 줄 = 한 문단, 빈 줄 = 빈 문단. 알아보는 문법만 노드로 바꾸고 나머지 글자는 그대로 둔다. 이스케이프하지 않는다.
//   줄 단위: `# `~`###### ` 제목, 정확히 `---`인 구분선, `> ` 또는 `>`로 시작하는 연속 줄(인용)
//   줄 안: `***x***` 굵게+기울임, `**x**` 굵게, `*x*` 기울임 (안쪽에 `*` 없음, 안쪽 앞뒤가 공백이 아님)

import type { Block, Doc, Inline, Mark, Paragraph } from './doc.ts';

const HEADING = /^(#{1,6}) (.*)$/;
const DELIMITERS: [string, Mark[]][] = [
  ['***', [{ type: 'bold' }, { type: 'italic' }]],
  ['**', [{ type: 'bold' }]],
  ['*', [{ type: 'italic' }]],
];

function matchEmphasis(text: string, at: number): { inner: string; marks: Mark[]; end: number } | null {
  for (const [delimiter, marks] of DELIMITERS) {
    if (!text.startsWith(delimiter, at)) continue;
    const start = at + delimiter.length;
    const first = text[start];
    if (first === undefined || /[\s*]/.test(first)) continue;
    const close = text.indexOf('*', start);
    if (close === -1 || !text.startsWith(delimiter, close) || /\s/.test(text[close - 1]!)) continue;
    return { inner: text.slice(start, close), marks, end: close + delimiter.length };
  }
  return null;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = '';
  let i = 0;
  while (i < text.length) {
    const m = matchEmphasis(text, i);
    if (!m) {
      plain += text[i++];
      continue;
    }
    if (plain) out.push({ type: 'text', text: plain });
    plain = '';
    out.push({ type: 'text', text: m.inner, marks: m.marks });
    i = m.end;
  }
  if (plain) out.push({ type: 'text', text: plain });
  return out;
}

export function serializeInline(content: Inline[] = []): string {
  return content
    .map((n) => {
      // C3에는 문단 안 줄바꿈이 없다. 저장하면 다음 줄(다음 문단)이 된다
      if (n.type === 'hardBreak') return '\n';
      const types = new Set((n.marks ?? []).map((m) => m.type));
      const delimiter = types.has('bold') ? (types.has('italic') ? '***' : '**') : types.has('italic') ? '*' : '';
      if (!delimiter) return n.text;
      // 공백을 구분자 밖으로 빼야 다시 읽을 때 강조로 인식된다
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(n.text)!;
      return core ? `${lead}${delimiter}${core}${delimiter}${trail}` : n.text;
    })
    .join('');
}

const paragraph = (text: string): Paragraph => {
  const content = parseInline(text);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
};
const isQuoteLine = (line: string) => line === '>' || line.startsWith('> ');

export function parseC3(body: string): Doc {
  const lines = body.split('\n');
  const content: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isQuoteLine(line)) {
      const quote: Block[] = [];
      for (; i < lines.length && isQuoteLine(lines[i]!); i++) quote.push(paragraph(lines[i]!.slice(2)));
      i--;
      content.push({ type: 'blockquote', content: quote });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const inline = parseInline(heading[2]!);
      content.push({ type: 'heading', attrs: { level: heading[1]!.length }, ...(inline.length ? { content: inline } : {}) });
    } else if (line === '---') {
      content.push({ type: 'horizontalRule' });
    } else {
      content.push(paragraph(line));
    }
  }
  return { type: 'doc', content };
}

function serializeBlock(block: Block): string[] {
  switch (block.type) {
    case 'heading':
      return [`${'#'.repeat(block.attrs.level)} ${serializeInline(block.content)}`];
    case 'horizontalRule':
      return ['---'];
    case 'blockquote':
      return (block.content ?? [])
        .flatMap(serializeBlock)
        .flatMap((line) => line.split('\n'))
        .map((line) => (line ? `> ${line}` : '>'));
    case 'paragraph':
      return [serializeInline(block.content)];
  }
}

export function serializeC3(doc: Doc): string {
  return (doc.content ?? []).flatMap(serializeBlock).join('\n');
}
