import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseC3, parseInline, serializeC3, serializeInline } from '../../src/core/manuscript/c3.ts';
import type { Inline } from '../../src/core/manuscript/doc.ts';

const marks = (text: string) =>
  parseInline(text).map((n) => (n.type === 'text' ? [n.text, (n.marks ?? []).map((m) => m.type).join('+')] : [n.type]));

test('강조 인식: 굵게, 기울임, 둘 다', () => {
  assert.deepEqual(marks('그건 **절대** 안 된다.'), [['그건 ', ''], ['절대', 'bold'], [' 안 된다.', '']]);
  assert.deepEqual(marks('*아마도* 그럴 것이다.'), [['아마도', 'italic'], [' 그럴 것이다.', '']]);
  assert.deepEqual(marks('***정말로***'), [['정말로', 'bold+italic']]);
});

test('강조 인식: 한국어 따옴표·조사에 붙어도 굵게', () => {
  assert.deepEqual(marks('**"대사"**를'), [['"대사"', 'bold'], ['를', '']]);
  assert.deepEqual(marks('정말**진짜**로'), [['정말', ''], ['진짜', 'bold'], ['로', '']]);
});

test('강조가 아닌 별표는 글자 그대로', () => {
  assert.deepEqual(marks('**닫히지 않은 강조.'), [['**닫히지 않은 강조.', '']]);
  assert.deepEqual(marks('별표 * 하나와 ** 둘.'), [['별표 * 하나와 ** 둘.', '']]);
  assert.deepEqual(marks('** 공백 뒤**'), [['** 공백 뒤**', '']]);
});

test('의미 해석 위험 (ADR 0002): 겹친 별표는 안쪽이 기울임으로 읽힌다. 바이트는 그대로', () => {
  assert.deepEqual(marks('**굵게 *안에 별표**'), [['**굵게 ', ''], ['안에 별표', 'italic'], ['*', '']]);
  assert.deepEqual(marks('5*5=25, 그리고 2*3=6'), [['5', ''], ['5=25, 그리고 2', 'italic'], ['3=6', '']]);
});

test('블록: 제목, 정확히 --- 인 구분선, 인용, 나머지는 문단', () => {
  const doc = parseC3(['# 1화', '---', '***', '> 편지', '>', '>붙여 씀', '#해시태그', ''].join('\n'));
  assert.deepEqual(
    doc.content!.map((b) => b.type),
    ['heading', 'horizontalRule', 'paragraph', 'blockquote', 'paragraph', 'paragraph', 'paragraph'],
  );
  const quote = doc.content![3]!;
  assert.equal(quote.type === 'blockquote' && quote.content!.length, 2);
});

test('빈 줄은 내용 없는 문단, 빈 본문은 빈 문단 하나', () => {
  assert.deepEqual(parseC3('가\n\n나').content![1], { type: 'paragraph' });
  assert.deepEqual(parseC3(''), { type: 'doc', content: [{ type: 'paragraph' }] });
  assert.equal(serializeC3({ type: 'doc', content: [{ type: 'paragraph' }] }), '');
});

test('강조 앞뒤 공백은 구분자 밖으로 나간다', () => {
  const bold = [{ type: 'bold' as const }];
  assert.equal(serializeInline([{ type: 'text', text: ' 굵게 ', marks: bold }]), ' **굵게** ');
  assert.equal(serializeInline([{ type: 'text', text: '   ', marks: bold }]), '   ');
});

test('강제 줄바꿈은 다음 줄이 되고, 인용 안에서는 줄마다 > 를 붙인다', () => {
  const lines: Inline[] = [{ type: 'text', text: '가' }, { type: 'hardBreak' }, { type: 'text', text: '나' }];
  assert.equal(serializeC3({ type: 'doc', content: [{ type: 'paragraph', content: lines }] }), '가\n나');
  assert.equal(
    serializeC3({ type: 'doc', content: [{ type: 'blockquote', content: [{ type: 'paragraph', content: lines }, { type: 'paragraph' }] }] }),
    '> 가\n> 나\n>',
  );
});
