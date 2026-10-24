// Deterministic evaluator. No LLM involved.
//
// A finding in chapter N matches a ground-truth error when its target_quote overlaps
// the error's target span in chapter N. Everything else is classified as
//   duplicate  – a second finding on an already matched error (not FP)
//   trap       – overlaps a legitimate change (FP, also counted as a trap false alarm)
//   echo       – every evidence quote points at an inserted error span (excluded, see error-plan.md)
//   fabricated – target_quote does not exist in the chapter (FP)
//   unlabeled  – real text, no label (FP until reviewed; goes to the review queue)
//
// Split metrics: FPs cannot be attributed to a split, so every split counts all FPs
// (conservative). Matches on errors of other splits are ignored, neither TP nor FP.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadChapters, loadGroundTruth } from './benchmark.ts';
import type { Finding, GroundTruth, GroundTruthError, Predictions, Split } from './schema.ts';

export interface Span {
  start: number;
  end: number;
}

export function normalize(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Finds a quote in text, tolerating whitespace/quote-mark differences and "…" elisions. */
export function locate(text: string, quote: string): Span | null {
  const t = normalize(text);
  const q = normalize(quote);
  if (!q) return null;
  const i = t.indexOf(q);
  if (i >= 0) return { start: i, end: i + q.length };

  const parts = q.split(/\s*(?:…|\.{3,})\s*/).filter(Boolean);
  if (parts.length < 2) return null;
  let from = 0;
  let start = -1;
  for (const p of parts) {
    const j = t.indexOf(p, from);
    if (j < 0) return null;
    if (start < 0) start = j;
    from = j + p.length;
  }
  return { start, end: from };
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

export type Label = 'tp' | 'duplicate' | 'trap' | 'echo' | 'fabricated' | 'unlabeled';
const FP_LABELS: ReadonlySet<Label> = new Set(['trap', 'fabricated', 'unlabeled']);

export interface LabeledFinding {
  target_chapter: number;
  finding: Finding;
  label: Label;
  error_id?: string;
  trap_id?: string;
  target_found: boolean;
  evidence_found: boolean[];
}

interface Counts {
  total: number;
  tp: number;
  fp: number;
  recall: number;
  precision: number | null;
  fp_per_chapter: number;
}

interface Bucket {
  total: number;
  tp: number;
  recall: number;
}

type SplitKey = 'all' | Split;
const SPLITS: SplitKey[] = ['all', 'dev', 'test'];
const inSplit = (s: SplitKey, x: { split: Split }) => s === 'all' || x.split === s;

export const THRESHOLDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

export interface EvalReport {
  run_id: string;
  strategy: string;
  model: string;
  n_chapters: number;
  by_threshold: ({ threshold: number } & Record<SplitKey, Counts>)[];
  /** Everything below is at threshold 0 (all findings). */
  findings: LabeledFinding[];
  missed: Record<SplitKey, string[]>;
  breakdown: Record<'all' | 'test', Record<'category' | 'distance' | 'explicitness', Record<string, Bucket>>>;
  quotes: { total: number; found: number; existence_rate: number | null };
  evidence: { tp: number; chapter_accuracy: number | null; quote_accuracy: number | null };
  category_agreement: number | null;
  traps: Record<SplitKey, { total: number; hit: number; rate: number }> & { hit_ids: string[] };
  echo_count: number;
  duplicate_count: number;
  retrieval: {
    per_error: Record<string, boolean>;
    known: number;
    retrieved: number;
    retrieval_recall: number | null;
    judge_recall: number | null;
  };
  review_queue: LabeledFinding[];
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
const distanceBucket = (d: number) => (d <= 2 ? 'near' : d <= 4 ? 'mid' : 'far');

export function evaluate(preds: Predictions, gt: GroundTruth, chapters: Map<number, string>): EvalReport {
  const spanIn = (ch: number, q: string) => {
    const text = chapters.get(ch);
    return text === undefined ? null : locate(text, q);
  };
  const spansOf = (ch: number, qs: string[]) => qs.map((q) => spanIn(ch, q)).filter((s): s is Span => s !== null);

  const errorTargets = new Map(gt.errors.map((e) => [e.id, spansOf(e.target.chapter, e.target.quotes)]));
  const trapSpans = new Map(gt.traps.map((t) => [t.id, spansOf(t.chapter, t.quotes)]));
  const errorById = new Map(gt.errors.map((e) => [e.id, e]));

  function classify(threshold: number): LabeledFinding[] {
    const out: LabeledFinding[] = [];
    const matched = new Set<string>();
    for (const cp of preds.chapters) {
      const ch = cp.target_chapter;
      const fs = cp.findings.filter((f) => f.confidence >= threshold).sort((a, b) => b.confidence - a.confidence);
      for (const f of fs) {
        const span = spanIn(ch, f.target_quote);
        const evSpans = f.evidence.map((ev) => spanIn(ev.chapter, ev.quote));
        const base = { target_chapter: ch, finding: f, target_found: span !== null, evidence_found: evSpans.map((s) => s !== null) };
        if (!span) {
          out.push({ ...base, label: 'fabricated' });
          continue;
        }
        const err = gt.errors.find((e) => e.target.chapter === ch && errorTargets.get(e.id)!.some((s) => overlaps(s, span)));
        if (err) {
          out.push({ ...base, label: matched.has(err.id) ? 'duplicate' : 'tp', error_id: err.id });
          matched.add(err.id);
          continue;
        }
        const trap = gt.traps.find((t) => t.chapter === ch && trapSpans.get(t.id)!.some((s) => overlaps(s, span)));
        if (trap) {
          out.push({ ...base, label: 'trap', trap_id: trap.id });
          continue;
        }
        const isEcho =
          f.evidence.length > 0 &&
          f.evidence.every((ev, i) => {
            const s = evSpans[i];
            return s !== null && gt.errors.some((e) => e.target.chapter === ev.chapter && errorTargets.get(e.id)!.some((t) => overlaps(t, s)));
          });
        out.push({ ...base, label: isEcho ? 'echo' : 'unlabeled' });
      }
    }
    return out;
  }

  const nChapters = preds.chapters.length;
  function counts(labeled: LabeledFinding[], split: SplitKey): Counts {
    const total = gt.errors.filter((e) => inSplit(split, e)).length;
    const tp = labeled.filter((l) => l.label === 'tp' && inSplit(split, errorById.get(l.error_id!)!)).length;
    const fp = labeled.filter((l) => FP_LABELS.has(l.label)).length;
    return { total, tp, fp, recall: tp / total, precision: ratio(tp, tp + fp), fp_per_chapter: nChapters ? fp / nChapters : 0 };
  }

  const by_threshold = THRESHOLDS.map((threshold) => {
    const labeled = classify(threshold);
    return { threshold, all: counts(labeled, 'all'), dev: counts(labeled, 'dev'), test: counts(labeled, 'test') };
  });

  const findings = classify(0);
  const tps = findings.filter((l) => l.label === 'tp');
  const tpIds = new Set(tps.map((l) => l.error_id!));

  const missed = Object.fromEntries(
    SPLITS.map((s) => [s, gt.errors.filter((e) => inSplit(s, e) && !tpIds.has(e.id)).map((e) => e.id)]),
  ) as Record<SplitKey, string[]>;

  function breakdownFor(split: SplitKey) {
    const keys: Record<'category' | 'distance' | 'explicitness', (e: GroundTruthError) => string> = {
      category: (e) => e.category,
      distance: (e) => distanceBucket(e.distance),
      explicitness: (e) => e.explicitness,
    };
    const res = {} as Record<'category' | 'distance' | 'explicitness', Record<string, Bucket>>;
    for (const [dim, key] of Object.entries(keys) as [keyof typeof keys, (e: GroundTruthError) => string][]) {
      const buckets: Record<string, Bucket> = {};
      for (const e of gt.errors.filter((x) => inSplit(split, x))) {
        const b = (buckets[key(e)] ??= { total: 0, tp: 0, recall: 0 });
        b.total++;
        if (tpIds.has(e.id)) b.tp++;
      }
      for (const b of Object.values(buckets)) b.recall = b.tp / b.total;
      res[dim] = buckets;
    }
    return res;
  }

  let quoteTotal = 0;
  let quoteFound = 0;
  for (const l of findings) {
    quoteTotal += 1 + l.evidence_found.length;
    quoteFound += (l.target_found ? 1 : 0) + l.evidence_found.filter(Boolean).length;
  }

  let evChapterOk = 0;
  let evQuoteOk = 0;
  let catOk = 0;
  for (const l of tps) {
    const e = errorById.get(l.error_id!)!;
    const srcChapters = new Set(e.sources.map((s) => s.chapter));
    if (l.finding.evidence.some((ev) => srcChapters.has(ev.chapter))) evChapterOk++;
    const srcSpans = e.sources.map((s) => ({ ch: s.chapter, spans: spansOf(s.chapter, s.quotes) }));
    const quoteOk = l.finding.evidence.some((ev) => {
      const s = spanIn(ev.chapter, ev.quote);
      return s !== null && srcSpans.some((x) => x.ch === ev.chapter && x.spans.some((t) => overlaps(t, s)));
    });
    if (quoteOk) evQuoteOk++;
    if (l.finding.category === e.category) catOk++;
  }

  const hitTraps = new Set(findings.filter((l) => l.label === 'trap').map((l) => l.trap_id!));
  const trapCounts = (s: SplitKey) => {
    const ts = gt.traps.filter((t) => inSplit(s, t));
    const hit = ts.filter((t) => hitTraps.has(t.id)).length;
    return { total: ts.length, hit, rate: hit / ts.length };
  };
  const traps = { all: trapCounts('all'), dev: trapCounts('dev'), test: trapCounts('test'), hit_ids: [...hitTraps].sort() };

  // Retrieval: did any source quote of the error appear in what the model saw?
  const per_error: Record<string, boolean> = {};
  for (const e of gt.errors) {
    const cp = preds.chapters.find((c) => c.target_chapter === e.target.chapter);
    if (!cp?.context) continue;
    per_error[e.id] = e.sources.some((s) =>
      s.quotes.some((q) => cp.context!.some((piece) => piece.chapter === s.chapter && locate(piece.text, q) !== null)),
    );
  }
  const known = Object.keys(per_error).length;
  const retrievedIds = Object.keys(per_error).filter((id) => per_error[id]);
  const judged = retrievedIds.filter((id) => tpIds.has(id)).length;

  return {
    run_id: preds.run_id,
    strategy: preds.strategy,
    model: preds.model,
    n_chapters: nChapters,
    by_threshold,
    findings,
    missed,
    breakdown: { all: breakdownFor('all'), test: breakdownFor('test') },
    quotes: { total: quoteTotal, found: quoteFound, existence_rate: ratio(quoteFound, quoteTotal) },
    evidence: { tp: tps.length, chapter_accuracy: ratio(evChapterOk, tps.length), quote_accuracy: ratio(evQuoteOk, tps.length) },
    category_agreement: ratio(catOk, tps.length),
    traps,
    echo_count: findings.filter((l) => l.label === 'echo').length,
    duplicate_count: findings.filter((l) => l.label === 'duplicate').length,
    retrieval: {
      per_error,
      known,
      retrieved: retrievedIds.length,
      retrieval_recall: ratio(retrievedIds.length, known),
      judge_recall: ratio(judged, retrievedIds.length),
    },
    review_queue: findings.filter((l) => l.label === 'unlabeled' || l.label === 'fabricated'),
  };
}

// ---- CLI: tsx src/evaluate.ts results/<run-id> ----

const pct = (x: number | null) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);

function reviewQueueMarkdown(r: EvalReport): string {
  const lines = [`# 검수 큐: ${r.run_id}`, '', '라벨 밖 발견물. ground truth에 편입하거나 FP로 확정한다.', ''];
  for (const l of r.review_queue) {
    lines.push(`## ${l.target_chapter}화 · ${l.label} · ${l.finding.category} · conf ${l.finding.confidence}`);
    lines.push(`- target${l.target_found ? '' : ' (원문에 없음)'}: "${l.finding.target_quote}"`);
    lines.push(`- claim: ${l.finding.claim}`);
    l.finding.evidence.forEach((ev, i) =>
      lines.push(`- evidence ${ev.chapter}화${l.evidence_found[i] ? '' : ' (원문에 없음)'}: "${ev.quote}"`),
    );
    lines.push('');
  }
  return lines.join('\n');
}

function main(dir: string) {
  const preds = JSON.parse(readFileSync(join(dir, 'predictions.json'), 'utf8')) as Predictions;
  const r = evaluate(preds, loadGroundTruth(), loadChapters());
  writeFileSync(join(dir, 'metrics.json'), JSON.stringify(r, null, 2) + '\n');
  writeFileSync(join(dir, 'review-queue.md'), reviewQueueMarkdown(r));

  const t0 = r.by_threshold[0];
  console.log(`${r.run_id}  strategy=${r.strategy}  model=${r.model}  chapters=${r.n_chapters}`);
  for (const s of SPLITS) {
    const c = t0[s];
    console.log(`  ${s.padEnd(4)} recall ${pct(c.recall)} (${c.tp}/${c.total})  precision ${pct(c.precision)}  FP/ch ${c.fp_per_chapter.toFixed(2)}`);
  }
  console.log(`  quotes ${pct(r.quotes.existence_rate)}  evidence-ch ${pct(r.evidence.chapter_accuracy)}  trap(test) ${pct(r.traps.test.rate)}  echo ${r.echo_count}  review ${r.review_queue.length}`);
  console.log(`  retrieval ${pct(r.retrieval.retrieval_recall)}  judge ${pct(r.retrieval.judge_recall)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: tsx src/evaluate.ts results/<run-id>');
    process.exit(1);
  }
  main(dir);
}
