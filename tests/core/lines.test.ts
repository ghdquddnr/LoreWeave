// 줄 주소: 색인이 담는 줄과 에디터 블록이 1:1로 맞는가 (M2-PLAN 2절, M0-B H-B6)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseC3 } from '../../src/core/manuscript/c3.ts';
import type { Block, Doc, Inline } from '../../src/core/manuscript/doc.ts';
import { splitEnvelope } from '../../src/core/manuscript/envelope.ts';
import { lineToBlock, visibleLines } from '../../src/core/manuscript/lines.ts';
import { loadCorpus } from './fixtures/corpus.ts';

const textOf = (content: Inline[] = []) => content.map((n) => (n.type === 'text' ? n.text : '')).join('');
const blockText = (b: Block) => (b.type === 'paragraph' || b.type === 'heading' ? textOf(b.content) : '');

test('코퍼스 전체: 줄 수가 본문 줄 수와 같고, 줄마다 가리키는 블록의 글자가 색인 글자와 같다', () => {
  for (const c of loadCorpus()) {
    const { body } = splitEnvelope(c.raw);
    const doc = parseC3(body);
    const lines = visibleLines(doc);
    assert.equal(lines.length, body.split('\n').length, c.id);
    lines.forEach((text, line) => {
      const pos = lineToBlock(doc, line);
      assert.ok(pos, `${c.id} ${line}`);
      const block = doc.content![pos.block]!;
      const target = pos.child === null ? block : (block as Extract<Block, { type: 'blockquote' }>).content![pos.child]!;
      assert.equal(blockText(target), text, `${c.id} ${line}`);
    });
    assert.equal(lineToBlock(doc, lines.length), null, c.id);
  }
});

test('보이는 글자: 제목 표시 #, 인용 표시 >, 강조 구분자는 빠지고 구분선은 빈 줄', () => {
  const doc = parseC3(['# 1화', '그건 **절대** 안 돼', '---', '> 편지', '>'].join('\n'));
  assert.deepEqual(visibleLines(doc), ['1화', '그건 절대 안 돼', '', '편지', '']);
});

test('인용 안의 줄은 인용 블록과 안쪽 문단 번호로 가리킨다', () => {
  const doc = parseC3(['앞', '> 하나', '> 둘', '뒤'].join('\n'));
  assert.deepEqual(lineToBlock(doc, 2), { block: 1, child: 1, lineInBlock: 0 });
  assert.deepEqual(lineToBlock(doc, 3), { block: 2, child: null, lineInBlock: 0 });
});

test('강제 줄바꿈이 있는 에디터 문서도 저장될 줄 수대로 센다', () => {
  const doc: Doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '가' }, { type: 'hardBreak' }, { type: 'text', text: '나' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '다' }] },
    ],
  };
  assert.deepEqual(visibleLines(doc), ['가', '나', '다']);
  assert.deepEqual(lineToBlock(doc, 1), { block: 0, child: null, lineInBlock: 1 });
  assert.deepEqual(lineToBlock(doc, 2), { block: 1, child: null, lineInBlock: 0 });
});
