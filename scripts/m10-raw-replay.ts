// 원래 응답 기록(--record-raw)을 오프라인으로 다시 돌린다 (scripts/lib/raw-replay.ts). 모델을 부르지 않는다.
//   pnpm tsx scripts/m10-raw-replay.ts <작업 폴더>
// 회차마다 <작업 폴더>/raw/replay-<회차>.json에 상세(원고 인용 포함)를 쓰고, 화면에는 수만 낸다. 작업 폴더는 저장소 밖이어야 한다.
// 기록을 켜지 않은 과거 실행에는 쓸 수 없다 (원래 응답이 남아 있지 않다).

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readRaw, replayRun, replaySummary } from './lib/raw-replay.ts';

const work = process.argv[2];
if (!work) {
  console.error('사용: pnpm tsx scripts/m10-raw-replay.ts <작업 폴더>');
  process.exit(1);
}
const dir = join(resolve(work), 'raw');
if (!existsSync(dir)) {
  console.error('원래 응답 기록이 없습니다 (--record-raw로 실행한 작업 폴더가 아닙니다)');
  process.exit(1);
}
void (async () => {
  for (const f of readdirSync(dir).filter((x) => /^(m4|real)-\d+\.jsonl$/.test(x)).sort()) {
    const label = f.replace(/\.jsonl$/, '');
    const [dataset, n] = label.split('-') as [string, string];
    const root = join(resolve(work), dataset, `run-${n}`);
    const chapters = await replayRun(root, join(dir, f), join(root, '.loreweave', 'ai.db'));
    writeFileSync(join(dir, `replay-${label}.json`), JSON.stringify(chapters, null, 1) + '\n');
    console.log(JSON.stringify(replaySummary(label, chapters, readRaw(join(dir, f)).attempts)));
  }
})();
