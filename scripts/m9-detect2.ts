// M9 detect-2 후보 측정 (M9-PLAN 4·5절). Electron으로 실행해 앱에 저장된 키를 쓴다. 키는 대조를 통과한 뒤에만 푼다.
//   대조만 (유료 호출 0, 키 미사용):
//     pnpm ai-script scripts/m9-detect2.ts --dataset real --baseline <M8 복사본> --work <새 작업 폴더>
//     pnpm ai-script scripts/m9-detect2.ts --dataset m4 --baseline <M4 시험 원고> --work <새 작업 폴더>
//   실행 (감독 승인 뒤에만):
//     ... --run --ledger <단계 장부 폴더>
// 데이터셋마다 회 수가 정해져 있다 (real 2회, m4 3회). 한도는 단계 장부에 고정된 $1.2이고, 두 데이터셋의 모든 회차가 같은 장부를 함께 쓴다.
// 명령줄로 한도·잔액·회 수를 바꿀 수 없다. 이미 시작한 회차(real-1 등)는 다시 하지 않는다.
// real은 기준의 평가기 출력(<M8 복사본>/review/eval/predictions.json)으로 화·인용 순서를 대조한다.
// m4는 당시 평가기 출력이 없어 그 항목을 건너뛰고(skipped로 남김), 원고가 M0-A 벤치마크와 바이트까지 같은지 확인한 뒤 회마다 M0-A 평가기로 채점한다.
// 검사할 화는 기준에 검사 기록이 있는 화 전부다. 원본 원고·ai.db에는 쓰지 않는다.

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { differsFromBenchmark, M0A_BENCHMARK, m4Passed, scoreM4, type M4Score } from './lib/m4-score.ts';
import { runM9 } from './lib/m9-run.ts';
import { runWithLazyKey } from './lib/stored-key.ts';

const DATASETS = { real: { runs: 2 }, m4: { runs: 3 } } as const;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** 기준에 검사 기록이 있는 화 (파일 이름 순) */
function checkedFiles(baseline: string): string[] {
  const db = new DatabaseSync(join(baseline, '.loreweave', 'ai.db'), { readOnly: true });
  try {
    return (db.prepare('SELECT file FROM checks ORDER BY file').all() as { file: string }[]).map((r) => r.file);
  } finally {
    db.close();
  }
}

runWithLazyKey(async ({ connect, args }) => {
  const dataset = option(args, '--dataset');
  const baseline = option(args, '--baseline');
  const work = option(args, '--work');
  if (dataset !== 'real' && dataset !== 'm4') throw new Error('--dataset real 또는 --dataset m4가 필요합니다');
  if (!baseline || !work) throw new Error('--baseline <기준 폴더>와 --work <새 작업 폴더>가 필요합니다');
  for (const banned of ['--budget', '--runs', '--limit']) if (args.includes(banned)) throw new Error(`${banned}는 받지 않습니다. 한도와 회 수는 고정입니다`);
  const run = args.includes('--run');
  const ledgerDir = option(args, '--ledger');
  if (run && !ledgerDir) throw new Error('--run에는 --ledger <단계 장부 폴더>가 필요합니다');
  const base = resolve(baseline);
  if (dataset === 'm4') {
    const differs = differsFromBenchmark(base);
    if (differs) throw new Error(`M4 시험 원고가 벤치마크와 달라 정답표를 쓸 수 없습니다: ${differs}`);
  }
  const targets = checkedFiles(base);
  const scores: M4Score[] = [];
  const result = await runM9({
    label: dataset,
    baseline: base,
    work: resolve(work),
    predictions: dataset === 'real' ? resolve(option(args, '--predictions') ?? join(baseline, 'review', 'eval', 'predictions.json')) : null,
    targets,
    runs: DATASETS[dataset].runs,
    // 대조만 할 때는 장부를 열지 않는다
    ledgerDir: ledgerDir ? resolve(ledgerDir) : undefined,
    run,
    connect: () => connect({ maxRetries: 0 }),
    repoRoot: process.cwd(),
    afterRun:
      dataset === 'm4'
        ? (label, predictions) => {
            const s = scoreM4(label, predictions, targets.length, M0A_BENCHMARK);
            scores.push(s);
            return s;
          }
        : undefined,
    log: (line) => console.log(line),
  });
  if (dataset === 'm4' && scores.length) writeFileSync(join(resolve(work), 'm4-scores.json'), JSON.stringify({ scores, passed: m4Passed(scores) }, null, 2) + '\n');
  console.log(
    JSON.stringify(
      { stage: result.stage, reason: result.reason, connected: result.connected, ledger: result.ledger, stage_ledger: result.stageSummary, preflight: result.preflight, scores },
      null,
      2,
    ),
  );
  if (result.stage !== 'done' && result.stage !== 'preflight-ok') process.exitCode = 1;
});
