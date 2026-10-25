// 실제 장편으로 분석·검사 (M6-PLAN 2·3절). Electron으로 실행해 앱에 저장된 키를 쓴다.
//   pnpm ai-script scripts/measure-real.ts --project <원고 폴더> --dry-run
//   pnpm ai-script scripts/measure-real.ts --project <원고 폴더> --budget 1.5
// 1) 모든 화를 분석한다 (이미 분석한 화는 건너뛴다)
// 2) 2화부터 마지막 화까지 고르게 퍼진 --sample개(기본 20) 화를 제품과 같은 설정으로 검사한다 (400개씩 나눠 검사)
// 3) 원고 폴더의 review/에 판정용 표(review.md, 인용 포함)와 판정 틀(judgments.json), 집계(summary.json, 인용 없음)를 쓴다
// 원고와 인용이 든 결과는 저장소에 넣지 않으므로, 원고 폴더가 저장소 안이면 멈춘다. 모델은 gpt-6-luna로 고정한다.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { estimateCheckCost } from '../src/core/ai/cost.ts';
import { CATEGORY_LABELS, CHECK_BATCH_SIZE } from '../src/core/ai/detection.ts';
import { chapterNumber, sortChapterFiles } from '../src/core/project/chapters.ts';
import { AiStore } from '../src/main/ai-db.ts';
import { analysisStates, analyzeChapters, chapterLines, estimate } from '../src/main/analyzer.ts';
import { checkChapter } from '../src/main/checker.ts';
import { chapterFileNames } from '../src/main/project-files.ts';
import { withBudget } from './lib/budget.ts';
import { sampleChapters } from './lib/import-txt.ts';
import { runWithStoredKey } from './lib/stored-key.ts';

const MODEL = 'gpt-6-luna';
const ANALYZE_CONCURRENCY = 4;
/** 분석 전 검사 비용 어림: 화당 사실 수, 사실 한 줄 글자 수 */
const FACTS_PER_CHAPTER_GUESS = 25;
const FACT_CHARS = 60;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

runWithStoredKey(async ({ client, args }) => {
  const projectArg = option(args, '--project');
  if (!projectArg) throw new Error('--project <원고 폴더>가 필요합니다');
  const root = resolve(projectArg);
  if (!relative(process.cwd(), root).startsWith('..')) throw new Error('원고 폴더는 저장소 밖에 있어야 합니다');
  const budget = Number(option(args, '--budget') ?? '1.5');
  const count = Number(option(args, '--sample') ?? '20');
  const dryRun = args.includes('--dry-run');

  const files = sortChapterFiles(await chapterFileNames(root));
  const targets = sampleChapters(files, count);
  const store = AiStore.open(root);
  try {
    const states = await analysisStates(root, store);
    const need = files.filter((f) => states[f] !== 'fresh');
    const extraction = need.length ? (await estimate(root, need, MODEL)).costUsd : 0;
    let checks = 0;
    for (const file of targets) {
      const priorFacts = files.indexOf(file) * FACTS_PER_CHAPTER_GUESS;
      const batches = Math.max(1, Math.ceil(priorFacts / CHECK_BATCH_SIZE));
      const chapterChars = (await chapterLines(root, file)).lines.join('\n').length;
      checks += estimateCheckCost(MODEL, priorFacts * FACT_CHARS + batches * chapterChars) + (batches - 1) * estimateCheckCost(MODEL, 0);
    }
    console.log(`앱에 저장된 키를 읽었습니다. 모델 ${MODEL}, 화 ${files.length}개`);
    console.log(`분석할 화 ${need.length}개 (예상 최대 $${extraction.toFixed(3)}), 검사 ${targets.length}화 (어림 최대 $${checks.toFixed(3)}), 한도 $${budget.toFixed(2)}`);
    console.log(`검사할 화: ${targets.map((f) => chapterNumber(f)).join(', ')}`);
    if (dryRun) return;

    const ai = withBudget(client, MODEL, budget);
    const signal = new AbortController().signal;
    const summary: Record<string, unknown> = { model: MODEL, chapters: files.length, sample: targets.map((f) => chapterNumber(f)) };
    if (need.length) {
      const started = Date.now();
      const progress = await analyzeChapters(need, {
        root,
        store,
        client: ai,
        model: MODEL,
        signal,
        concurrency: ANALYZE_CONCURRENCY,
        onProgress: (p) => p.done % 20 === 0 && p.done > 0 && console.log(`분석 ${p.done}/${p.total} · 누적 $${ai.spent().toFixed(4)}`),
      });
      summary['analysis'] = { done: progress.done, failed: progress.failed.length, costUsd: progress.costUsd, seconds: Math.round((Date.now() - started) / 1000) };
      console.log(`분석 ${progress.done}/${progress.total} · $${progress.costUsd.toFixed(4)} · ${Math.round((Date.now() - started) / 1000)}초`);
      if (progress.stopped || progress.failed.length) {
        throw new Error(`분석을 마치지 못했습니다: ${progress.stopped ?? progress.failed.map((f) => `${f.file} ${f.message}`).join(', ')}`);
      }
    }
    // 추출 인용 보존과 사실 수
    let kept = 0;
    let dropped = 0;
    const factsPerChapter: number[] = [];
    for (const f of files) {
      const a = store.analysis(f)!;
      kept += a.facts.length;
      dropped += a.droppedQuotes;
      factsPerChapter.push(a.facts.length);
    }
    summary['extraction'] = { facts: kept, droppedQuotes: dropped, retention: kept / (kept + dropped), factsPerChapter: kept / files.length };
    console.log(`사실 ${kept}개, 인용을 못 찾아 버린 사실 ${dropped}개 (보존 ${((100 * kept) / (kept + dropped)).toFixed(1)}%), 화당 ${(kept / files.length).toFixed(1)}개`);

    const checksOut: Record<string, unknown>[] = [];
    const review: string[] = ['# 판정용 검사 결과 (저장소에 넣지 않는다)', ''];
    const judgments: Record<string, { verdict: string; note: string }> = {};
    for (const file of targets) {
      const started = Date.now();
      const outcome = await checkChapter(file, { root, store, client: ai, model: MODEL, signal });
      const seconds = (Date.now() - started) / 1000;
      if (outcome.stopped) throw new Error(`${file}: ${outcome.stopped}`);
      const check = store.check(file)!;
      const batches = Math.max(1, Math.ceil(check.factCount / CHECK_BATCH_SIZE));
      checksOut.push({ chapter: chapterNumber(file), facts: check.factCount, batches, findings: outcome.findings, dropped: outcome.dropped, costUsd: outcome.costUsd, seconds });
      console.log(`${file}: 사실 ${check.factCount}개(${batches}번 나눔), 결과 ${outcome.findings}개(버림 ${outcome.dropped}) · $${outcome.costUsd.toFixed(4)} · ${seconds.toFixed(1)}초`);
      const lines = (await chapterLines(root, file)).lines;
      for (const f of check.findings) {
        const id = `${chapterNumber(file)}-${f.ord}`;
        judgments[id] = { verdict: '', note: '' };
        review.push(`## ${id} · ${CATEGORY_LABELS[f.category]} · 확신 ${f.confidence.toFixed(2)}`, '', `- 설명: ${f.claim}`, `- 이 화: ${f.target.quote}`, `  - 줄: ${lines[f.target.line]}`);
        for (const e of f.evidence) {
          const elines = (await chapterLines(root, e.file)).lines;
          review.push(`- ${e.chapter}화: ${e.quote}`, `  - 줄: ${elines[e.line]}`);
        }
        review.push('');
      }
    }
    summary['checks'] = checksOut;
    summary['totalCostUsd'] = ai.spent();
    const out = join(root, 'review');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'review.md'), review.join('\n') + '\n');
    const judgmentsPath = join(out, 'judgments.json');
    if (!existsSync(judgmentsPath)) writeFileSync(judgmentsPath, JSON.stringify(judgments, null, 2) + '\n');
    writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(`결과 ${Object.keys(judgments).length}개 · 합계 $${ai.spent().toFixed(4)} · 판정용 표: ${join(out, 'review.md')}`);
  } finally {
    store.close();
  }
});
