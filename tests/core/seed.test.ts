// 원고 복사본에 오류 심기 (M7-PLAN 2절). 지어낸 문장만 쓴다.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applySeed, groundTruth, validateSeeds, type Seed } from '../../scripts/lib/seed.ts';

const chapters: Record<number, string> = {
  1: '# 1화\n\n가람은 열일곱 살이었다.\n\n가람의 검은 푸른빛이었다.',
  9: '# 9화\n\n가람은 푸른 검을 들었다.',
};

const seed: Seed = {
  id: 'S01',
  chapter: 9,
  find: '푸른 검',
  replace: '붉은 검',
  targetQuote: '가람은 붉은 검을 들었다.',
  category: 'habit',
  sources: [{ chapter: 1, quote: '가람의 검은  푸른빛이었다.' }],
  description: '검의 색',
};

test('심기: 바꿀 글이 정확히 한 번 있을 때만 바꾼다', () => {
  assert.equal(applySeed(chapters[9]!, seed), '# 9화\n\n가람은 붉은 검을 들었다.');
  assert.throws(() => applySeed('푸른 검과 푸른 검', seed), /2번 있습니다/);
  assert.throws(() => applySeed('없음', seed), /0번 있습니다/);
  assert.throws(() => applySeed(chapters[9]!, { ...seed, replace: seed.find }), /같습니다/);
});

test('목록 검사: 종류, 근거가 앞 화에 있는지(공백 차이는 같게), id 중복', () => {
  const text = (n: number) => chapters[n] ?? '';
  validateSeeds([seed], text);
  assert.throws(() => validateSeeds([{ ...seed, category: 'weather' as Seed['category'] }], text), /모르는 종류/);
  assert.throws(() => validateSeeds([{ ...seed, sources: [{ chapter: 9, quote: '가람' }] }], text), /앞이어야/);
  assert.throws(() => validateSeeds([{ ...seed, sources: [{ chapter: 1, quote: '없는 문장' }] }], text), /근거 문장이 1화에 없습니다/);
  assert.throws(() => validateSeeds([seed, seed], text), /id가 겹칩니다/);
  assert.throws(() => validateSeeds([{ ...seed, targetQuote: '전혀 다른 문장' }], text), /targetQuote/);
});

test('정답표: M0-A 채점기 형식, 모두 test, 거리는 가장 가까운 근거 기준', () => {
  const gt = groundTruth([{ ...seed, sources: [...seed.sources, { chapter: 4, quote: 'x' }] }]);
  assert.equal(gt.traps.length, 0);
  assert.deepEqual(gt.errors[0], {
    id: 'S01',
    category: 'habit',
    split: 'test',
    explicitness: 'L1',
    distance: 5,
    target: { chapter: 9, quotes: ['가람은 붉은 검을 들었다.'] },
    sources: [
      { chapter: 1, quotes: ['가람의 검은  푸른빛이었다.'] },
      { chapter: 4, quotes: ['x'] },
    ],
    description: '검의 색',
  });
});
