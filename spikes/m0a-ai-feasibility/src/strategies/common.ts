import type { ReasoningEffort } from 'openai/resources/shared';
import { callJson, type Model, type Usage } from '../llm.ts';
import { DETECT_SCHEMA, DETECT_SYSTEM, detectUser } from '../prompts/detect.ts';
import { EXTRACT_SCHEMA, EXTRACT_SYSTEM, type Extraction } from '../prompts/extract.ts';
import type { ChapterPrediction, ContextPiece, Finding } from '../schema.ts';
import { chapterBlock } from '../text.ts';

export interface RunCtx {
  strategy: string;
  chapters: Map<number, string>;
  model: Model;
  reasoning?: ReasoningEffort;
  repeat: number;
  usage: Usage[];
  /** Per-run memo so concurrent targets share one extraction call per chapter. */
  extractions: Map<number, Promise<Extraction>>;
}

export type Strategy = (target: number, ctx: RunCtx) => Promise<ChapterPrediction>;

const MAX_OUTPUT_TOKENS = 16000;

export async function judge(ctx: RunCtx, target: number, reference: string, context: ContextPiece[]): Promise<ChapterPrediction> {
  const { data, usage } = await callJson<{ findings: Finding[] }>({
    model: ctx.model,
    system: DETECT_SYSTEM,
    user: detectUser(reference, target, ctx.chapters.get(target)!),
    schema: DETECT_SCHEMA,
    tag: `${ctx.strategy}/detect/ch${target}`,
    reasoning: ctx.reasoning,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    repeat: ctx.repeat,
  });
  ctx.usage.push(usage);
  return { target_chapter: target, context, findings: data.findings };
}

export function extract(ctx: RunCtx, chapter: number): Promise<Extraction> {
  let p = ctx.extractions.get(chapter);
  if (!p) {
    p = callJson<Extraction>({
      model: ctx.model,
      system: EXTRACT_SYSTEM,
      user: chapterBlock(chapter, ctx.chapters.get(chapter)!),
      schema: EXTRACT_SCHEMA,
      tag: `${ctx.strategy}/extract/ch${chapter}`,
      reasoning: ctx.reasoning,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      repeat: ctx.repeat,
    }).then(({ data, usage }) => {
      ctx.usage.push(usage);
      return data;
    });
    ctx.extractions.set(chapter, p);
  }
  return p;
}

export const priorChapters = (target: number) => Array.from({ length: target - 1 }, (_, i) => i + 1);

/** All names and aliases of the entities in an extraction (length ≥ 2). */
export function entityNames(x: Extraction): string[] {
  const names = x.entities.flatMap((e) => [e.name, ...e.aliases]).map((s) => s.trim());
  return [...new Set(names.filter((s) => s.length >= 2))];
}

/** Loose match between entity strings, e.g. "민수" ~ "김민수". */
export const sameEntity = (a: string, b: string) => a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a));
