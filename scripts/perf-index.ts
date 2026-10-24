// 색인·검색 성능 (M2-PLAN 5절): 300화·1000화 첫 색인, 다시 열 때, 저장 후 재색인, 검색 p95.
// 사용: pnpm perf:index   (화당 약 5천 자, M0-A 본문을 이어 붙여 만든다)

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManuscriptIndex } from '../src/main/index-db.ts';
import { indexChapterText, searchIndex, syncIndex } from '../src/main/indexer.ts';

const M0A = join(__dirname, '../spikes/m0a-ai-feasibility/benchmark/chapters');
const CHARS_PER_CHAPTER = 5000;
const QUERIES = ['민수', '지현', '성진', '김정호', '25.5%', '할머니', '판교', '옥상', '이', '다.', '사장님', 'CTO', '없는 말'];

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;
const ms = (x: number) => `${x.toFixed(x < 10 ? 1 : 0)}ms`;

async function time<T>(work: () => Promise<T> | T): Promise<[number, T]> {
  const start = performance.now();
  const result = await work();
  return [performance.now() - start, result];
}

async function makeProject(count: number, paragraphs: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `loreweave-perf-${count}-`));
  await mkdir(join(root, 'chapters'));
  let p = 0;
  for (let n = 1; n <= count; n++) {
    let text = `# ${n}화\n`;
    while (text.length < CHARS_PER_CHAPTER) text += `\n${paragraphs[p++ % paragraphs.length]}\n`;
    await writeFile(join(root, 'chapters', `${String(n).padStart(3, '0')}.md`), text);
  }
  return root;
}

async function measure(count: number, paragraphs: string[]): Promise<string[]> {
  const root = await makeProject(count, paragraphs);
  try {
    const index = ManuscriptIndex.open(root);
    const [first] = await time(() => syncIndex(index, root));
    index.close();
    const reopened = ManuscriptIndex.open(root);
    const [again, result] = await time(() => syncIndex(reopened, root));
    if (result.reindexed !== 0) throw new Error('변경 없는데 다시 색인함');

    const file = '001.md';
    const text = (await readFile(join(root, 'chapters', file), 'utf8')) + '\n민수가 새로 쓴 줄\n';
    await writeFile(join(root, 'chapters', file), text);
    const info = await stat(join(root, 'chapters', file));
    const [reindex] = await time(() => indexChapterText(reopened, file, text, info.mtimeMs, info.size));

    const searches: number[] = [];
    for (let rep = 0; rep < 5; rep++) {
      for (const q of QUERIES) searches.push((await time(() => searchIndex(reopened, q)))[0]);
    }
    const total = searchIndex(reopened, '민수').total;
    reopened.close();
    return [
      `| ${count}화 (${((count * CHARS_PER_CHAPTER) / 1e6).toFixed(1)}백만 자) | ${ms(first)} | ${ms(again)} | ${ms(reindex)} | ${ms(p95(searches))} | ${total} |`,
    ];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const sources = (await readdir(M0A)).filter((f) => f.endsWith('.md')).sort();
  const paragraphs = (await Promise.all(sources.map((f) => readFile(join(M0A, f), 'utf8'))))
    .flatMap((t) => t.split('\n\n'))
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('#'));
  console.log('| 원고 | 첫 색인 | 다시 열 때 (변경 없음) | 저장 후 재색인 | 검색 p95 (13개 × 5회) | "민수" 찾은 줄 |');
  console.log('|---|---|---|---|---|---|');
  for (const count of [300, 1000]) for (const row of await measure(count, paragraphs)) console.log(row);
  console.log('\n기준: 300화 첫 색인 < 2초, 다시 열 때 < 300ms, 재색인 < 50ms, 1000화 검색 p95 < 200ms');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
