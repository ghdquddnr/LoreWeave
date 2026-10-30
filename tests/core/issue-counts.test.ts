// 탐색기 배지의 문제 수: 검사한 화마다 확신도 기준 이상이고 무시하지 않은 결과만 센다 (한 번의 조회).

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MIN_CONFIDENCE } from '../../src/core/ai/detection.ts';
import { AiStore } from '../../src/main/ai-db.ts';

const base = { model: 'm', modelVersion: 'v', promptVersion: 'p', costUsd: 0, createdAt: '2026-10-31T00:00:00Z', factCount: 0, dropped: 0, inputs: [] };
const finding = (category: 'age' | 'number', confidence: number, key: string) => ({
  category,
  claim: key,
  confidence,
  key,
  target: { quote: key, line: 0, start: 0, end: key.length },
  evidence: [],
});

test('issueCounts: 기준 이상·무시하지 않은 결과만, 검사한 화만, 무시는 같은 화·종류·문장에만 적용된다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loreweave-issue-counts-'));
  const db = AiStore.open(dir);
  try {
    assert.deepEqual(db.issueCounts(MIN_CONFIDENCE), {}, '검사한 화가 없으면 비어 있다');
    db.saveCheck({ ...base, file: '001.md', contentHash: 'h1', findings: [finding('age', 0.9, 'a'), finding('number', MIN_CONFIDENCE, 'edge'), finding('age', 0.69, 'low'), finding('age', 0.95, 'gone')] });
    db.saveCheck({ ...base, file: '002.md', contentHash: 'h2', findings: [] });
    db.saveCheck({ ...base, file: '003.md', contentHash: 'h3', findings: [finding('age', 0.95, 'gone')] });
    // 001: a, edge(기준과 같으면 보임), gone = 3 (low는 제외). 002: 0. 003: gone 1 (다른 화의 같은 문장 무시는 영향 없음)
    assert.deepEqual(db.issueCounts(MIN_CONFIDENCE), { '001.md': 3, '002.md': 0, '003.md': 1 });
    db.dismiss('001.md', 'age', 'gone', base.createdAt);
    assert.deepEqual(db.issueCounts(MIN_CONFIDENCE), { '001.md': 2, '002.md': 0, '003.md': 1 }, '무시는 그 화·종류·문장만 뺀다');
    db.dismiss('001.md', 'number', 'a', base.createdAt); // 종류가 다르면 다른 결과
    assert.equal(db.issueCounts(MIN_CONFIDENCE)['001.md'], 2);
    // 같은 화를 다시 검사하면 새 결과로 센다 (무시 목록은 유지)
    db.saveCheck({ ...base, file: '001.md', contentHash: 'h1b', findings: [finding('age', 0.9, 'gone'), finding('age', 0.9, 'new')] });
    assert.equal(db.issueCounts(MIN_CONFIDENCE)['001.md'], 1, '무시한 gone은 다시 검사해도 숨는다');
  } finally {
    db.close();
  }
});
