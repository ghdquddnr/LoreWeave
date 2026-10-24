// main의 파일 입출력. Electron 없이 임시 폴더에서 실제 파일로 확인한다.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createChapter, listChapters, NotUtf8Error, readChapter, writeChapter } from '../../src/main/project-files.ts';

let root: string;
const chapter = (file: string) => join(root, 'chapters', file);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loreweave-'));
  await mkdir(join(root, 'chapters'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('목록: 번호 순, 표시 이름, UTF-8이 아닌 파일 표시, 중복 id', async () => {
  await writeFile(chapter('010.md'), '# 10화\n');
  await writeFile(chapter('002.md'), '---\nid: same\ntitle: 둘\n---\n');
  await writeFile(chapter('003.md'), '---\nid: same\n---\n');
  await writeFile(chapter('001.md'), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x0a])); // CP949 "한글"
  await writeFile(chapter('메모.txt'), '무시');
  const { chapters, duplicateIds } = await listChapters(root);
  assert.deepEqual(
    chapters.map((c) => [c.file, c.title, c.unreadable]),
    [
      ['001.md', '001', true],
      ['002.md', '둘', false],
      ['003.md', '003', false],
      ['010.md', '10화', false],
    ],
  );
  assert.deepEqual(duplicateIds, [['002.md', '003.md']]);
});

test('chapters 폴더가 없으면 빈 목록', async () => {
  await rm(join(root, 'chapters'), { recursive: true });
  assert.deepEqual(await listChapters(root), { chapters: [], duplicateIds: [] });
});

test('읽기: BOM과 CRLF를 그대로 돌려준다', async () => {
  await writeFile(chapter('001.md'), '\uFEFF본문\r\n');
  const { text } = await readChapter(root, '001.md');
  assert.equal(text, '\uFEFF본문\r\n');
});

test('읽기: UTF-8이 아닌 파일은 거부한다', async () => {
  await writeFile(chapter('001.md'), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]));
  await assert.rejects(readChapter(root, '001.md'), NotUtf8Error);
});

test('읽기·쓰기: chapters 밖의 경로는 거부한다', async () => {
  await assert.rejects(readChapter(root, '../secret.md'), /잘못된 화 파일 이름/);
  await assert.rejects(writeChapter(root, '..\\x.md', '', 'h'), /잘못된 화 파일 이름/);
});

test('쓰기: 해시가 맞으면 저장하고 임시 파일을 남기지 않는다', async () => {
  await writeFile(chapter('001.md'), '처음\n');
  const { hash } = await readChapter(root, '001.md');
  const result = await writeChapter(root, '001.md', '\uFEFF고침\r\n', hash);
  assert.equal(result.status, 'saved');
  assert.deepEqual(await readFile(chapter('001.md')), Buffer.from('\uFEFF고침\r\n', 'utf8'));
  assert.deepEqual(await readdir(join(root, 'chapters')), ['001.md']);
  // 저장 후 받은 해시로 이어서 저장할 수 있다
  assert.equal((await writeChapter(root, '001.md', '또 고침\n', result.status === 'saved' ? result.hash : '')).status, 'saved');
});

test('쓰기: 다른 프로그램이 바꾼 파일은 덮어쓰지 않는다', async () => {
  await writeFile(chapter('001.md'), '처음\n');
  const { hash } = await readChapter(root, '001.md');
  await writeFile(chapter('001.md'), '다른 편집기에서 고침\n');
  const result = await writeChapter(root, '001.md', '내 수정\n', hash);
  assert.equal(result.status, 'conflict');
  assert.equal(await readFile(chapter('001.md'), 'utf8'), '다른 편집기에서 고침\n');
});

test('쓰기: 파일이 사라졌으면 conflict (diskHash null)', async () => {
  await writeFile(chapter('001.md'), '처음\n');
  const { hash } = await readChapter(root, '001.md');
  await rm(chapter('001.md'));
  assert.deepEqual(await writeChapter(root, '001.md', '내 수정\n', hash), { status: 'conflict', diskHash: null });
});

test('새 화: 다음 번호, id와 제목, 바로 읽은 해시와 같음', async () => {
  await writeFile(chapter('001.md'), '# 1화\n');
  const created = await createChapter(root);
  assert.equal(created.file, '002.md');
  assert.match(created.text, /^---\nid: [0-9a-f-]{36}\ntitle: 2화\n---\n\n$/);
  assert.deepEqual(await readChapter(root, '002.md'), { text: created.text, hash: created.hash });
});

test('새 화: chapters 폴더가 없으면 만든다', async () => {
  await rm(join(root, 'chapters'), { recursive: true });
  assert.equal((await createChapter(root)).file, '001.md');
});
