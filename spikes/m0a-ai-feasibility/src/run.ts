// Runs one strategy over target chapters 2..15 and evaluates it.
//   pnpm run:strategy --strategy full-context --model gpt-6-luna --reasoning low [--repeat 0] [--retrieval-only]
// Output: results/<run-id>/{config,predictions,usage,metrics}.json + review-queue.md

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { ReasoningEffort } from 'openai/resources/shared';
import { CHAPTER_COUNT, loadChapters } from './benchmark.ts';
import { MODELS, spentUsd, type Model, type Usage } from './llm.ts';
import { DETECT_SYSTEM } from './prompts/detect.ts';
import { EXTRACT_SYSTEM } from './prompts/extract.ts';
import type { ChapterPrediction, Predictions } from './schema.ts';
import { fullContext, targetOnly } from './strategies/baselines.ts';
import type { RunCtx, Strategy } from './strategies/common.ts';
import { entityStrategy, factsStrategy, summaryStrategy } from './strategies/facts.ts';
import { searchPrior, searchStrategy } from './strategies/search.ts';
import { toContext } from './text.ts';

const STRATEGIES: Record<string, Strategy> = {
  'full-context': fullContext,
  'target-only': targetOnly,
  'a-search': searchStrategy,
  'b-facts': factsStrategy,
  'c-summary': summaryStrategy,
  'd-entity': entityStrategy,
};

// Context selection that needs no LLM call, for --retrieval-only (free retrieval-recall check).
const RETRIEVAL_ONLY: Record<string, (chapters: Map<number, string>, target: number) => ChapterPrediction> = {
  'a-search': (chapters, target) => ({ target_chapter: target, context: toContext(searchPrior(chapters, target)), findings: [] }),
};

const { values: args } = parseArgs({
  options: {
    strategy: { type: 'string' },
    model: { type: 'string' },
    reasoning: { type: 'string' },
    repeat: { type: 'string', default: '0' },
    concurrency: { type: 'string', default: '4' },
    'retrieval-only': { type: 'boolean', default: false },
  },
});

const strategy = args.strategy!;
if (!STRATEGIES[strategy]) throw new Error(`--strategy must be one of ${Object.keys(STRATEGIES).join(', ')}`);
const model = args.model as Model;
if (!MODELS.includes(model)) throw new Error(`--model must be one of ${MODELS.join(', ')}`);
const reasoning = args.reasoning as ReasoningEffort | undefined;
const repeat = Number(args.repeat);

const chapters = loadChapters();
const targets = Array.from({ length: CHAPTER_COUNT - 1 }, (_, i) => i + 2);
const ctx: RunCtx = { strategy, chapters, model, reasoning, repeat, usage: [], extractions: new Map() };

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const retrievalOnly = args['retrieval-only'];
const runId = retrievalOnly ? `${strategy}__retrieval` : `${strategy}__${model}__${reasoning ?? 'default'}__r${repeat}`;
const spentBefore = spentUsd();
const t0 = performance.now();

let results: ChapterPrediction[];
if (retrievalOnly) {
  const sel = RETRIEVAL_ONLY[strategy];
  if (!sel) throw new Error(`--retrieval-only supports: ${Object.keys(RETRIEVAL_ONLY).join(', ')}`);
  results = targets.map((t) => sel(chapters, t));
} else {
  results = await pool(targets, Number(args.concurrency), (t) => STRATEGIES[strategy](t, ctx));
}

const dir = join(import.meta.dirname, '..', 'results', runId);
mkdirSync(dir, { recursive: true });

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const predictions: Predictions = { run_id: runId, strategy, model: retrievalOnly ? 'none' : model, chapters: results };

function summarize(us: Usage[]) {
  const sum = (k: keyof Usage) => us.reduce((a, u) => a + (u[k] as number), 0);
  return {
    calls: us.length,
    cache_hits: us.filter((u) => u.cache_hit).length,
    input_tokens: sum('input_tokens'),
    cached_tokens: sum('cached_tokens'),
    output_tokens: sum('output_tokens'),
    reasoning_tokens: sum('reasoning_tokens'),
    cost_usd: sum('cost_usd'),
    latency_ms_mean: us.length ? Math.round(sum('latency_ms') / us.length) : 0,
  };
}

const usage = {
  total: summarize(ctx.usage),
  detect: summarize(ctx.usage.filter((u) => u.tag.includes('/detect/'))),
  extract: summarize(ctx.usage.filter((u) => u.tag.includes('/extract/'))),
  cost_per_chapter_usd: summarize(ctx.usage).cost_usd / targets.length,
  wall_ms: Math.round(performance.now() - t0),
  calls: ctx.usage,
};

const config = {
  run_id: runId,
  strategy,
  model,
  model_versions: [...new Set(ctx.usage.map((u) => u.model_version))],
  reasoning: reasoning ?? null,
  repeat,
  retrieval_only: retrievalOnly,
  prompt_hashes: { detect: hash(DETECT_SYSTEM), extract: hash(EXTRACT_SYSTEM) },
  git_commit: execSync('git rev-parse --short HEAD').toString().trim(),
  created_at: new Date().toISOString(),
};

writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
writeFileSync(join(dir, 'predictions.json'), JSON.stringify(predictions, null, 2) + '\n');
writeFileSync(join(dir, 'usage.json'), JSON.stringify(usage, null, 2) + '\n');

console.log(`cost this run $${usage.total.cost_usd.toFixed(4)}  (ledger $${spentBefore.toFixed(4)} → $${spentUsd().toFixed(4)})`);
execSync(`node --import tsx src/evaluate.ts "${dir}"`, { stdio: 'inherit', cwd: join(import.meta.dirname, '..') });
