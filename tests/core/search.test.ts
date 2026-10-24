import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMatches, normalizeForSearch, snippet } from '../../src/core/search.ts';

const hits = (text: string, query: string) => findMatches(text, query).map((m) => text.slice(m.from, m.to));

test('2글자 이름을 찾는다', () => {
  assert.deepEqual(findMatches('김민수는 민수라고 불렸다', '민수'), [
    { from: 1, to: 3 },
    { from: 5, to: 7 },
  ]);
});

test('영문 대소문자는 무시하고 공백은 그대로 비교한다', () => {
  assert.deepEqual(hits('K테크와 k테크', 'k테크'), ['K테크', 'k테크']);
  assert.deepEqual(hits('김 민수, 김민수', '김민수'), ['김민수']);
});

test('NFD로 저장된 한글도 찾고, 위치는 원래 글자 기준이다', () => {
  const nfd = '그는 민수다'.normalize('NFD');
  const [m] = findMatches(nfd, '민수');
  assert.ok(m);
  assert.equal(nfd.slice(m.from, m.to).normalize('NFC'), '민수');
  assert.equal(normalizeForSearch(nfd), '그는 민수다');
});

test('겹치지 않게 앞에서부터, 빈 검색어는 결과 없음', () => {
  assert.deepEqual(hits('aaa', 'aa'), ['aa']);
  assert.deepEqual(findMatches('아무 글', ''), []);
});

test('이모지·결합 문자 덩어리 중간에서 끝나도 덩어리 전체를 잡는다', () => {
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  assert.deepEqual(hits(`가족 ${family} 끝`, '\u{1F468}'), [family]);
});

test('문맥: 앞뒤 radius 글자와 말줄임표', () => {
  const text = '0123456789민수0123456789';
  assert.deepEqual(snippet(text, { from: 10, to: 12 }, 3), { before: '…789', hit: '민수', after: '012…' });
  assert.deepEqual(snippet('민수', { from: 0, to: 2 }), { before: '', hit: '민수', after: '' });
});
