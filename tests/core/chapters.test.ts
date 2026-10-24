import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chapterInfo,
  findDuplicateIds,
  isChapterFileName,
  newChapterText,
  nextChapterFile,
  readFrontmatterFields,
  setFrontmatterField,
  sortChapterFiles,
} from '../../src/core/project/chapters.ts';
import { openManuscript } from '../../src/core/manuscript/index.ts';

test('화 순서: 파일 이름 앞 번호의 숫자 순, 번호 없는 파일은 뒤에 이름 순', () => {
  assert.deepEqual(sortChapterFiles(['010.md', '9.md', '002-회상.md', '외전.md', '001.md', '가.md']), [
    '001.md',
    '002-회상.md',
    '9.md',
    '010.md',
    '가.md',
    '외전.md',
  ]);
});

test('새 화 번호: 가장 큰 번호 + 1, 3자리 0 채움, 1000부터 4자리', () => {
  assert.equal(nextChapterFile([]), '001.md');
  assert.equal(nextChapterFile(['001.md', '015.md', '외전.md']), '016.md');
  assert.equal(nextChapterFile(['999.md']), '1000.md');
});

test('화 파일 이름: 경로 구분자와 Windows 금지 문자 거부', () => {
  for (const ok of ['001.md', '1화 입학.md', '외전.md']) assert.ok(isChapterFileName(ok), ok);
  for (const bad of ['../001.md', 'a/b.md', 'a\\b.md', '001.txt', 'a:b.md', '.md', 'a?.md']) assert.ok(!isChapterFileName(bad), bad);
});

test('frontmatter 최상위 key: value 읽기', () => {
  assert.deepEqual(readFrontmatterFields('---\nid: abc\ntitle: "1화. 입학"\ntags:\n  - 학교\n# 메모: 무시\n---\n'), {
    id: 'abc',
    title: '1화. 입학',
  });
  assert.deepEqual(readFrontmatterFields(null), {});
});

test('표시 이름: frontmatter title → 첫 제목 → 파일 이름', () => {
  assert.deepEqual(chapterInfo('---\nid: x\ntitle: 첫 만남\n---\n# 1화\n', '001.md'), { title: '첫 만남', id: 'x' });
  assert.deepEqual(chapterInfo('# 1화. 입학\n\n본문\n', '001.md'), { title: '1화. 입학', id: null });
  assert.deepEqual(chapterInfo('본문만 있다\n', '002.md'), { title: '002', id: null });
});

test('새 화 내용: frontmatter + 빈 문단 하나, 저장하면 마지막 개행 유지', () => {
  const text = newChapterText('id-1', '16화');
  const m = openManuscript(text);
  assert.equal(m.envelope.frontmatter, '---\nid: id-1\ntitle: 16화\n---\n');
  assert.ok(m.envelope.finalNewline);
  assert.deepEqual(m.doc, { type: 'doc', content: [{ type: 'paragraph' }] });
});

test('중복 id 감지', () => {
  assert.deepEqual(
    findDuplicateIds([
      { file: '001.md', id: 'a' },
      { file: '002.md', id: 'b' },
      { file: '002 복사본.md', id: 'b' },
      { file: '003.md', id: null },
    ]),
    [['002.md', '002 복사본.md']],
  );
});

test('frontmatter 필드 바꾸기: 본문, BOM, CRLF는 그대로', () => {
  const raw = '\uFEFF---\r\nid: old\r\ntitle: 둘\r\n---\r\n본문 **그대로**\r\n';
  assert.equal(setFrontmatterField(raw, 'id', 'new'), '\uFEFF---\r\nid: new\r\ntitle: 둘\r\n---\r\n본문 **그대로**\r\n');
});

test('frontmatter 필드 바꾸기: 필드가 없으면 닫는 줄 앞에, frontmatter가 없으면 맨 앞에 만든다', () => {
  assert.equal(setFrontmatterField('---\ntitle: 셋\n---\n본문\n', 'id', 'x'), '---\ntitle: 셋\nid: x\n---\n본문\n');
  assert.equal(setFrontmatterField('# 1화\n본문\n', 'id', 'x'), '---\nid: x\n---\n# 1화\n본문\n');
});
