// 사실 고르기 방법의 retrieval을 API 호출 없이 비교한다 (M5 측정 2차).
// measure-scale.ts가 분석해 둔 150화(out/m5-work/base)의 분석 결과로, 원래 화 14개를 검사한다면 넘길 사실(context)을
// 방법마다 만들어 predictions.json(결과는 비움)으로 쓴다. 채점기의 retrieval만 의미가 있다.
//   pnpm tsx scripts/retrieval-scale.ts
//   pnpm --dir spikes/m0a-ai-feasibility evaluate <out/m5-work/retrieval/방법> <out/m5-work/base>

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { candidateFacts, detectionInput, selectFacts, type PriorAnalysis, type PriorFact } from '../src/core/ai/detection.ts';
import { AiStore } from '../src/main/ai-db.ts';
import { chapterLines } from '../src/main/analyzer.ts';
import { chapterFile, ORIGINAL_CHAPTERS, originalPosition, TOTAL_CHAPTERS } from './lib/long-benchmark.ts';

const work = resolve(process.argv[2] ?? 'out/m5-work');
const base = join(work, 'base');

/** 공백·문장부호를 뺀 글자 두 개씩 */
function bigrams(s: string): Set<string> {
  const t = s.normalize('NFC').replace(/[\s\p{P}\p{S}]/gu, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return (2 * n) / (a.size + b.size);
}

const sameName = (a: string, b: string) => a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a));

interface Fact {
  entity: string;
  predicate: string;
  value: string;
}

type Score = (t: Fact, p: Fact) => number;
const byPredicate: Score = (t, p) => dice(bigrams(t.predicate), bigrams(p.predicate));
const byPredicateValue: Score = (t, p) => dice(bigrams(t.predicate), bigrams(p.predicate)) + dice(bigrams(t.value), bigrams(p.value));
const byText: Score = (t, p) => dice(bigrams(`${t.predicate} ${t.value}`), bigrams(`${p.predicate} ${p.value}`));

/** 이 화 사실과 가장 비슷한 앞 화 사실부터 limit개. 같은 점수면 앞 화(처음 정한 설정) 먼저. 화 순서로 돌려준다 */
function relevant(facts: PriorFact[], target: Fact[], score: Score, limit: number): PriorFact[] {
  const scored = facts.map((p, i) => {
    let best = 0;
    for (const t of target) if (sameName(t.entity, p.entity)) best = Math.max(best, score(t, p));
    return { i, best };
  });
  const keep = new Set(
    scored
      .filter((s) => s.best > 0)
      .sort((a, b) => b.best - a.best || a.i - b.i)
      .slice(0, limit)
      .map((s) => s.i),
  );
  return facts.filter((_, i) => keep.has(i));
}

/** 관련 사실 relLimit개 + 남는 자리는 first-latest-recent로 */
function hybrid(facts: PriorFact[], target: Fact[], score: Score, limit: number, relLimit: number): PriorFact[] {
  const rel = new Set(relevant(facts, target, score, relLimit));
  const rest = selectFacts(
    facts.filter((f) => !rel.has(f)),
    'first-latest-recent',
    limit - rel.size,
  );
  const keep = new Set([...rel, ...rest]);
  return facts.filter((f) => keep.has(f));
}

const METHODS: Record<string, (facts: PriorFact[], target: Fact[]) => PriorFact[]> = {
  all: (f) => f,
  recent: (f) => selectFacts(f, 'recent'),
  'first-latest-recent': (f) => selectFacts(f, 'first-latest-recent'),
  'rel-pred-400': (f, t) => relevant(f, t, byPredicate, 400),
  'rel-pv-400': (f, t) => relevant(f, t, byPredicateValue, 400),
  'rel-text-400': (f, t) => relevant(f, t, byText, 400),
  'rel-pv-200': (f, t) => relevant(f, t, byPredicateValue, 200),
  'hybrid-pv-400': (f, t) => hybrid(f, t, byPredicateValue, 400, 250),
  'hybrid-text-400': (f, t) => hybrid(f, t, byText, 400, 250),
};

async function main() {
  const store = AiStore.open(base);
  const analyses = new Map<number, PriorAnalysis & { facts: Fact[] }>();
  for (let n = 1; n <= TOTAL_CHAPTERS; n++) {
    const a = store.analysis(chapterFile(n));
    if (a) analyses.set(n, { chapter: n, entities: a.entities, facts: a.facts });
  }
  store.close();
  const rows: string[] = [];
  for (const [name, method] of Object.entries(METHODS)) {
    const chapters = [];
    let maxFacts = 0;
    let maxChars = 0;
    for (let k = 2; k <= ORIGINAL_CHAPTERS; k++) {
      const n = originalPosition(k);
      const target = analyses.get(n)!;
      const facts = method(candidateFacts(target.entities, [...analyses.values()].filter((p) => p.chapter < n)), target.facts);
      maxFacts = Math.max(maxFacts, facts.length);
      maxChars = Math.max(maxChars, detectionInput(chapterFile(n), (await chapterLines(base, chapterFile(n))).lines, facts).length);
      chapters.push({ target_chapter: n, context: facts.map((f) => ({ chapter: f.chapter, text: f.quote })), findings: [] });
    }
    const dir = join(work, 'retrieval', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'predictions.json'), JSON.stringify({ run_id: `retrieval-${name}`, strategy: name, model: '-', chapters }) + '\n');
    rows.push(`${name.padEnd(20)} 최대 사실 ${String(maxFacts).padStart(5)}개, 최대 입력 ${maxChars}자`);
  }
  console.log(rows.join('\n'));
}

void main();
