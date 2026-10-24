import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCorpus, PERF_SIZES, perfText } from '../corpus/cases.ts';
import { EDIT_MARKER } from '../src/roundtrip.ts';

const corpus = loadCorpus();
const byId = new Map(corpus.map((c) => [c.id, c]));

test('코퍼스는 40개 이상이고 id가 겹치지 않는다', () => {
  assert.ok(corpus.length >= 40, `${corpus.length}개`);
  assert.equal(byId.size, corpus.length);
  for (const c of corpus) assert.match(c.id, /^[a-z0-9-]+$/);
});

test('M0-A 챕터 15개를 포함한다', () => {
  assert.equal(corpus.filter((c) => c.group === 'm0a').length, 15);
});

test('수정 표식 글자는 코퍼스에 없다', () => {
  for (const c of corpus) assert.ok(!c.raw.includes(EDIT_MARKER), c.id);
});

test('줄바꿈·BOM 사례가 의도한 바이트를 갖는다', () => {
  const crlfOnly = (s: string) => s.includes('\r\n') && !/(?<!\r)\n/.test(s);
  assert.ok(crlfOnly(byId.get('eol-crlf')!.raw));
  assert.ok(crlfOnly(byId.get('eol-bom-crlf')!.raw));
  assert.ok(byId.get('eol-bom-crlf')!.raw.startsWith('﻿'));
  const mixed = byId.get('eol-mixed')!.raw;
  assert.ok(mixed.includes('\r\n') && /(?<!\r)\n/.test(mixed));
  assert.ok(!byId.get('eol-no-final-newline')!.raw.endsWith('\n'));
  for (const c of corpus.filter((c) => !c.id.includes('crlf') && c.id !== 'eol-mixed')) {
    assert.ok(!c.raw.includes('\r'), c.id);
  }
});

test('보이지 않는 문자 사례가 해당 문자를 갖는다', () => {
  const raw = byId.get('chars-invisible')!.raw;
  for (const ch of ['　', ' ', '​', '‍']) assert.ok(raw.includes(ch), ch);
  assert.ok(byId.get('chars-indent-trailing')!.raw.includes('\t'));
  assert.ok(byId.get('chars-indent-trailing')!.raw.includes('  \n'));
});

test('성능 원고는 요청한 길이 이상이고 문단으로 끝난다', () => {
  for (const size of PERF_SIZES.slice(0, 3)) {
    const text = perfText(size);
    assert.ok(text.length >= size, `${size}`);
    assert.ok(text.length < size + 2_000, `${size}: ${text.length}`);
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
  }
});
