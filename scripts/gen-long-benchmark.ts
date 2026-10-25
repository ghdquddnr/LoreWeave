// 150화 긴 시험 원고 만들기 (M5-PLAN 1·2절). Electron으로 실행해 앱에 저장된 키를 쓴다.
//   pnpm ai-script scripts/gen-long-benchmark.ts --dry-run          (예상 비용만, 호출 없음)
//   pnpm ai-script scripts/gen-long-benchmark.ts --budget 0.6       (생성)
// 원래 화 15개를 새 번호로 복사하고 정답표 번호를 바꾼 뒤, 없는 중간 화만 만든다 (중간에 멈춰도 이어서 만든다).
// 모델은 계획대로 gpt-6-luna로 고정한다. 앱에서 고른 모델은 쓰지 않는다.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { costUsd } from '../src/core/ai/cost.ts';
import { BudgetExceeded, withBudget } from './lib/budget.ts';
import {
  canonOnly,
  chapterFile,
  FILLER_PROMPT_VERSION,
  FILLER_SCHEMA,
  FILLER_SYSTEM,
  fillerFileText,
  fillerInput,
  fillerPositions,
  gapOf,
  ORIGINAL_CHAPTERS,
  originalPosition,
  parseFiller,
  parsePlot,
  renumberGroundTruth,
  renumberHeading,
} from './lib/long-benchmark.ts';
import { runWithStoredKey } from './lib/stored-key.ts';

const MODEL = 'gpt-6-luna';
const M0A = resolve('spikes/m0a-ai-feasibility/benchmark');
/** 출력 상한: 3,500자 문단 + 요약 + JSON 기호를 넉넉히 */
const OUTPUT_TOKENS_BOUND = 6000;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

interface LogLine {
  n: number;
  summary: string;
}

runWithStoredKey(async ({ client, args }) => {
  const out = resolve(option(args, '--out') ?? 'spikes/m5-scale/benchmark');
  const budget = Number(option(args, '--budget') ?? '0.6');
  const concurrency = Number(option(args, '--concurrency') ?? '3');
  const dryRun = args.includes('--dry-run');
  const chapters = join(out, 'chapters');
  const logPath = join(out, 'generation.jsonl');
  mkdirSync(chapters, { recursive: true });

  // 원래 화와 정답표
  for (let k = 1; k <= ORIGINAL_CHAPTERS; k++) {
    const text = readFileSync(join(M0A, 'chapters', `ch${String(k).padStart(2, '0')}.md`), 'utf8');
    writeFileSync(join(chapters, chapterFile(originalPosition(k))), renumberHeading(text, originalPosition(k)));
  }
  const gt = JSON.parse(readFileSync(join(M0A, 'ground-truth.json'), 'utf8'));
  writeFileSync(join(out, 'ground-truth.json'), JSON.stringify(renumberGroundTruth(gt), null, 2) + '\n');

  const canon = { worldBible: canonOnly(readFileSync(join(M0A, 'world-bible.md'), 'utf8')), plot: canonOnly(readFileSync(join(M0A, 'plot.md'), 'utf8')) };
  const plot = parsePlot(readFileSync(join(M0A, 'plot.md'), 'utf8'));
  if (plot.length !== ORIGINAL_CHAPTERS) throw new Error(`플롯에서 화 ${plot.length}개를 읽었습니다 (15개여야 함)`);
  const done: LogLine[] = existsSync(logPath)
    ? readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LogLine)
    : [];
  const todo = fillerPositions().filter((n) => !existsSync(join(chapters, chapterFile(n))));

  const sampleInput = fillerInput(2, canon, plot, []).length + FILLER_SYSTEM.length;
  const perChapter = costUsd(MODEL, { inputTokens: sampleInput + 600, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: OUTPUT_TOKENS_BOUND });
  console.log(`앱에 저장된 키를 읽었습니다. 모델 ${MODEL}, 출력 ${out}`);
  console.log(`원래 화 15개와 정답표를 새 번호로 썼습니다. 만들 중간 화 ${todo.length}개 (이미 있는 것 ${135 - todo.length}개)`);
  console.log(`예상 비용 최대 $${(perChapter * todo.length).toFixed(3)} (화당 최대 $${perChapter.toFixed(4)}), 한도 $${budget.toFixed(2)}`);
  if (dryRun || todo.length === 0) return;
  if (perChapter * todo.length > budget) throw new Error('예상 비용 상한이 한도를 넘습니다. --budget을 늘리거나 나눠서 만드세요.');

  const ai = withBudget(client, MODEL, budget);
  const byGap = new Map<number, number[]>();
  for (const n of todo) byGap.set(gapOf(n).before, [...(byGap.get(gapOf(n).before) ?? []), n]);
  const gaps = [...byGap.values()];
  let made = 0;
  let stopped: string | null = null;

  const runGap = async (positions: number[]) => {
    for (const n of positions) {
      if (stopped) return;
      const { before } = gapOf(n);
      const earlier = done.filter((d) => gapOf(d.n).before === before && d.n < n).sort((a, b) => a.n - b.n);
      try {
        const result = await ai.json({ model: MODEL, system: FILLER_SYSTEM, user: fillerInput(n, canon, plot, earlier), schema: FILLER_SCHEMA });
        const filler = parseFiller(result.data);
        const text = fillerFileText(n, filler);
        writeFileSync(join(chapters, chapterFile(n)), text);
        const line = {
          n,
          title: filler.title,
          summary: filler.summary,
          chars: text.length,
          promptVersion: FILLER_PROMPT_VERSION,
          model: MODEL,
          modelVersion: result.modelVersion,
          usage: result.usage,
          costUsd: costUsd(MODEL, result.usage),
          latencyMs: result.latencyMs,
          at: new Date().toISOString(),
        };
        appendFileSync(logPath, JSON.stringify(line) + '\n');
        done.push(line);
        made++;
        console.log(`${n}화 「${filler.title}」 ${text.length}자 · 누적 $${ai.spent().toFixed(4)}`);
      } catch (e) {
        stopped = e instanceof BudgetExceeded ? e.message : `${n}화 생성 실패: ${e instanceof Error ? e.message : String(e)}`;
        return;
      }
    }
  };

  const queue = [...gaps];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let g = queue.shift(); g && !stopped; g = queue.shift()) await runGap(g);
    }),
  );
  console.log(`중간 화 ${made}개를 만들었습니다 · 비용 $${ai.spent().toFixed(4)}`);
  if (stopped) throw new Error(`${stopped}. 다시 실행하면 없는 화부터 이어서 만듭니다.`);
});
