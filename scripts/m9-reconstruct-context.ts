// 이미 끝난 M9 사실 더하기 회차의 평가기 출력을, 저장된 분석으로 다시 만든 context로 새로 쓴다 (파생 산출물). API를 부르지 않는다.
//   pnpm tsx scripts/m9-reconstruct-context.ts <회차 복사본 폴더> <새 출력 파일>
// 원래 eval/predictions.json은 바꾸지 않는다. 출력은 context_source가 reconstructed-from-stored-analyses이고, 당시 전송을 관측한 것이 아니다.
// 출력 파일이 이미 있거나 원래 평가기 출력과 같은 경로면 멈춘다.
// 회차 복사본도 바꾸지 않도록, 화 파일과 ai.db를 임시 폴더에 복사해 거기서 계산하고 지운다 (DB를 열면 WAL 파일이 생기기 때문이다).

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { copyProject } from './lib/m9-run.ts';
import { toPredictions } from './export-predictions.ts';
import { reconstructPredicateContexts } from './lib/predicate-run.ts';

export async function writeReconstructed(root: string, out: string, runId: string): Promise<void> {
  if (resolve(out) === resolve(join(root, 'eval', 'predictions.json'))) throw new Error('원래 평가기 출력을 덮어쓰지 않습니다');
  if (existsSync(out)) throw new Error('출력 파일이 이미 있습니다');
  const scratch = mkdtempSync(join(tmpdir(), 'loreweave-reconstruct-'));
  try {
    copyProject(root, join(scratch, 'copy'));
    const byChapter = await reconstructPredicateContexts(join(scratch, 'copy'));
    const { predictions } = toPredictions(join(scratch, 'copy', '.loreweave', 'ai.db'), runId, 'all', { source: 'reconstructed-from-stored-analyses', byChapter });
    writeFileSync(out, JSON.stringify(predictions, null, 2) + '\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const [root, out] = process.argv.slice(2);
  if (!root || !out) {
    console.error('사용: pnpm tsx scripts/m9-reconstruct-context.ts <회차 복사본 폴더> <새 출력 파일>');
    process.exit(1);
  }
  writeReconstructed(resolve(root), resolve(out), `reconstructed-${new Date().toISOString().slice(0, 10)}`).then(
    () => console.log(`재구성한 평가기 출력을 썼습니다: ${resolve(out)} (context_source: reconstructed-from-stored-analyses)`),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    },
  );
}
