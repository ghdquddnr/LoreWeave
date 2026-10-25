// 150화 긴 시험 원고 만들기와 측정 스크립트 비용 한도 (M5-PLAN 1·2·4절). 네트워크 없이 확인한다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BudgetExceeded, withBudget } from '../../scripts/lib/budget.ts';
import {
  canonOnly,
  fillerFileText,
  fillerInput,
  fillerPositions,
  gapOf,
  isOriginalPosition,
  originalPosition,
  parseFiller,
  parsePlot,
  renumberGroundTruth,
  renumberHeading,
} from '../../scripts/lib/long-benchmark.ts';
import { parseC3 } from '../../src/core/manuscript/c3.ts';
import { splitEnvelope } from '../../src/core/manuscript/envelope.ts';
import { visibleLines } from '../../src/core/manuscript/lines.ts';
import type { AiClient } from '../../src/main/ai-client.ts';

const M0A = join(__dirname, '../../spikes/m0a-ai-feasibility/benchmark');
const read = (name: string) => readFileSync(join(M0A, name), 'utf8');

test('배치: 원래 화 k는 10k−9번째, 중간 화는 135개이고 자리를 안다', () => {
  assert.deepEqual([1, 2, 15].map(originalPosition), [1, 11, 141]);
  assert.equal(fillerPositions().length, 135);
  assert.ok(fillerPositions().every((n) => !isOriginalPosition(n)));
  assert.deepEqual(gapOf(2), { before: 1, after: 2, index: 1 });
  assert.deepEqual(gapOf(140), { before: 14, after: 15, index: 9 });
  assert.deepEqual(gapOf(150), { before: 15, after: null, index: 9 });
  assert.throws(() => gapOf(21), /중간 화가 아닙니다/);
});

test('플롯: 15화의 제목과 날짜를 읽는다', () => {
  const plot = parsePlot(read('plot.md'));
  assert.equal(plot.length, 15);
  assert.deepEqual(plot[2], { n: 3, title: 'MT', date: '2007-05-25' });
});

test('생성 입력: 오류 계획과 평가용 안내는 빼고 설정은 남긴다', () => {
  const bible = canonOnly(read('world-bible.md'));
  const plot = canonOnly(read('plot.md'));
  for (const doc of [bible, plot]) {
    assert.doesNotMatch(doc, /오류|error-plan|평가 입력/);
  }
  assert.match(bible, /술을 전혀 못 마신다\*\* \(알코올 알레르기\)\.$/m);
  assert.match(bible, /커피를 마시지 못한다/);
  const input = fillerInput(23, { worldBible: bible, plot }, parsePlot(read('plot.md')), [{ n: 22, summary: '민수가 시험을 본다.' }]);
  assert.match(input, /# 쓸 화: 전체 23화\n원작 3화 「MT」\(2007-05-25\) 뒤, 원작 4화 「설립」\(2007-08-21\) 앞\. 그 사이에 들어가는 중간 화 9개 중 2번째\./);
  assert.match(input, /- 22화: 민수가 시험을 본다\./);
  assert.match(fillerInput(150, { worldBible: bible, plot }, parsePlot(read('plot.md')), []), /원작 마지막 화인 15화/);
});

test('정답표: 화 번호를 새 자리로 바꾸고 거리를 다시 센다', () => {
  const gt = JSON.parse(read('ground-truth.json'));
  const moved = renumberGroundTruth(gt);
  assert.equal(moved.errors.length, 30);
  assert.equal(moved.traps.length, 10);
  const e04 = moved.errors.find((e) => e['id'] === 'E04')!;
  assert.equal(e04.target.chapter, 21);
  assert.ok(e04.sources.every((s) => [1, 11].includes(s.chapter)));
  for (const e of moved.errors) assert.ok(isOriginalPosition(e.target.chapter) && e.distance >= 10 && e.distance % 10 === 0);
  assert.ok(moved.traps.every((t) => isOriginalPosition(t.chapter)));
});

test('원래 화 제목 줄 번호를 바꾼다', () => {
  assert.equal(renumberHeading(read('chapters/ch03.md'), 21).split('\n')[0], '# 21화. MT');
  assert.throws(() => renumberHeading('본문', 21), /형식이 아닙니다/);
});

test('중간 화: 원고 형식으로 쓰고, 제목·인용·강조로 읽히는 기호는 뺀다', () => {
  const filler = parseFiller({
    title: ' 시험 기간 ',
    summary: '민수가 시험을 본다.',
    paragraphs: ['민수는 도서관에\n앉았다.', '# 제목처럼', '> 인용처럼', '**강조**된 말', '---', ''],
  });
  assert.deepEqual(filler.paragraphs, ['민수는 도서관에 앉았다.', '제목처럼', '인용처럼', '강조된 말']);
  const text = fillerFileText(22, filler);
  assert.equal(text, '# 22화. 시험 기간\n\n민수는 도서관에 앉았다.\n\n제목처럼\n\n인용처럼\n\n강조된 말\n');
  // 앱이 읽는 보이는 줄: 제목 + 문단 (원래 화와 같은 모양)
  assert.deepEqual(visibleLines(parseC3(splitEnvelope(text).body)).filter(Boolean), ['22화. 시험 기간', '민수는 도서관에 앉았다.', '제목처럼', '인용처럼', '강조된 말']);
  assert.throws(() => parseFiller({ title: 't', summary: 's', paragraphs: [1] }), /문단/);
});

test('비용 한도: 한도에 닿으면 다음 호출을 보내지 않는다 (실패한 호출의 비용도 센다)', async () => {
  let calls = 0;
  const usage = { inputTokens: 10_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 4_000 }; // luna $0.003
  const client: AiClient = {
    async check() {},
    async json() {
      calls++;
      if (calls === 2) throw Object.assign(new Error('끝나지 않음'), { usage });
      return { data: {}, usage, modelVersion: 'x', latencyMs: 1 };
    },
  };
  const ai = withBudget(client, 'gpt-6-luna', 0.008);
  const call = { model: 'gpt-6-luna', system: '', user: '', schema: { name: 's', schema: {} } };
  await ai.json(call);
  await assert.rejects(ai.json(call), /끝나지 않음/);
  await ai.json(call);
  assert.equal(ai.spent().toFixed(4), '0.0090');
  await assert.rejects(ai.json(call), BudgetExceeded);
  assert.equal(calls, 3);
});
