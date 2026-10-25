// 원고 폴더를 복사해 오류를 심고 정답표를 쓴다 (M7-PLAN 2절). API 호출 없음.
//   pnpm tsx scripts/seed-errors.ts <원래 원고 폴더> <만들 복사본 폴더> <심을 목록.json>
// 복사본과 목록은 저장소 밖에 있어야 한다. 원래 폴더의 분석 결과(.loreweave)도 함께 복사해, 고친 화만 다시 분석하면 되게 한다.
// 복사본에 chapters/와 ground-truth.json이 생기므로, 그대로 M0-A 채점기의 벤치마크 폴더로 쓸 수 있다.

import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { applySeed, groundTruth, validateSeeds, type Seed } from './lib/seed.ts';

const [sourceArg, destArg, seedsArg] = process.argv.slice(2);
if (!sourceArg || !destArg || !seedsArg) {
  console.error('사용: pnpm tsx scripts/seed-errors.ts <원래 원고 폴더> <만들 복사본 폴더> <심을 목록.json>');
  process.exit(1);
}
const [source, dest, seedsPath] = [sourceArg, destArg, seedsArg].map((p) => resolve(p));
for (const p of [dest, seedsPath]) {
  if (!relative(process.cwd(), p!).startsWith('..')) {
    console.error(`저장소 밖에 있어야 합니다: ${p}`);
    process.exit(1);
  }
}
if (existsSync(dest!)) {
  console.error(`${dest}가 이미 있습니다. 지우고 다시 실행하세요.`);
  process.exit(1);
}

const file = (n: number) => `${String(n).padStart(3, '0')}.md`;
const seeds = JSON.parse(readFileSync(seedsPath!, 'utf8')) as Seed[];
const original = (n: number) => readFileSync(join(source!, 'chapters', file(n)), 'utf8');
validateSeeds(seeds, original);

cpSync(source!, dest!, { recursive: true, filter: (p) => !relative(source!, p).startsWith('review') });
for (const s of seeds) {
  const path = join(dest!, 'chapters', file(s.chapter));
  writeFileSync(path, applySeed(readFileSync(path, 'utf8'), s));
}
writeFileSync(join(dest!, 'ground-truth.json'), JSON.stringify(groundTruth(seeds), null, 2) + '\n');
const distances = seeds.map((s) => s.chapter - Math.max(...s.sources.map((x) => x.chapter)));
console.log(`오류 ${seeds.length}개를 ${new Set(seeds.map((s) => s.chapter)).size}화에 심었습니다 → ${dest}`);
console.log(`근거 거리: 10화 이내 ${distances.filter((d) => d <= 10).length}개, 50화 이상 ${distances.filter((d) => d >= 50).length}개, 그 사이 ${distances.filter((d) => d > 10 && d < 50).length}개`);
