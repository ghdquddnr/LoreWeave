import '../src/dom.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCorpus } from '../corpus/cases.ts';
import { checkCase } from '../src/roundtrip.ts';
import { customConverter, parseInline, serializeInline } from '../src/serializers/custom.ts';
import { COMBOS, throughEditor } from '../src/serializers/index.ts';

const corpus = loadCorpus().filter((c) => !c.exception);

test('(c) 직접 작성 · C3는 모든 비예외 코퍼스에서 byte 동일·멱등·국소적이다', () => {
  const converter = throughEditor(customConverter());
  for (const c of corpus) {
    const r = checkCase(converter, c.id, c.raw);
    assert.equal(r.error, undefined, c.id);
    assert.equal(r.exact, true, c.id);
    assert.equal(r.idempotent, true, c.id);
    assert.deepEqual(r.nonLocal, [], c.id);
  }
});

test('모든 조합이 코퍼스 전체에서 예외 없이 동작한다', () => {
  for (const combo of COMBOS) {
    const converter = throughEditor(combo.create());
    for (const c of corpus) assert.equal(checkCase(converter, c.id, c.raw).error, undefined, `${combo.id} ${c.id}`);
  }
});

test('(c) 강조 인식 규칙', () => {
  const marks = (text: string) => parseInline(text).map((n) => [n.text, (n.marks ?? []).map((m) => m.type).join('+')]);
  assert.deepEqual(marks('그건 **절대** 안 된다.'), [['그건 ', ''], ['절대', 'bold'], [' 안 된다.', '']]);
  assert.deepEqual(marks('***정말로***'), [['정말로', 'bold+italic']]);
  assert.deepEqual(marks('**"대사"**를'), [['"대사"', 'bold'], ['를', '']]);
  assert.deepEqual(marks('**닫히지 않은 강조.'), [['**닫히지 않은 강조.', '']]);
  assert.deepEqual(marks('별표 * 하나와 ** 둘.'), [['별표 * 하나와 ** 둘.', '']]);
  assert.deepEqual(marks('** 공백 뒤**'), [['** 공백 뒤**', '']]);
});

test('(c) 강조 앞뒤 공백은 구분자 밖으로 나간다', () => {
  const bold = [{ type: 'bold' }];
  assert.equal(serializeInline([{ type: 'text', text: ' 굵게 ', marks: bold }]), ' **굵게** ');
  assert.equal(serializeInline([{ type: 'text', text: '   ', marks: bold }]), '   ');
  const reparsed = parseInline(serializeInline([{ type: 'text', text: '굵게 ', marks: bold }, { type: 'text', text: '보통' }]));
  assert.deepEqual(reparsed.map((n) => n.text), ['굵게', ' 보통']);
});

test('(c) 블록 인식: 제목, 정확히 --- 인 구분선, 인용, 나머지는 문단', () => {
  const doc = customConverter().parse(['# 1화', '---', '***', '> 편지', '>', '>붙여 씀', ''].join('\n'));
  assert.deepEqual(
    doc.content!.map((n) => n.type),
    ['heading', 'horizontalRule', 'paragraph', 'blockquote', 'paragraph', 'paragraph'],
  );
  assert.equal(doc.content![3]!.content!.length, 2);
});
