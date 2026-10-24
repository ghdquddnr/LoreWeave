// 에디터 밖에서 처리하는 부분: BOM, 줄바꿈, frontmatter, 마지막 개행.
// 변환기는 LF로 정규화된 본문만 받는다. join(split(x))는 혼합 줄바꿈이 아니면 x와 같다.

export type Eol = '\n' | '\r\n' | 'mixed';

export interface Envelope {
  bom: boolean;
  eol: Eol;
  /** LF로 정규화한 frontmatter 원문 (구분선과 닫는 줄의 개행 포함) */
  frontmatter: string | null;
  finalNewline: boolean;
}

const BOM = '﻿';
// 공백 없는 키 + 콜론. "그가 말했다: ..." 같은 본문 문장은 키로 보지 않는다.
const FM_KEY = /^[^\s#:-][^\s:]*:(?:\s.*)?$/;
// 키, 주석, 들여쓴 값, 목록, 빈 줄
const FM_LINE = /^(?:[^\s#:-][^\s:]*:(?:\s.*)?|#.*|\s+.*|-\s.*|)$/;

export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  if (cr > 0 || (crlf > 0 && lf > 0)) return 'mixed';
  return crlf > 0 ? '\r\n' : '\n';
}

function matchFrontmatter(text: string): string | null {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] !== '---') continue;
    const inner = lines.slice(1, i);
    if (!inner.some((l) => FM_KEY.test(l)) || !inner.every((l) => FM_LINE.test(l))) return null;
    return lines.slice(0, i + 1).join('\n') + (i + 1 < lines.length ? '\n' : '');
  }
  return null;
}

export function split(raw: string): { envelope: Envelope; body: string } {
  let text = raw;
  const bom = text.startsWith(BOM);
  if (bom) text = text.slice(1);
  const eol = detectEol(text);
  text = text.replace(/\r\n?/g, '\n');
  const frontmatter = matchFrontmatter(text);
  if (frontmatter !== null) text = text.slice(frontmatter.length);
  const finalNewline = text.endsWith('\n');
  if (finalNewline) text = text.slice(0, -1);
  return { envelope: { bom, eol, frontmatter, finalNewline }, body: text };
}

/** 혼합 줄바꿈은 LF로 저장된다 (문서화된 예외). */
export function join(env: Envelope, body: string): string {
  let text = (env.frontmatter ?? '') + body + (env.finalNewline ? '\n' : '');
  if (env.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  return (env.bom ? BOM : '') + text;
}
