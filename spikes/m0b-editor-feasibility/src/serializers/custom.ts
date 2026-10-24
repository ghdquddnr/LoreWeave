// (c) 직접 작성한 최소 변환기. 규약 C3(한 줄 = 한 문단, 빈 줄 = 빈 문단) 전용.
// 알아보는 문법만 노드로 바꾸고 나머지는 글자 그대로 둔다. 이스케이프는 하지 않는다.
//   - 줄 전체: `# ` ~ `###### ` 제목, 정확히 `---` 구분선, `> ` 또는 `>`로 시작하는 연속 줄은 인용
//   - 줄 안: `***x***` 굵게+기울임, `**x**` 굵게, `*x*` 기울임 (안쪽에 `*` 없음, 안쪽 앞뒤 공백 없음)
// 알려진 한계: 부분적으로 겹친 강조는 쓸 수 없다. 에디터에서 입력한 `*`가 다시 열 때 강조로 읽힐 수 있다.

import type { Converter, PMMark, PMNode } from '../roundtrip.ts';

const HEADING = /^(#{1,6}) (.*)$/;
const DELIMITERS: [string, PMMark[]][] = [
  ['***', [{ type: 'bold' }, { type: 'italic' }]],
  ['**', [{ type: 'bold' }]],
  ['*', [{ type: 'italic' }]],
];

function matchEmphasis(text: string, i: number): { inner: string; marks: PMMark[]; end: number } | null {
  for (const [d, marks] of DELIMITERS) {
    if (!text.startsWith(d, i)) continue;
    const start = i + d.length;
    const first = text[start];
    if (first === undefined || /[\s*]/.test(first)) continue;
    const close = text.indexOf('*', start);
    if (close === -1 || !text.startsWith(d, close) || /\s/.test(text[close - 1]!)) continue;
    return { inner: text.slice(start, close), marks, end: close + d.length };
  }
  return null;
}

export function parseInline(text: string): PMNode[] {
  const out: PMNode[] = [];
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

export function serializeInline(nodes: PMNode[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '\n';
      const text = n.text ?? '';
      const types = new Set((n.marks ?? []).map((m) => m.type));
      const d = types.has('bold') ? (types.has('italic') ? '***' : '**') : types.has('italic') ? '*' : '';
      if (!d) return text;
      // 공백을 구분자 밖으로 빼야 다시 읽을 때 강조로 인식된다
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
      return core ? `${lead}${d}${core}${d}${trail}` : text;
    })
    .join('');
}

const paragraph = (text: string): PMNode => ({ type: 'paragraph', content: parseInline(text) });
const isQuoteLine = (line: string) => line === '>' || line.startsWith('> ');

export function customConverter(): Converter {
  return {
    name: 'custom',
    parse(body) {
      const lines = body.split('\n');
      const content: PMNode[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (isQuoteLine(line)) {
          const quote: PMNode[] = [];
          for (; i < lines.length && isQuoteLine(lines[i]!); i++) quote.push(paragraph(lines[i]!.slice(2)));
          i--;
          content.push({ type: 'blockquote', content: quote });
          continue;
        }
        const h = HEADING.exec(line);
        if (h) content.push({ type: 'heading', attrs: { level: h[1]!.length }, content: parseInline(h[2]!) });
        else if (line === '---') content.push({ type: 'horizontalRule' });
        else content.push(paragraph(line));
      }
      return { type: 'doc', content };
    },
    serialize(doc) {
      return (doc.content ?? [])
        .flatMap((block) => {
          switch (block.type) {
            case 'heading':
              return [`${'#'.repeat(Number(block.attrs?.level ?? 1))} ${serializeInline(block.content)}`];
            case 'horizontalRule':
              return ['---'];
            case 'blockquote':
              return (block.content ?? []).map((p) => {
                const text = serializeInline(p.content).replace(/\n/g, '\n> ');
                return text ? `> ${text}` : '>';
              });
            default:
              return [serializeInline(block.content)];
          }
        })
        .join('\n');
    },
  };
}
