// M9 후속 가설: 속성 이름이 같은 앞 화 사실 더하기 (오프라인 계산용)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateFacts } from '../../src/core/ai/detection.ts';
import { predicateKey, withPredicateMatches } from '../../scripts/lib/predicate-addition.ts';

const priors = [
  {
    chapter: 1,
    entities: [{ name: '김민수', aliases: ['민수'] }, { name: '투자 계약', aliases: [] }],
    facts: [
      { entity: '김민수', predicate: '나이', value: '스무 살', quote: 'q1' },
      { entity: '투자 계약', predicate: '투자금 (계약)', value: '3억 원', quote: 'q2' },
      { entity: '투자 계약', predicate: '지분', value: '15%', quote: 'q3' },
    ],
  },
  { chapter: 2, entities: [{ name: '회사', aliases: [] }], facts: [{ entity: '회사', predicate: '투자금', value: '3억', quote: 'q4' }] },
];
const target = { entities: [{ name: '민수', aliases: [] }], facts: [{ predicate: ' 투자금' }] };

test('속성 이름 더하기: 이름으로 고른 사실은 그대로 두고, 같은 속성 이름의 사실만 화 순서대로 더한다', () => {
  const base = candidateFacts(target.entities, priors);
  const r = withPredicateMatches(target, priors);
  assert.equal(r.base, base.length);
  assert.equal(r.added, 2);
  assert.deepEqual(r.facts.map((f) => f.quote), ['q1', 'q2', 'q4']);
  for (const f of base) assert.ok(r.facts.includes(f) || r.facts.some((g) => JSON.stringify(g) === JSON.stringify(f)));
  assert.equal(predicateKey('투자금 (계약)'), '투자금');
});

test('속성 이름 더하기: 이미 고른 사실은 다시 넣지 않고, 이 화 사실이 없으면 더하지 않는다', () => {
  const again = withPredicateMatches({ entities: [{ name: '투자 계약', aliases: [] }], facts: [{ predicate: '지분' }] }, priors);
  assert.equal(again.added, 0);
  assert.deepEqual(withPredicateMatches({ entities: target.entities, facts: [] }, priors).added, 0);
});
