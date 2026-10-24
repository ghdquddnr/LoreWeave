import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCorpus } from '../corpus/cases.ts';
import { detectEol, join, split } from '../src/envelope.ts';

const corpus = loadCorpus();
const raw = (id: string) => corpus.find((c) => c.id === id)!.raw;

test('예외가 아닌 모든 코퍼스에서 join(split(x)) == x', () => {
  for (const c of corpus.filter((c) => !c.exception)) {
    const { envelope, body } = split(c.raw);
    assert.equal(join(envelope, body), c.raw, c.id);
  }
});

test('본문은 LF로 정규화되고 BOM·frontmatter·마지막 개행이 빠진다', () => {
  const { envelope, body } = split(raw('fm-korean-bom-crlf'));
  assert.deepEqual(envelope, {
    bom: true,
    eol: '\r\n',
    frontmatter: '---\n제목: 2화\n작성일: 2026-10-24\n---\n',
    finalNewline: true,
  });
  assert.equal(body, '본문.');
});

test('frontmatter 판별', () => {
  assert.ok(split(raw('fm-basic')).envelope.frontmatter?.endsWith('---\n'));
  assert.equal(split(raw('fm-scene-break-start')).envelope.frontmatter, null);
  assert.equal(split(raw('scene-breaks')).envelope.frontmatter, null);
  assert.equal(split('---\n그가 말했다: 안녕\n---\n본문\n').envelope.frontmatter, null);
  assert.equal(split('---\n\n---\n').envelope.frontmatter, null);
  assert.equal(split('---\nk: v\n---').envelope.frontmatter, '---\nk: v\n---');
});

test('줄바꿈 판별', () => {
  assert.equal(detectEol('a\nb\n'), '\n');
  assert.equal(detectEol('a\r\nb\r\n'), '\r\n');
  assert.equal(detectEol('a\r\nb\n'), 'mixed');
  assert.equal(detectEol('a\rb'), 'mixed');
  assert.equal(detectEol(''), '\n');
});

test('혼합 줄바꿈은 LF로 저장된다 (문서화된 예외)', () => {
  const { envelope, body } = split(raw('eol-mixed'));
  assert.equal(envelope.eol, 'mixed');
  assert.equal(join(envelope, body), '첫 줄.\n\n둘째 줄.\n\n셋째 줄.\n');
});
