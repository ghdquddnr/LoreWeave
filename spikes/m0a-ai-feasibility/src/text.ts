import type { ContextPiece } from './schema.ts';

export interface Paragraph {
  chapter: number;
  index: number;
  text: string;
}

/** Body paragraphs (blank-line separated), without the "# N화" title line. */
export function paragraphs(chapter: number, text: string): Paragraph[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('#'))
    .map((p, index) => ({ chapter, index, text: p }));
}

export const chapterBlock = (n: number, text: string) => `<chapter n="${n}">\n${text.trim()}\n</chapter>`;

/** Excerpts grouped by chapter, in chapter then paragraph order. */
export function excerptBlocks(ps: Paragraph[]): string {
  const sorted = [...ps].sort((a, b) => a.chapter - b.chapter || a.index - b.index);
  const byCh = new Map<number, string[]>();
  for (const p of sorted) byCh.set(p.chapter, [...(byCh.get(p.chapter) ?? []), p.text]);
  return [...byCh].map(([n, texts]) => `<excerpt chapter="${n}">\n${texts.join('\n\n')}\n</excerpt>`).join('\n\n');
}

export const toContext = (ps: Paragraph[]): ContextPiece[] => ps.map((p) => ({ chapter: p.chapter, text: p.text }));
