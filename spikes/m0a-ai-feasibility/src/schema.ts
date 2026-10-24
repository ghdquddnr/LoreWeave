// Shared types for the M0-A harness.
// Finding is the interface every strategy returns: detect(target, priors) → Finding[].
// Evidence comes first (INTENT §5): a finding without verifiable quotes is worth little.

export const CATEGORIES = [
  'first_meeting',
  'age',
  'occupation',
  'name',
  'dead_character',
  'relationship',
  'date_order',
  'number',
  'location',
  'habit',
] as const;
export type Category = (typeof CATEGORIES)[number];

export type Split = 'dev' | 'test';

export interface Evidence {
  chapter: number;
  quote: string;
}

export interface Finding {
  category: Category;
  /** Verbatim text from the target chapter that is (possibly) inconsistent. */
  target_quote: string;
  /** Why it conflicts, in Korean. */
  claim: string;
  /** Verbatim quotes from earlier chapters that establish the conflicting canon. */
  evidence: Evidence[];
  /** 0..1, auxiliary only. */
  confidence: number;
}

// ---- ground truth (benchmark/ground-truth.json) ----

export interface QuoteSet {
  chapter: number;
  quotes: string[];
}

export interface GroundTruthError {
  id: string;
  category: Category;
  split: Split;
  explicitness: 'L1' | 'L2' | 'L3';
  distance: number;
  target: QuoteSet;
  sources: QuoteSet[];
  description: string;
}

export interface GroundTruthTrap {
  id: string;
  split: Split;
  chapter: number;
  quotes: string[];
  reason: string;
}

export interface GroundTruth {
  version: number;
  notes: string;
  errors: GroundTruthError[];
  traps: GroundTruthTrap[];
}

// ---- run output (results/<run-id>/predictions.json) ----

/** A piece of prior text that the strategy actually put in front of the model. */
export interface ContextPiece {
  chapter: number;
  text: string;
}

export interface ChapterPrediction {
  target_chapter: number;
  /** What the model saw from earlier chapters. Used for retrieval recall. Omit if unknown. */
  context?: ContextPiece[];
  findings: Finding[];
}

export interface Predictions {
  run_id: string;
  strategy: string;
  model: string;
  chapters: ChapterPrediction[];
}
