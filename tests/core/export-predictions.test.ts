// 검사 결과 내보내기 (M4-PLAN 5절): ai.db의 검사 결과가 M0-A 채점기 입력 형식으로 나가는지.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { toPredictions } from '../../scripts/export-predictions.ts';
import { AiStore } from '../../src/main/ai-db.ts';

test('검사 결과와 모델이 본 앞 화 사실(context)을 M0-A 형식으로 내보내고, 검사 호출만 요약한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loreweave-export-'));
  try {
    const store = AiStore.open(root);
    const base = { model: 'gpt-6-luna', modelVersion: 'v', promptVersion: 'extract-1', summary: '', droppedQuotes: 0, costUsd: 0, createdAt: 't' };
    const fact = (entity: string, quote: string) => ({ entity, predicate: '나이', value: 'v', quote, line: 0, start: 0, end: 1 });
    store.saveAnalysis({ ...base, file: '001.md', contentHash: 'h1', entities: [{ name: '김민수', aliases: ['민수'] }, { name: '이지현', aliases: [] }], facts: [fact('김민수', '둘 다 스무 살이었다.'), fact('이지현', '지현은 4학년이었다.')] });
    store.saveAnalysis({ ...base, file: '003.md', contentHash: 'h3', entities: [{ name: '민수', aliases: [] }], facts: [] });
    store.saveCheck({
      file: '003.md',
      contentHash: 'h3',
      model: 'gpt-6-luna',
      modelVersion: 'v',
      promptVersion: 'detect-1',
      factCount: 1,
      dropped: 0,
      costUsd: 0.001,
      createdAt: 't',
      inputs: [{ file: '001.md', contentHash: 'h1' }],
      findings: [
        {
          category: 'age',
          claim: '모순',
          confidence: 0.8,
          key: '스물두 살입니다.',
          target: { quote: '"스물두 살입니다."', line: 3, start: 0, end: 11 },
          evidence: [{ file: '001.md', chapter: 1, quote: '둘 다 스무 살이었다.', line: 2, start: 5, end: 16 }],
        },
      ],
    });
    const usage = { inputTokens: 3000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 200 };
    store.logCall({ at: 't', file: '001.md', model: 'gpt-6-luna', ok: true, usage, costUsd: 0.0005, latencyMs: 9000 });
    store.logCall({ at: 't', file: '003.md', model: 'gpt-6-luna', ok: true, usage, costUsd: 0.0012, latencyMs: 4000, kind: 'check' });
    store.close();

    const { predictions, usage: summary } = toPredictions(join(root, '.loreweave', 'ai.db'), 'run-1');
    assert.deepEqual(predictions, {
      run_id: 'run-1',
      strategy: 'product-b',
      model: 'gpt-6-luna',
      context_source: 'product-selection-recomputed',
      chapters: [
        {
          target_chapter: 3,
          context: [{ chapter: 1, text: '둘 다 스무 살이었다.' }],
          findings: [
            {
              category: 'age',
              target_quote: '"스물두 살입니다."',
              claim: '모순',
              confidence: 0.8,
              evidence: [{ chapter: 1, quote: '둘 다 스무 살이었다.' }],
            },
          ],
        },
      ],
    });
    assert.deepEqual(summary, { checks: 1, costUsd: 0.0012, maxCostUsd: 0.0012, maxLatencyMs: 4000, maxInputTokens: 3000 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
