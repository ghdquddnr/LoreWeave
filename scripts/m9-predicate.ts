// M9 후속 실험: 같은 속성 이름의 앞 화 사실 더하기 (scripts/lib/predicate-run.ts). Electron으로 실행해 앱에 저장된 키를 쓴다.
//   대조만 (기본, 유료 호출 0, 키 미사용, 장부 미생성):
//     pnpm ai-script scripts/m9-predicate.ts --m4 <M4 시험 원고> --real <M8 복사본> --work <새 작업 폴더>
//   실행 (감독 승인 뒤에만):
//     ... --run --approval <감독 승인 ID> --ledger <이 실험 전용 새 장부 폴더>
// 판단 프롬프트 detect-1, 모델 gpt-6-luna, 회 수(M4 3회 → 실제 원고 2회), 한도($1.2), 출력 상한(16,000), 재시도(요청마다 최대 1회)는 고정이다.
// 명령줄로 바꿀 수 없다. M9 detect-2 장부(m9-detect2)는 ID가 달라 열리지 않는다.

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadChapters, loadGroundTruth } from '../spikes/m0a-ai-feasibility/src/benchmark.ts';
import { evaluate } from '../spikes/m0a-ai-feasibility/src/evaluate.ts';
import { differsFromBenchmark, M0A_BENCHMARK, scoreM4 } from './lib/m4-score.ts';
import { e23Template, realSummary, runPredicate } from './lib/predicate-run.ts';
import { runWithLazyKey } from './lib/stored-key.ts';

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function checkedFiles(baseline: string): string[] {
  const db = new DatabaseSync(join(baseline, '.loreweave', 'ai.db'), { readOnly: true });
  try {
    return (db.prepare('SELECT file FROM checks ORDER BY file').all() as { file: string }[]).map((r) => r.file);
  } finally {
    db.close();
  }
}

runWithLazyKey(async ({ connect, args }) => {
  const m4 = option(args, '--m4');
  const real = option(args, '--real');
  const work = option(args, '--work');
  if (!m4 || !real || !work) throw new Error('--m4 <M4 시험 원고> --real <M8 복사본> --work <새 작업 폴더>가 필요합니다');
  for (const banned of ['--budget', '--runs', '--limit', '--model', '--prompt']) if (args.includes(banned)) throw new Error(`${banned}는 받지 않습니다. 고정값입니다`);
  const m4Base = resolve(m4);
  const realBase = resolve(real);
  const differs = differsFromBenchmark(m4Base);
  if (differs) throw new Error(`M4 시험 원고가 벤치마크와 달라 정답표를 쓸 수 없습니다: ${differs}`);
  const ledgerDir = option(args, '--ledger');
  const realGt = loadGroundTruth(realBase);
  const realChapters = loadChapters(realBase);
  // Ctrl+C는 프로세스를 끝내지 않고 취소 신호만 보낸다: 진행 중 요청을 끊고, 새 요청을 보내지 않고, 장부를 정리한 뒤 끝난다
  const cancel = new AbortController();
  process.on('SIGINT', () => {
    console.log('취소합니다. 진행 중 요청을 끊고 장부를 정리한 뒤 끝냅니다');
    cancel.abort();
  });
  const result = await runPredicate({
    signal: cancel.signal,
    m4: { baseline: m4Base, predictions: null, targets: checkedFiles(m4Base) },
    real: { baseline: realBase, predictions: resolve(option(args, '--predictions') ?? join(real, 'review', 'eval', 'predictions.json')), targets: checkedFiles(realBase) },
    work: resolve(work),
    repoRoot: process.cwd(),
    run: args.includes('--run'),
    approval: option(args, '--approval'),
    ledgerDir: ledgerDir ? resolve(ledgerDir) : undefined,
    connect: () => connect({ maxRetries: 0 }),
    scoreM4: (label, predictions, n) => {
      const s = scoreM4(label, predictions, n, M0A_BENCHMARK);
      const e23Found = !evaluate(predictions, loadGroundTruth(M0A_BENCHMARK), loadChapters(M0A_BENCHMARK)).missed.test.includes('E23');
      return { ...s, e23: e23Template(label, e23Found) };
    },
    scoreReal: (label, predictions) => realSummary(label, evaluate(predictions, realGt, realChapters)),
    log: (line) => console.log(line),
  });
  if (existsSync(resolve(work))) writeFileSync(join(resolve(work), 'result.json'), JSON.stringify(result, null, 2) + '\n');
  // 화면에는 화별 집계를 빼고 요약만 낸다
  const brief = { ...result, preflight: result.preflight.map((p) => ({ label: p.label, base: { ok: p.base.ok, passed: p.base.passed, chapters: p.base.chapters, batches: p.base.batches, failuresByItem: p.base.failuresByItem, skipped: p.base.skipped }, addition: { ...p.addition, perChapter: undefined } })) };
  console.log(JSON.stringify(brief, null, 2));
  if (result.stage !== 'done' && result.stage !== 'preflight-ok') process.exitCode = 1;
});
