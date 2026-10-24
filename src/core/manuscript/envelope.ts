// 원고 파일 중 에디터에 넣지 않는 부분: BOM, 줄바꿈 방식, frontmatter, 마지막 개행 (ADR 0002 결정 4).
// joinEnvelope(splitEnvelope(x))는 줄바꿈이 섞이지 않은 모든 x에 대해 x와 같다.

export type LineEnding = '\n' | '\r\n' | 'mixed';

export interface Envelope {
  bom: boolean;
  lineEnding: LineEnding;
  /** LF로 맞춘 frontmatter 원문 (여는·닫는 `---`와 닫는 줄의 개행 포함) */
  frontmatter: string | null;
  finalNewline: boolean;
}

const BOM = '\uFEFF';
// 공백 없는 키 + 콜론. "그가 말했다: …" 같은 본문 문장은 키로 보지 않는다
const FRONTMATTER_KEY = /^[^\s#:-][^\s:]*:(?:\s.*)?$/;
// 키, 주석, 들여쓴 값, 목록 항목, 빈 줄
const FRONTMATTER_LINE = /^(?:[^\s#:-][^\s:]*:(?:\s.*)?|#.*|\s+.*|-\s.*|)$/;

export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  if (cr > 0 || (crlf > 0 && lf > 0)) return 'mixed';
  return crlf > 0 ? '\r\n' : '\n';
}

/** 첫 줄이 `---`이고, 다음 `---` 줄까지가 모두 frontmatter 형식이며 키가 하나 이상일 때만 frontmatter로 본다. */
function matchFrontmatter(text: string): string | null {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  const close = lines.indexOf('---', 1);
  if (close === -1) return null;
  const inner = lines.slice(1, close);
  if (!inner.some((l) => FRONTMATTER_KEY.test(l)) || !inner.every((l) => FRONTMATTER_LINE.test(l))) return null;
  return lines.slice(0, close + 1).join('\n') + (close + 1 < lines.length ? '\n' : '');
}

export function splitEnvelope(raw: string): { envelope: Envelope; body: string } {
  let text = raw;
  const bom = text.startsWith(BOM);
  if (bom) text = text.slice(1);
  const lineEnding = detectLineEnding(text);
  text = text.replace(/\r\n?/g, '\n');
  const frontmatter = matchFrontmatter(text);
  if (frontmatter !== null) text = text.slice(frontmatter.length);
  const finalNewline = text.endsWith('\n');
  if (finalNewline) text = text.slice(0, -1);
  return { envelope: { bom, lineEnding, frontmatter, finalNewline }, body: text };
}

/** 줄바꿈이 섞인 파일은 LF로 저장된다 (ADR 0002 남은 질문). */
export function joinEnvelope(envelope: Envelope, body: string): string {
  let text = (envelope.frontmatter ?? '') + body + (envelope.finalNewline ? '\n' : '');
  if (envelope.lineEnding === '\r\n') text = text.replace(/\n/g, '\r\n');
  return (envelope.bom ? BOM : '') + text;
}
