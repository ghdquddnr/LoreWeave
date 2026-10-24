// 코퍼스를 실제 파일로 쓴다: VS Code 미리보기·Obsidian 렌더링 비교와 수동 검증용.
// 출력(out/)은 커밋하지 않는다.

import { mkdirSync, writeFileSync } from 'node:fs';
import { loadCorpus, PERF_SIZES, perfText } from '../corpus/cases.ts';

const OUT = new URL('../out/', import.meta.url);

const cases = loadCorpus();
for (const c of cases) {
  const dir = new URL(`corpus/${c.group}/`, OUT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(`${c.id}.md`, dir), c.raw, 'utf8');
}

mkdirSync(new URL('perf/', OUT), { recursive: true });
for (const size of PERF_SIZES) {
  writeFileSync(new URL(`perf/perf-${size}.md`, OUT), perfText(size), 'utf8');
}

console.log(`${cases.length}개 코퍼스, ${PERF_SIZES.length}개 성능 원고 → ${OUT.pathname}`);
