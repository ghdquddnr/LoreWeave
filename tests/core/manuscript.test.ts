// M0-PLAN §3의 round-trip 기준을 제품 코드에 그대로 건다: byte 동일, 멱등, 한 문단 수정의 국소성.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openManuscript, serializeManuscript, type Manuscript } from '../../src/core/manuscript/index.ts';
import type { Doc, Paragraph } from '../../src/core/manuscript/doc.ts';
import { loadCorpus } from './fixtures/corpus.ts';

const corpus = loadCorpus().filter((c) => !c.exception);
const MARKER = 'ⓧ';

function save(m: Manuscript): string {
  const result = serializeManuscript(m);
  assert.ok(result.ok, `저장 거부: ${JSON.stringify(result)}`);
  return result.text;
}

test('코퍼스 전체: 열고 그대로 저장하면 byte 동일', () => {
  for (const c of corpus) assert.equal(save(openManuscript(c.raw)), c.raw, c.id);
});

test('코퍼스 전체: 멱등', () => {
  for (const c of corpus) {
    const once = save(openManuscript(c.raw));
    assert.equal(save(openManuscript(once)), once, c.id);
  }
});

test('코퍼스 전체: 글자가 있는 문단 하나를 고치면 그 줄만 바뀐다', () => {
  for (const c of corpus) {
    const m = openManuscript(c.raw);
    const paragraphs = (m.doc.content ?? []).filter((b): b is Paragraph => b.type === 'paragraph');
    paragraphs.forEach((p, k) => {
      if (!p.content?.length) return;
      const doc = structuredClone(m.doc) as Doc;
      const target = doc.content!.filter((b): b is Paragraph => b.type === 'paragraph')[k]!;
      const last = target.content!.at(-1)!;
      if (last.type === 'text') last.text += MARKER;
      else target.content!.push({ type: 'text', text: MARKER });
      const text = save({ envelope: m.envelope, doc });
      assert.equal(text.split(MARKER).length, 2, `${c.id} 문단 ${k}`);
      assert.equal(text.replace(MARKER, ''), c.raw, `${c.id} 문단 ${k}`);
    });
  }
});

const paragraphDoc = (...content: Paragraph['content'][]): Doc => ({
  type: 'doc',
  content: content.map((c) => (c ? { type: 'paragraph', content: c } : { type: 'paragraph' })),
});
const envelope = openManuscript('').envelope;

test('저장 전 검사: 입력한 * 가 다시 열 때 기울임이 되면 저장하지 않는다', () => {
  const doc = paragraphDoc([{ type: 'text', text: '첫 줄' }], [{ type: 'text', text: '5*5=25, 그리고 2*3=6' }]);
  assert.deepEqual(serializeManuscript({ envelope, doc }), { ok: false, reason: 'changes-on-reopen', block: 1 });
});

test('저장 전 검사: 강제 줄바꿈은 다시 열면 두 문단이 되므로 저장하지 않는다', () => {
  const doc = paragraphDoc([{ type: 'text', text: '가' }, { type: 'hardBreak' }, { type: 'text', text: '나' }]);
  assert.deepEqual(serializeManuscript({ envelope, doc }), { ok: false, reason: 'changes-on-reopen', block: 0 });
});

test('저장 전 검사: 인용 안의 제목은 다시 열면 문단이 되므로 저장하지 않는다', () => {
  const doc: Doc = {
    type: 'doc',
    content: [{ type: 'blockquote', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '편지' }] }] }],
  };
  assert.equal(serializeManuscript({ envelope, doc }).ok, false);
});

test('저장 전 검사: 같은 내용의 다른 모양은 통과한다 (공백 포함 강조, 쪼개진 글자 노드)', () => {
  const bold = [{ type: 'bold' as const }];
  const doc = paragraphDoc([
    { type: 'text', text: '그건' },
    { type: 'text', text: ' 절대 ', marks: bold },
    { type: 'text', text: '안 ' },
    { type: 'text', text: '된다.' },
  ]);
  assert.deepEqual(serializeManuscript({ envelope, doc }), { ok: true, text: '그건 **절대** 안 된다.' });
});
