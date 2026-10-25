// 150화 긴 시험 원고(chapters.json)를 원고 폴더로 푼다 (M5-PLAN 2절). 앱으로 열거나 채점기에 줄 수 있다.
//   pnpm tsx scripts/unpack-long-benchmark.ts <출력 폴더>
// 출력 폴더에 chapters/NNN.md와 ground-truth.json을 쓴다.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PACKED_FILE, unpackChapters } from './lib/long-benchmark.ts';

const BENCHMARK = resolve('spikes/m5-scale/benchmark');

export function unpackLongBenchmark(dest: string): void {
  const files = unpackChapters(readFileSync(join(BENCHMARK, PACKED_FILE), 'utf8'));
  mkdirSync(join(dest, 'chapters'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dest, 'chapters', name), text);
  copyFileSync(join(BENCHMARK, 'ground-truth.json'), join(dest, 'ground-truth.json'));
}

if (require.main === module) {
  const dest = process.argv[2];
  if (!dest) {
    console.error('사용: pnpm tsx scripts/unpack-long-benchmark.ts <출력 폴더>');
    process.exit(1);
  }
  unpackLongBenchmark(resolve(dest));
  console.log(`150화와 정답표를 ${resolve(dest)}에 풀었습니다`);
}
