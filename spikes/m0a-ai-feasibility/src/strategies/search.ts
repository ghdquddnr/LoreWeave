// Strategy A: paragraph-level SQLite FTS5 (trigram) search over earlier chapters.
// Also checks how far trigram gets with Korean: terms shorter than 3 chars (most names) are unsearchable.

import { DatabaseSync } from 'node:sqlite';
import { excerptBlocks, paragraphs, toContext, type Paragraph } from '../text.ts';
import { judge, type RunCtx, type Strategy } from './common.ts';

export const PER_PARAGRAPH = 3;
export const MAX_PARAGRAPHS = 40;

const JOSA = ['에서는', '에게서', '으로는', '이라고', '라고', '에서', '에게', '한테', '으로', '부터', '까지', '처럼', '보다', '이나', '이다', '였다',
  '은', '는', '이', '가', '을', '를', '의', '에', '와', '과', '도', '로', '만', '께'];

/** Search terms for trigram FTS: eojeol and josa-stripped stem, ≥ 3 chars. */
export function terms(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    const w = raw.replace(/[^\p{L}\p{N}]/gu, '');
    if (w.length >= 3) out.add(w);
    const j = JOSA.find((s) => w.endsWith(s) && w.length - s.length >= 2);
    if (j) {
      const stem = w.slice(0, -j.length);
      if (stem.length >= 3) out.add(stem);
    }
  }
  return [...out];
}

class Index {
  private db = new DatabaseSync(':memory:');
  private rows: Paragraph[] = [];
  constructor(chapters: Map<number, string>) {
    this.db.exec("CREATE VIRTUAL TABLE p USING fts5(text, chapter UNINDEXED, tokenize='trigram')");
    const ins = this.db.prepare('INSERT INTO p(rowid, text, chapter) VALUES (?, ?, ?)');
    for (const [n, text] of chapters) {
      for (const para of paragraphs(n, text)) {
        this.rows.push(para);
        ins.run(this.rows.length, para.text, n);
      }
    }
  }
  search(query: string, beforeChapter: number, k: number): Paragraph[] {
    const res = this.db
      .prepare('SELECT rowid FROM p WHERE p MATCH ? AND chapter < ? ORDER BY bm25(p) LIMIT ?')
      .all(query, beforeChapter, k) as { rowid: number }[];
    return res.map((r) => this.rows[r.rowid - 1]);
  }
}

const indexes = new WeakMap<Map<number, string>, Index>();

/** Top paragraphs from earlier chapters, round-robin over target paragraphs. */
export function searchPrior(chapters: Map<number, string>, target: number): Paragraph[] {
  let index = indexes.get(chapters);
  if (!index) indexes.set(chapters, (index = new Index(chapters)));

  const perPara = paragraphs(target, chapters.get(target)!).map((p) => {
    const ts = terms(p.text);
    if (!ts.length) return [];
    const q = ts.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    return index.search(q, target, PER_PARAGRAPH);
  });

  const picked = new Map<string, Paragraph>();
  for (let rank = 0; rank < PER_PARAGRAPH && picked.size < MAX_PARAGRAPHS; rank++) {
    for (const hits of perPara) {
      const p = hits[rank];
      if (p && picked.size < MAX_PARAGRAPHS) picked.set(`${p.chapter}:${p.index}`, p);
    }
  }
  return [...picked.values()];
}

export const searchStrategy: Strategy = (target, ctx: RunCtx) => {
  const ps = searchPrior(ctx.chapters, target);
  return judge(ctx, target, excerptBlocks(ps), toContext(ps));
};
