// .txt 장편을 원고 폴더(chapters/NNN.md)로 바꾼다 (M6-PLAN 2절). API 호출 없음.
//   pnpm tsx scripts/import-txt.ts <.txt가 있는 폴더> <만들 원고 폴더> [--chars 5000]
// 원고는 저장소에 넣지 않으므로, 만들 폴더가 저장소 안이면 멈춘다.
// 권 파일은 이름 순서(숫자는 숫자로)로 잇는다. 변환 전후 글자 수(공백 제외)가 같은지 확인한다.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { chapterText, decodeText, naturalCompare, sanitizeLine, splitChapters, splitLines, visibleChars } from './lib/import-txt.ts';

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const args = process.argv.slice(2);
const [source, dest] = args;
if (!source || !dest) {
  console.error('사용: pnpm tsx scripts/import-txt.ts <.txt 폴더> <만들 원고 폴더> [--chars 5000]');
  process.exit(1);
}
const target = Number(option(args, '--chars') ?? '5000');
const out = resolve(dest);
if (!relative(process.cwd(), out).startsWith('..')) {
  console.error('원고 폴더는 저장소 밖에 만들어야 합니다 (원고를 커밋하지 않기 위해)');
  process.exit(1);
}
if (existsSync(join(out, 'chapters')) && readdirSync(join(out, 'chapters')).length) {
  console.error(`${join(out, 'chapters')}가 비어 있지 않습니다. 지우고 다시 실행하세요.`);
  process.exit(1);
}

const files = readdirSync(resolve(source))
  .filter((f) => f.toLowerCase().endsWith('.txt'))
  .sort(naturalCompare);
let sourceChars = 0;
const volumes = files.map((f) => {
  const { text, encoding } = decodeText(readFileSync(join(resolve(source), f)));
  const lines = splitLines(text).map(sanitizeLine);
  const chars = lines.reduce((n, l) => n + visibleChars(l), 0);
  sourceChars += chars;
  console.log(`권 ${files.indexOf(f) + 1}: ${encoding}, ${lines.length}줄, ${chars.toLocaleString()}자`);
  return lines;
});

const chapters = splitChapters(volumes, { target });
mkdirSync(join(out, 'chapters'), { recursive: true });
const sizes: number[] = [];
let written = 0;
chapters.forEach((lines, i) => {
  const n = i + 1;
  writeFileSync(join(out, 'chapters', `${String(n).padStart(3, '0')}.md`), chapterText(n, lines));
  const chars = lines.reduce((s, l) => s + visibleChars(l), 0);
  sizes.push(chars);
  written += chars;
});
console.log(`권 ${files.length}개 → 화 ${chapters.length}개 (${out})`);
console.log(`화당 ${Math.min(...sizes)}~${Math.max(...sizes)}자, 평균 ${Math.round(written / sizes.length)}자 (공백 제외)`);
if (written !== sourceChars) {
  console.error(`글자 수가 다릅니다: 원문 ${sourceChars}, 화 파일 ${written}`);
  process.exit(1);
}
console.log(`글자 수 확인: 원문과 같음 (${written.toLocaleString()}자)`);
