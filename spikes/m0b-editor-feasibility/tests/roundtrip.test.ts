import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCorpus } from '../corpus/cases.ts';
import { classifyDiff } from '../src/diff.ts';
import { checkCase, type Converter, type PMNode } from '../src/roundtrip.ts';

// 하네스 검증용 변환기. 실제 비교 대상(a)(b)(c)는 다음 PR에서 추가한다.

/** 한 줄 = 한 문단. 어떤 입력이든 그대로 돌려준다. */
const lineModel: Converter = {
  name: 'line-model',
  parse: (body) => ({
    type: 'doc',
    content: body.split('\n').map((l) => ({ type: 'paragraph', content: l ? [{ type: 'text', text: l }] : [] })),
  }),
  serialize: (doc) => (doc.content ?? []).map((p) => (p.content ?? []).map((t) => t.text ?? '').join('')).join('\n'),
};

const derive = (name: string, map: (out: string) => string): Converter => ({
  name,
  parse: lineModel.parse,
  serialize: (doc) => map(lineModel.serialize(doc)),
});

const corpus = loadCorpus();
const raw = (id: string) => corpus.find((c) => c.id === id)!.raw;

test('손실 없는 변환기는 모든 비예외 코퍼스에서 통과한다', () => {
  for (const c of corpus.filter((c) => !c.exception)) {
    const r = checkCase(lineModel, c.id, c.raw);
    assert.equal(r.exact, true, c.id);
    assert.equal(r.idempotent, true, c.id);
    assert.deepEqual(r.nonLocal, [], c.id);
    assert.deepEqual(r.diff.kinds, [], c.id);
  }
});

test('빈 줄을 합치는 변환기: byte 불일치, blank-lines', () => {
  const r = checkCase(derive('collapse', (s) => s.replace(/\n{3,}/g, '\n\n')), 'blank-multi', raw('blank-multi'));
  assert.equal(r.exact, false);
  assert.equal(r.idempotent, true);
  assert.deepEqual(r.diff.kinds, ['blank-lines']);
});

test('매번 이스케이프를 더하는 변환기: 멱등성 실패, escape', () => {
  const r = checkCase(derive('escape', (s) => s.replace(/\*/g, '\\*')), 'special-inline', raw('special-inline'));
  assert.equal(r.exact, false);
  assert.equal(r.idempotent, false);
  assert.deepEqual(r.diff.kinds, ['escape']);
});

test('한 문단만 고쳐도 문서 전체를 바꾸는 변환기: 국소성 실패', () => {
  const touchesAll: Converter = {
    name: 'touches-all',
    parse: lineModel.parse,
    serialize: (doc: PMNode) => {
      const out = lineModel.serialize(doc);
      return out.includes('ⓧ') ? out.replace(/\.$/gm, '. ') : out;
    },
  };
  const r = checkCase(touchesAll, 'blank-single', raw('blank-single'));
  assert.equal(r.exact, true);
  // 빈 문단 2개는 시험하지 않는다
  assert.equal(r.paragraphs, 3);
  assert.deepEqual(r.nonLocal, [0, 2, 4]);
});

test('변환기 예외는 실패 결과로 기록된다', () => {
  const r = checkCase(derive('throws', () => { throw new Error('boom'); }), 'blank-single', raw('blank-single'));
  assert.equal(r.exact, false);
  assert.equal(r.error, 'boom');
});

test('diff 유형 분류', () => {
  assert.deepEqual(classifyDiff('a\n', 'a\n').kinds, []);
  assert.deepEqual(classifyDiff('a\r\nb\r\n', 'a\nb\n').kinds, ['eol']);
  assert.deepEqual(classifyDiff('\uFEFFa\n', 'a\n').kinds, ['bom']);
  assert.deepEqual(classifyDiff('a\n\n\nb\n', 'a\n\nb\n').kinds, ['blank-lines']);
  assert.deepEqual(classifyDiff('5*5\n', '5\\*5\n').kinds, ['escape']);
  assert.deepEqual(classifyDiff('A & B\n', 'A &amp; B\n').kinds, ['escape']);
  assert.deepEqual(classifyDiff('줄\u00A0바꿈\n', '줄 바꿈\n').kinds, ['whitespace']);
  assert.deepEqual(classifyDiff('끝  \n', '끝\n').kinds, ['whitespace']);
  assert.deepEqual(classifyDiff('**닫히지 않음\n', '닫히지 않음\n').kinds, ['text-loss']);
  assert.deepEqual(classifyDiff('가\n', '나\n').kinds, ['other']);
  const d = classifyDiff('하나\n둘\n셋\n', '하나\n2\n셋\n');
  assert.deepEqual(d.hunks, [{ kind: 'other', line: 2, expected: ['둘'], actual: ['2'] }]);
});
