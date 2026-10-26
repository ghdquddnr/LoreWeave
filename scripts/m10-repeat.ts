// M10 같은 입력 반복 검사 (scripts/lib/m10-run.ts). Electron으로 실행해 앱에 저장된 키를 쓴다.
//   대조와 상한 계산만 (기본, 유료 호출 0, 키 미사용, 장부 미생성):
//     pnpm ai-script scripts/m10-repeat.ts --m4 <M4 시험 원고> --real <M8 복사본> --work <새 작업 폴더>
//   실행 (감독 승인 뒤에만):
//     ... --run --approval <감독 승인 ID> --ledger <이 실험 전용 새 장부 폴더>
//   원래 응답 기록 (선택, 기본 끔): ... --record-raw  → <작업 폴더>/raw/<회차>.jsonl. 다시 돌리기: pnpm tsx scripts/m10-raw-replay.ts <작업 폴더>
// 판단 프롬프트 detect-1, 모델 gpt-6-luna, 회 수(M4 4회 → 실제 원고 2회), 한도($1.2), 출력 상한(16,000), 재시도(요청마다 최대 1회), 묶음 동시 2는 고정이다.
// 명령줄로 바꿀 수 없다. 끝난 M9 장부(m9-detect2, m9p-predicate)는 ID가 달라 열리지 않는다.

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadChapters, loadGroundTruth } from '../spikes/m0a-ai-feasibility/src/benchmark.ts';
import { evaluate } from '../spikes/m0a-ai-feasibility/src/evaluate.ts';
import { differsFromBenchmark, M0A_BENCHMARK, scoreM4 } from './lib/m4-score.ts';
import { runM10 } from './lib/m10-run.ts';
import { realSummary } from './lib/predicate-run.ts';
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
  for (const banned of ['--budget', '--runs', '--limit', '--model', '--prompt', '--retries', '--concurrency']) if (args.includes(banned)) throw new Error(`${banned}는 받지 않습니다. 고정값입니다`);
  const m4Base = resolve(m4);
  const realBase = resolve(real);
  const differs = differsFromBenchmark(m4Base);
  if (differs) throw new Error(`M4 시험 원고가 벤치마크와 달라 정답표를 쓸 수 없습니다: ${differs}`);
  const ledgerDir = option(args, '--ledger');
  const realGt = loadGroundTruth(realBase);
  const realChapters = loadChapters(realBase);
  const cancel = new AbortController();
  process.on('SIGINT', () => {
    console.log('취소합니다. 진행 중 요청을 끊고 장부를 정리한 뒤 끝냅니다');
    cancel.abort();
  });
  const result = await runM10({
    signal: cancel.signal,
    m4: { baseline: m4Base, predictions: null, targets: checkedFiles(m4Base) },
    real: { baseline: realBase, predictions: resolve(option(args, '--predictions') ?? join(real, 'review', 'eval', 'predictions.json')), targets: checkedFiles(realBase) },
    work: resolve(work),
    repoRoot: process.cwd(),
    run: args.includes('--run'),
    // 원래 응답 기록 (기본 끔). 켜면 작업 폴더의 raw/에만 쓴다 (원고 인용 포함, 공개하지 않음)
    recordRaw: args.includes('--record-raw'),
    approval: option(args, '--approval'),
    ledgerDir: ledgerDir ? resolve(ledgerDir) : undefined,
    connect: () => connect({ maxRetries: 0 }),
    scoreM4: (label, predictions, n) => ({ ...scoreM4(label, predictions, n, M0A_BENCHMARK) }),
    recordM4: (label, predictions, n) => ({ ...scoreM4(label, predictions, n, M0A_BENCHMARK), recordOnly: true }),
    scoreReal: (label, predictions) => realSummary(label, evaluate(predictions, realGt, realChapters)),
    log: (line) => console.log(line),
  });
  if (existsSync(resolve(work))) writeFileSync(join(resolve(work), 'result.json'), JSON.stringify(result, null, 2) + '\n');
  const brief = { ...result, preflight: result.preflight.map((p) => ({ label: p.label, base: { ok: p.base.ok, passed: p.base.passed, chapters: p.base.chapters, batches: p.base.batches, failuresByItem: p.base.failuresByItem, skipped: p.base.skipped }, plan: p.plan })) };
  console.log(JSON.stringify(brief, null, 2));
  if (result.stage !== 'done' && result.stage !== 'preflight-ok') process.exitCode = 1;
});
