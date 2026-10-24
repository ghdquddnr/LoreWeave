import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terms } from '../src/strategies/search.ts';

test('terms: keeps eojeol and josa-stripped stems of 3+ chars', () => {
  const ts = terms('한빛벤처스의 오태식 이사가 "처음 뵙겠습니다."라고 했다.');
  assert.ok(ts.includes('한빛벤처스의'));
  assert.ok(ts.includes('한빛벤처스'));
  assert.ok(ts.includes('오태식'));
  assert.ok(!ts.includes('이사')); // 2 chars: not searchable with trigram
});
