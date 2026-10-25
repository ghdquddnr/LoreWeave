// M9 detect-2 후보 측정 (M9-PLAN 4·5절). Electron으로 실행해 앱에 저장된 키를 쓴다. 키는 대조를 통과한 뒤에만 푼다.
//   pnpm ai-script scripts/m9-detect2.ts --baseline <M8 복사본> --work <새 작업 폴더>              (대조만, 유료 호출 0)
//   pnpm ai-script scripts/m9-detect2.ts --baseline <M8 복사본> --work <새 작업 폴더> --run --budget 1.2
// 기준의 평가기 출력은 기본으로 <M8 복사본>/review/eval/predictions.json을 쓴다 (--predictions로 바꿀 수 있다).
// 검사할 화는 기준에 검사 기록이 있는 화 전부다. 원본 원고·ai.db에는 쓰지 않는다.

import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runM9 } from './lib/m9-run.ts';
import { runWithLazyKey } from './lib/stored-key.ts';

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
  const baseline = option(args, '--baseline');
  const work = option(args, '--work');
  if (!baseline || !work) throw new Error('--baseline <M8 복사본>과 --work <새 작업 폴더>가 필요합니다');
  const run = args.includes('--run');
  const budgetUsd = Number(option(args, '--budget') ?? '1.2');
  if (!(budgetUsd > 0 && budgetUsd <= 1.2)) throw new Error('단계 한도는 0보다 크고 $1.2 이하여야 합니다');
  const result = await runM9({
    baseline: resolve(baseline),
    work: resolve(work),
    predictions: resolve(option(args, '--predictions') ?? join(baseline, 'review', 'eval', 'predictions.json')),
    targets: checkedFiles(resolve(baseline)),
    runs: Number(option(args, '--runs') ?? '2'),
    budgetUsd,
    run,
    connect: () => connect({ maxRetries: 0 }),
    repoRoot: process.cwd(),
    log: (line) => console.log(line),
  });
  console.log(JSON.stringify({ stage: result.stage, reason: result.reason, connected: result.connected, ledger: result.ledger, preflight: result.preflight }, null, 2));
  if (result.stage !== 'done' && result.stage !== 'preflight-ok') process.exitCode = 1;
});
