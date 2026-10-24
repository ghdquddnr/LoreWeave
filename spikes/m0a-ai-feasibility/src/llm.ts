// Thin OpenAI wrapper: Structured Outputs + response cache + spend ledger + budget guard.
// No provider abstraction (single provider in M0-A).

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import type { ReasoningEffort } from 'openai/resources/shared';

const ROOT = join(import.meta.dirname, '..');
const CACHE_DIR = join(ROOT, '.cache');
/** Every real API call, committed so REPORT.md can cite actual spend. */
export const LEDGER = join(ROOT, 'results', 'spend.jsonl');

export const MODELS = ['gpt-6.1-sol', 'gpt-6-luna'] as const;
export type Model = (typeof MODELS)[number];

// USD per 1M tokens, Standard tier, short context (≤272K). Checked 2026-10-24 (docs/DECISIONS.md).
const PRICES: Record<Model, { input: number; cached: number; cacheWrite: number; output: number }> = {
  'gpt-6.1-sol': { input: 2.0, cached: 0.1, cacheWrite: 2.5, output: 10.0 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, cacheWrite: 0.125, output: 0.5 },
};

/** Soft cap below the $10 hard limit set on the OpenAI account. */
export const BUDGET_USD = Number(process.env.M0A_BUDGET_USD ?? 9);

export interface Usage {
  tag: string;
  model: string;
  /** Snapshot reported by the API, for reproducibility. */
  model_version: string;
  input_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  latency_ms: number;
  cache_hit: boolean;
}

export interface CallOptions {
  model: Model;
  system: string;
  user: string;
  schema: { name: string; schema: Record<string, unknown> };
  /** Free-form label for logs, e.g. "full-context/ch07". */
  tag: string;
  reasoning?: ReasoningEffort;
  maxOutputTokens?: number;
  /** Repetition index; part of the cache key so repeated runs make fresh calls. */
  repeat?: number;
}

export class BudgetExceededError extends Error {}

export function spentUsd(): number {
  if (!existsSync(LEDGER)) return 0;
  return readFileSync(LEDGER, 'utf8')
    .split('\n')
    .filter(Boolean)
    .reduce((sum, line) => sum + (JSON.parse(line) as Usage).cost_usd, 0);
}

// cached and cache-write tokens are both part of input_tokens (SDK: "breakdown of the input tokens").
// Upper bound: on 2026-10-24 this gave $4.32 while the dashboard showed $2.97 (REPORT.md).
export function costUsd(model: Model, u: OpenAI.Responses.ResponseUsage): number {
  const p = PRICES[model];
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const written = u.input_tokens_details?.cache_write_tokens ?? 0;
  const plain = u.input_tokens - cached - written;
  return (plain * p.input + cached * p.cached + written * p.cacheWrite + u.output_tokens * p.output) / 1e6;
}

let client: OpenAI | undefined;

export async function callJson<T>(opts: CallOptions): Promise<{ data: T; usage: Usage }> {
  const request = {
    model: opts.model,
    input: [
      { role: 'system' as const, content: opts.system },
      { role: 'user' as const, content: opts.user },
    ],
    text: { format: { type: 'json_schema' as const, name: opts.schema.name, schema: opts.schema.schema, strict: true } },
    ...(opts.reasoning ? { reasoning: { effort: opts.reasoning } } : {}),
    ...(opts.maxOutputTokens ? { max_output_tokens: opts.maxOutputTokens } : {}),
  };
  const key = createHash('sha256')
    .update(JSON.stringify({ request, repeat: opts.repeat ?? 0 }))
    .digest('hex');
  const cacheFile = join(CACHE_DIR, `${key}.json`);

  if (existsSync(cacheFile)) {
    const hit = JSON.parse(readFileSync(cacheFile, 'utf8')) as { output_text: string; usage: Usage };
    return { data: JSON.parse(hit.output_text) as T, usage: { ...hit.usage, tag: opts.tag, cost_usd: 0, cache_hit: true } };
  }

  const spent = spentUsd();
  if (spent >= BUDGET_USD) {
    throw new BudgetExceededError(`budget reached: spent $${spent.toFixed(4)} of $${BUDGET_USD}`);
  }

  client ??= new OpenAI();
  const t0 = performance.now();
  const res = await client.responses.create(request);
  const latency_ms = Math.round(performance.now() - t0);

  const u = res.usage!;
  const usage: Usage = {
    tag: opts.tag,
    model: opts.model,
    model_version: res.model,
    input_tokens: u.input_tokens,
    cached_tokens: u.input_tokens_details?.cached_tokens ?? 0,
    cache_write_tokens: u.input_tokens_details?.cache_write_tokens ?? 0,
    output_tokens: u.output_tokens,
    reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    cost_usd: costUsd(opts.model, u),
    latency_ms,
    cache_hit: false,
  };
  mkdirSync(join(ROOT, 'results'), { recursive: true });
  appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...usage }) + '\n');

  if (res.status !== 'completed') {
    throw new Error(`${opts.tag}: response ${res.status} (${JSON.stringify(res.incomplete_details)})`);
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ request, output_text: res.output_text, usage }));
  return { data: JSON.parse(res.output_text) as T, usage };
}
