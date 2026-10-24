// 색인과 검색 (M2-PLAN 3·4·5절). Electron 없이 임시 폴더의 실제 파일과 node:sqlite로 확인한다.

import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';
import { parseC3 } from '../../src/core/manuscript/c3.ts';
import { splitEnvelope } from '../../src/core/manuscript/envelope.ts';
import { visibleLines } from '../../src/core/manuscript/lines.ts';
import { findMatches } from '../../src/core/search.ts';
import { ManuscriptIndex } from '../../src/main/index-db.ts';
import { searchIndex, syncIndex } from '../../src/main/indexer.ts';
import { readChapter, reissueChapterId } from '../../src/main/project-files.ts';

const M0A = join(__dirname, '../../spikes/m0a-ai-feasibility/benchmark/chapters');
let root: string;
let index: ManuscriptIndex | null = null;
const chapter = (file: string) => join(root, 'chapters', file);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loreweave-index-'));
  await mkdir(join(root, 'chapters'));
  for (const f of await readdir(M0A)) await copyFile(join(M0A, f), chapter(f.replace(/^ch/, '0')));
});

afterEach(async () => {
  index?.close();
  index = null;
  await rm(root, { recursive: true, force: true });
});

async function openSynced(): Promise<ManuscriptIndex> {
  index = ManuscriptIndex.open(root);
  await syncIndex(index, root);
  return index;
}

/** 파일을 직접 읽어 훑은 결과: [파일, 줄, 줄 글자] */
async function bruteForce(query: string): Promise<[string, number, string][]> {
  const out: [string, number, string][] = [];
  for (const file of (await readdir(join(root, 'chapters'))).sort()) {
    const lines = visibleLines(parseC3(splitEnvelope(await readFile(chapter(file), 'utf8')).body));
    lines.forEach((text, line) => {
      if (findMatches(text, query).length) out.push([file, line, text]);
    });
  }
  return out;
}

const QUERIES = ['민수', '지현', '성진', '김정호', '25.5%', '"', '할머니', '판교', '옥상', '스타트라인',
  '이', '다.', '1화', '07학번', '사장님', 'CTO', 'cto', '부산', '없는 말', '…'];

test('검색 정확도: 검색어 20개의 결과가 파일을 직접 훑은 결과와 같다 (2글자 이름 포함)', async () => {
  const i = await openSynced();
  for (const q of QUERIES) {
    const expected = await bruteForce(q);
    const result = searchIndex(i, q);
    assert.equal(result.total, expected.length, q);
    assert.deepEqual(
      result.hits.map((h) => [h.file, h.line, h.text]),
      expected.slice(0, 500),
      q,
    );
    for (const h of result.hits) assert.ok(h.matches.length > 0, `${q} ${h.file}:${h.line}`);
  }
  assert.ok(searchIndex(i, '민수').total > 100);
});

test('결과는 화 번호 순서 (9.md가 010.md보다 앞), 번호 없는 화는 뒤', async () => {
  await writeFile(chapter('9.md'), '민수 아홉\n');
  await writeFile(chapter('외전.md'), '민수 외전\n');
  const files = [...new Set(searchIndex(await openSynced(), '민수').hits.map((h) => h.file))];
  assert.deepEqual(files.slice(0, 1), ['001.md']);
  assert.ok(files.indexOf('9.md') < files.indexOf('010.md'));
  assert.equal(files.at(-1), '외전.md');
});

test('동기화: 바뀐 화만 다시 읽고, 추가·삭제를 반영한다', async () => {
  const i = await openSynced();
  assert.deepEqual(await syncIndex(i, root), { reindexed: 0, removed: 0 });
  await writeFile(chapter('002.md'), '바깥에서 고친 둘째 화 민수\n');
  await utimes(chapter('002.md'), new Date(), new Date(Date.now() + 5000));
  await rm(chapter('003.md'));
  await writeFile(chapter('016.md'), '새로 생긴 화\n');
  assert.deepEqual(await syncIndex(i, root), { reindexed: 2, removed: 1 });
  assert.deepEqual(searchIndex(i, '고친 둘째').hits.map((h) => h.file), ['002.md']);
  assert.equal(searchIndex(i, '새로 생긴').total, 1);
  assert.equal(searchIndex(i, 'MT').hits.some((h) => h.file === '003.md'), false);
});

test('UTF-8이 아닌 화는 색인하지 않는다', async () => {
  await writeFile(chapter('020.md'), Buffer.from([0xb9, 0xce, 0xbc, 0xf6])); // CP949 "민수"
  const i = await openSynced();
  assert.equal(searchIndex(i, '민수').hits.some((h) => h.file === '020.md'), false);
});

test('NFD로 저장된 화도 찾는다', async () => {
  await writeFile(chapter('030.md'), 'macOS에서 쓴 민수 이야기\n'.normalize('NFD'));
  const hit = searchIndex(await openSynced(), '민수 이야기').hits.find((h) => h.file === '030.md');
  assert.ok(hit);
  assert.equal(hit.text.slice(hit.matches[0]!.from, hit.matches[0]!.to).normalize('NFC'), '민수 이야기');
});

test('색인 파일이 깨졌거나 형식 버전이 다르면 지우고 다시 만든다', async () => {
  (await openSynced()).close();
  index = null;
  await writeFile(join(root, '.loreweave', 'index.db'), '깨진 파일');
  assert.equal(searchIndex(await openSynced(), '민수').total > 0, true);
  index!.close();
  const raw = new DatabaseSync(join(root, '.loreweave', 'index.db'));
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  index = ManuscriptIndex.open(root);
  assert.deepEqual(index.chapters().size, 0);
});

test('색인은 화 파일을 바꾸지 않고, .loreweave에 .gitignore를 둔다', async () => {
  const before = new Map<string, Buffer>();
  for (const f of await readdir(join(root, 'chapters'))) before.set(f, await readFile(chapter(f)));
  await openSynced();
  for (const [f, bytes] of before) assert.deepEqual(await readFile(chapter(f)), bytes, f);
  assert.equal(await readFile(join(root, '.loreweave', '.gitignore'), 'utf8'), 'index.db*\n');
});

test('id 재발급: frontmatter id만 바뀌고 본문 바이트는 그대로', async () => {
  await writeFile(chapter('050.md'), '\uFEFF---\r\nid: dup\r\ntitle: 오십\r\n---\r\n본문 **그대로**\r\n');
  const { id, text } = await reissueChapterId(root, '050.md');
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(text, `\uFEFF---\r\nid: ${id}\r\ntitle: 오십\r\n---\r\n본문 **그대로**\r\n`);
  assert.equal((await readChapter(root, '050.md')).text, text);
});
