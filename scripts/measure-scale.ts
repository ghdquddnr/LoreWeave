// 긴 연재 측정 (M5-PLAN 1·3절). Electron으로 실행해 앱에 저장된 키를 쓴다.
//   pnpm ai-script scripts/measure-scale.ts --dry-run       (예상 비용만)
//   pnpm ai-script scripts/measure-scale.ts --budget 0.8
// 1) 150화를 작업 폴더에 풀고 모두 분석한다 (이미 분석한 화는 건너뛴다)
// 2) 사실 줄이기 방법마다 분석 결과를 복사한 폴더에서 원래 화 14개(11, 21, …, 141번째)를 검사한다
// 3) 방법마다 predictions.json(M0-A 채점기 입력)과 사용량을, 모든 화에 대해 사실 수 증가표(growth.json)를 쓴다
// 모델은 계획대로 gpt-6-luna로 고정한다. 작업 폴더(기본 out/m5-work)는 저장소에 넣지 않는다.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { estimateCheckCost } from '../src/core/ai/cost.ts';
import { candidateFacts, detectionInput, selectFacts, SELECTIONS, type PriorAnalysis, type Selection } from '../src/core/ai/detection.ts';
import { chapterNumber } from '../src/core/project/chapters.ts';
import { AiStore } from '../src/main/ai-db.ts';
import { analysisStates, analyzeChapters, chapterLines, estimate } from '../src/main/analyzer.ts';
import { checkChapter } from '../src/main/checker.ts';
import { toPredictions } from './export-predictions.ts';
import { withBudget, type BudgetClient } from './lib/budget.ts';
import { chapterFile, ORIGINAL_CHAPTERS, originalPosition, TOTAL_CHAPTERS } from './lib/long-benchmark.ts';
import { runWithStoredKey } from './lib/stored-key.ts';
import { unpackLongBenchmark } from './unpack-long-benchmark.ts';

const MODEL = 'gpt-6-luna';
/** 사실 한 줄이 입력에서 차지하는 글자 수의 대략 (분석 전 예상 비용용) */
const FACT_CHARS = 60;
const FACTS_PER_CHAPTER_GUESS = 15;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const targets = () => Array.from({ length: ORIGINAL_CHAPTERS - 1 }, (_, i) => chapterFile(originalPosition(i + 2)));

/** 화 n을 검사할 때 넘길 사실 수와 입력 글자 수 (방법마다). API 호출 없음 */
async function growth(root: string, store: AiStore): Promise<Record<string, unknown>[]> {
  const analyses = new Map<number, PriorAnalysis>();
  for (let n = 1; n <= TOTAL_CHAPTERS; n++) {
    const a = store.analysis(chapterFile(n));
    if (a) analyses.set(n, { chapter: n, entities: a.entities, facts: a.facts });
  }
  const rows: Record<string, unknown>[] = [];
  for (let n = 2; n <= TOTAL_CHAPTERS; n++) {
    const target = analyses.get(n);
    if (!target) continue;
    const priors = [...analyses.values()].filter((p) => p.chapter < n);
    const all = candidateFacts(target.entities, priors);
    const lines = (await chapterLines(root, chapterFile(n))).lines;
    const row: Record<string, unknown> = { n, priorFacts: priors.reduce((s, p) => s + p.facts.length, 0) };
    for (const s of SELECTIONS) {
      const facts = selectFacts(all, s);
      row[s] = { facts: facts.length, inputChars: detectionInput(chapterFile(n), lines, facts).length };
    }
    rows.push(row);
  }
  return rows;
}

async function measure(base: string, work: string, selection: Selection, ai: BudgetClient, signal: AbortSignal): Promise<string> {
  const dir = join(work, selection);
  rmSync(dir, { recursive: true, force: true });
  cpSync(base, dir, { recursive: true });
  const store = AiStore.open(dir);
  const lines: string[] = [];
  try {
    for (const file of targets()) {
      const outcome = await checkChapter(file, { root: dir, store, client: ai, model: MODEL, signal, selection });
      if (outcome.stopped) throw new Error(`${selection} ${file}: ${outcome.stopped}`);
      const check = store.check(file)!;
      lines.push(`${selection} ${file}: 사실 ${check.factCount}개, 결과 ${outcome.findings}개(버림 ${outcome.dropped}) · $${outcome.costUsd.toFixed(4)}`);
      console.log(lines.at(-1));
    }
  } finally {
    store.close();
  }
  const { predictions, usage } = toPredictions(join(dir, '.loreweave', 'ai.db'), `m5-${selection}`, selection);
  mkdirSync(join(dir, 'eval'), { recursive: true });
  writeFileSync(join(dir, 'eval', 'predictions.json'), JSON.stringify(predictions, null, 2) + '\n');
  writeFileSync(join(dir, 'eval', 'usage.json'), JSON.stringify(usage, null, 2) + '\n');
  return `${selection}: 검사 ${usage.checks}회 · $${usage.costUsd.toFixed(4)} · 최대 입력 ${usage.maxInputTokens}토큰 · 최대 ${usage.maxLatencyMs}ms`;
}

runWithStoredKey(async ({ client, args }) => {
  const work = resolve(option(args, '--work') ?? 'out/m5-work');
  const budget = Number(option(args, '--budget') ?? '0.8');
  const selections = (option(args, '--selections')?.split(',') ?? [...SELECTIONS]) as Selection[];
  const dryRun = args.includes('--dry-run');
  const base = join(work, 'base');
  if (!existsSync(join(base, 'chapters'))) unpackLongBenchmark(base);

  const store = AiStore.open(base);
  const states = await analysisStates(base, store);
  const need = Object.keys(states)
    .filter((f) => states[f] !== 'fresh')
    .sort();
  const extraction = need.length ? (await estimate(base, need, MODEL)).costUsd : 0;
  // 검사 상한: 분석 전이라 사실 수를 화당 15개로 어림한다 (S0가 가장 크다)
  let checks = 0;
  for (const file of targets()) {
    const n = chapterNumber(file)!;
    const chars = (await chapterLines(base, file)).lines.join('\n').length + (n - 1) * FACTS_PER_CHAPTER_GUESS * FACT_CHARS;
    checks += estimateCheckCost(MODEL, chars) * selections.length;
  }
  console.log(`앱에 저장된 키를 읽었습니다. 모델 ${MODEL}, 작업 폴더 ${work}`);
  console.log(`분석할 화 ${need.length}개 (예상 최대 $${extraction.toFixed(3)}), 검사 ${targets().length}화 × 방법 ${selections.length}개 (어림 최대 $${checks.toFixed(3)}), 한도 $${budget.toFixed(2)}`);
  if (dryRun) return store.close();

  const ai = withBudget(client, MODEL, budget);
  const signal = new AbortController().signal;
  if (need.length) {
    const started = Date.now();
    const progress = await analyzeChapters(need, {
      root: base,
      store,
      client: ai,
      model: MODEL,
      signal,
      onProgress: (p) => p.done % 10 === 0 && p.done > 0 && console.log(`분석 ${p.done}/${p.total} · 누적 $${ai.spent().toFixed(4)}`),
    });
    console.log(`분석 ${progress.done}/${progress.total} · $${progress.costUsd.toFixed(4)} · ${Math.round((Date.now() - started) / 1000)}초`);
    if (progress.stopped || progress.failed.length) {
      throw new Error(`분석을 마치지 못했습니다: ${progress.stopped ?? progress.failed.map((f) => `${f.file} ${f.message}`).join(', ')}`);
    }
  }
  writeFileSync(join(work, 'growth.json'), JSON.stringify(await growth(base, store), null, 1) + '\n');
  console.log(`사실 수 증가표: ${join(work, 'growth.json')}`);
  store.close();

  // 방법끼리는 폴더가 달라 동시에 검사한다 (호출은 동시에 최대 방법 수만큼)
  const summaries = await Promise.all(selections.map((s) => measure(base, work, s, ai, signal)));
  for (const s of summaries) console.log(s);
  console.log(`합계 $${ai.spent().toFixed(4)}. 채점: pnpm --dir spikes/m0a-ai-feasibility evaluate ${join(work, '<방법>', 'eval')} ${base}`);
});
