// OpenAI Costs API 응답 합치기 (scripts/openai-costs.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startOfDay, summarizeCosts } from '../../scripts/lib/costs.ts';

const day = (d: string) => startOfDay(d);

test('합계, 날짜별(0인 날 뺌), 항목별(큰 순서)', () => {
  const summary = summarizeCosts([
    {
      start_time: day('2026-10-24'),
      end_time: day('2026-10-25'),
      results: [
        { amount: { value: 1.5, currency: 'usd' }, line_item: 'gpt-6.1-sol, input' },
        { amount: { value: 0.25, currency: 'usd' }, line_item: 'gpt-6-luna, output' },
      ],
    },
    { start_time: day('2026-10-25'), end_time: day('2026-10-26'), results: [{ amount: { value: 0.5, currency: 'usd' }, line_item: 'gpt-6-luna, output' }] },
    { start_time: day('2026-10-26'), end_time: day('2026-10-27'), results: [] },
  ]);
  assert.equal(summary.total, 2.25);
  assert.equal(summary.currency, 'usd');
  assert.deepEqual(summary.byDay, [
    ['2026-10-24', 1.75],
    ['2026-10-25', 0.5],
  ]);
  assert.deepEqual(summary.byLineItem, [
    ['gpt-6.1-sol, input', 1.5],
    ['gpt-6-luna, output', 0.75],
  ]);
});

test('통화가 섞이면 합치지 않는다, 항목이 없으면 (구분 없음)', () => {
  assert.throws(
    () =>
      summarizeCosts([
        {
          start_time: 0,
          end_time: 1,
          results: [
            { amount: { value: 1, currency: 'usd' } },
            { amount: { value: 1, currency: 'eur' } },
          ],
        },
      ]),
    /통화가 여럿/,
  );
  assert.deepEqual(summarizeCosts([{ start_time: 0, end_time: 1, results: [{ amount: { value: 1, currency: 'usd' }, line_item: null }] }]).byLineItem, [['(구분 없음)', 1]]);
});

test('날짜: YYYY-MM-DD → UTC 0시 Unix 초', () => {
  assert.equal(startOfDay('2026-10-01'), Date.UTC(2026, 9, 1) / 1000);
  assert.throws(() => startOfDay('2026/10/01'), /YYYY-MM-DD/);
});
