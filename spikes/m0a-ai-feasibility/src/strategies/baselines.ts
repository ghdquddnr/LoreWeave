import { chapterBlock } from '../text.ts';
import { judge, priorChapters, type Strategy } from './common.ts';

/** Ceiling: every earlier chapter in full. */
export const fullContext: Strategy = (target, ctx) => {
  const prior = priorChapters(target);
  const reference = prior.map((n) => chapterBlock(n, ctx.chapters.get(n)!)).join('\n\n');
  return judge(ctx, target, reference, prior.map((n) => ({ chapter: n, text: ctx.chapters.get(n)! })));
};

/** Floor: no earlier chapters. Anything reported here is unsupported by evidence. */
export const targetOnly: Strategy = (target, ctx) => judge(ctx, target, '', []);
