import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectLineEnding, joinEnvelope, splitEnvelope } from '../../src/core/manuscript/envelope.ts';
import { loadCorpus } from './fixtures/corpus.ts';

const corpus = loadCorpus();
const raw = (id: string) => corpus.find((c) => c.id === id)!.raw;

test('줄바꿈이 섞이지 않은 모든 코퍼스에서 join(split(x)) == x', () => {
  for (const c of corpus.filter((c) => !c.exception)) {
    const { envelope, body } = splitEnvelope(c.raw);
    assert.equal(joinEnvelope(envelope, body), c.raw, c.id);
  }
});

test('본문은 LF로 맞추고 BOM·frontmatter·마지막 개행을 뗀다', () => {
  const { envelope, body } = splitEnvelope(raw('fm-korean-bom-crlf'));
  assert.deepEqual(envelope, {
    bom: true,
    lineEnding: '\r\n',
    frontmatter: '---\n제목: 2화\n작성일: 2026-10-24\n---\n',
    finalNewline: true,
  });
  assert.equal(body, '본문.');
});

test('frontmatter 판별', () => {
  assert.ok(splitEnvelope(raw('fm-basic')).envelope.frontmatter?.endsWith('---\n'));
  assert.equal(splitEnvelope(raw('fm-scene-break-start')).envelope.frontmatter, null);
  assert.equal(splitEnvelope(raw('scene-breaks')).envelope.frontmatter, null);
  assert.equal(splitEnvelope('---\n그가 말했다: 안녕\n---\n본문\n').envelope.frontmatter, null);
  assert.equal(splitEnvelope('---\n\n---\n').envelope.frontmatter, null);
  assert.equal(splitEnvelope('---\nid: 1\n본문은 닫는 줄이 없다\n').envelope.frontmatter, null);
  assert.equal(splitEnvelope('---\nk: v\n---').envelope.frontmatter, '---\nk: v\n---');
});

test('줄바꿈 판별', () => {
  assert.equal(detectLineEnding('a\nb\n'), '\n');
  assert.equal(detectLineEnding('a\r\nb\r\n'), '\r\n');
  assert.equal(detectLineEnding('a\r\nb\n'), 'mixed');
  assert.equal(detectLineEnding('a\rb'), 'mixed');
  assert.equal(detectLineEnding(''), '\n');
});

test('줄바꿈이 섞인 파일은 LF로 저장된다', () => {
  const { envelope, body } = splitEnvelope(raw('eol-mixed'));
  assert.equal(envelope.lineEnding, 'mixed');
  assert.equal(joinEnvelope(envelope, body), '첫 줄.\n\n둘째 줄.\n\n셋째 줄.\n');
});
