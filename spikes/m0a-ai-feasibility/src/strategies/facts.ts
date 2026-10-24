// Strategies B, C, D: built on the per-chapter extraction (summary + entities + facts).

import type { ContextPiece } from '../schema.ts';
import { excerptBlocks, paragraphs, toContext, type Paragraph } from '../text.ts';
import { entityNames, extract, judge, priorChapters, sameEntity, type RunCtx, type Strategy } from './common.ts';
import { MAX_PARAGRAPHS, searchPrior } from './search.ts';

interface PriorFact {
  chapter: number;
  entity: string;
  predicate: string;
  value: string;
  quote: string;
}

/** Earlier facts whose entity (or any alias of it) matches an entity of the target chapter. */
async function candidateFacts(ctx: RunCtx, target: number): Promise<PriorFact[]> {
  const names = entityNames(await extract(ctx, target));
  const out: PriorFact[] = [];
  for (const n of priorChapters(target)) {
    const x = await extract(ctx, n);
    for (const f of x.facts) {
      const rec = x.entities.find((e) => e.name === f.entity);
      const factNames = [f.entity, ...(rec?.aliases ?? [])];
      if (factNames.some((a) => names.some((b) => sameEntity(a, b)))) out.push({ chapter: n, ...f });
    }
  }
  return out;
}

function factBlocks(facts: PriorFact[]): string {
  const byCh = new Map<number, string[]>();
  for (const f of facts) {
    byCh.set(f.chapter, [...(byCh.get(f.chapter) ?? []), `- ${f.entity} | ${f.predicate} | ${f.value} | 원문: "${f.quote}"`]);
  }
  return [...byCh].map(([n, lines]) => `<facts chapter="${n}">\n${lines.join('\n')}\n</facts>`).join('\n\n');
}

const factContext = (facts: PriorFact[]): ContextPiece[] => facts.map((f) => ({ chapter: f.chapter, text: f.quote }));

/** B: structured facts of matching entities, each with its original quote. */
export const factsStrategy: Strategy = async (target, ctx) => {
  const facts = await candidateFacts(ctx, target);
  return judge(ctx, target, factBlocks(facts), factContext(facts));
};

/** C: B + summaries of every earlier chapter + paragraphs from strategy A's search. */
export const summaryStrategy: Strategy = async (target, ctx) => {
  const facts = await candidateFacts(ctx, target);
  const summaries: string[] = [];
  for (const n of priorChapters(target)) summaries.push(`<summary chapter="${n}">${(await extract(ctx, n)).summary}</summary>`);
  const ps = searchPrior(ctx.chapters, target);
  const reference = ['## 이전 화 요약', ...summaries, '', '## 관련 설정', factBlocks(facts), '', '## 관련 원문', excerptBlocks(ps)].join('\n');
  return judge(ctx, target, reference, [...factContext(facts), ...toContext(ps)]);
};

/** D: earlier paragraphs that mention the target's entities, most distinct entities first. */
export async function entityParagraphs(ctx: RunCtx, target: number): Promise<Paragraph[]> {
  const names = entityNames(await extract(ctx, target));
  const scored: { p: Paragraph; score: number }[] = [];
  for (const n of priorChapters(target)) {
    for (const p of paragraphs(n, ctx.chapters.get(n)!)) {
      const score = names.filter((name) => p.text.includes(name)).length;
      if (score > 0) scored.push({ p, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || b.p.chapter - a.p.chapter || a.p.index - b.p.index);
  return scored.slice(0, MAX_PARAGRAPHS).map((s) => s.p);
}

export const entityStrategy: Strategy = async (target, ctx) => {
  const ps = await entityParagraphs(ctx, target);
  return judge(ctx, target, excerptBlocks(ps), toContext(ps));
};

