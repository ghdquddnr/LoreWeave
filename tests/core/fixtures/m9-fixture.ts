// M9 테스트의 기준 폴더 (M8과 같은 모양: 분석 → detect-1 검사 → 평가기 출력). 가짜 AI 클라이언트로 네트워크 없이 만든다.

import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Usage } from '../../../src/core/ai/cost.ts';
import type { Extraction } from '../../../src/core/ai/extraction.ts';
import type { AiClient, JsonCall } from '../../../src/main/ai-client.ts';
import { AiStore } from '../../../src/main/ai-db.ts';
import { checkChapter } from '../../../src/main/checker.ts';
import { toPredictions } from '../../../scripts/export-predictions.ts';

export const M0A = join(__dirname, '../../../spikes/m0a-ai-feasibility/benchmark/chapters');
export const REPO = join(__dirname, '../../..');
export const MODEL = 'gpt-6-luna';
export const usage: Usage = { inputTokens: 2000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 300 };
export const TARGETS = ['002.md', '003.md'];
/** 1화 사실 수. 400개씩 나누면 2화·3화 검사는 2묶음씩 된다 */
export const MANY = 450;

const minsu = { name: '김민수', aliases: ['민수'] };
/** 1화 본문에 있는 문장. 사실마다 돌려 써서 순서를 바꾸면 화·인용 순서가 달라지게 한다 */
const QUOTES = ['둘 다 스무 살이었다.', '생각이 많아질 때마다 나오는 버릇이었다.', '가슴에 단 이름표가 아직 어색했다.'];
export type ExtractionOf = (n: number) => Extraction;
export const extractionOf: ExtractionOf = (n) =>
  n === 1
    ? {
        summary: '입학',
        entities: [minsu],
        facts: Array.from({ length: MANY }, (_, i) => ({ entity: '김민수', predicate: '나이', value: `값 ${i}`, quote: QUOTES[i % QUOTES.length]! })),
      }
    : { summary: `${n}화`, entities: n === 2 ? [{ name: '이지현', aliases: [] }, minsu] : [minsu], facts: [] };

/** 호출을 기록하는 가짜 클라이언트. detect는 검사 응답을, use는 돌려줄 usage를 정한다 */
export function fakeClient(
  detect: (call: JsonCall) => Promise<unknown> | unknown = () => ({ findings: [] }),
  use: Usage = usage,
  extract: ExtractionOf = extractionOf,
): AiClient & { calls: JsonCall[] } {
  const calls: JsonCall[] = [];
  return {
    calls,
    async check() {},
    async json(call) {
      calls.push(call);
      const n = Number(/<chapter n="(\d+)">/.exec(call.user)![1]);
      const data = call.schema.name === 'chapter_extraction' ? extract(n) : await detect(call);
      return { data, usage: use, modelVersion: 'gpt-6-luna-test', latencyMs: 1 };
    },
  };
}

/** M8과 같은 모양의 기준 폴더: 분석 → 검사(detect-1) → 평가기 출력 */
export async function makeBaseline(root: string, extract: ExtractionOf = extractionOf) {
  await mkdir(join(root, 'chapters'), { recursive: true });
  for (const n of ['01', '02', '03']) await copyFile(join(M0A, `ch${n}.md`), join(root, 'chapters', `0${n}.md`));
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 25, 0, 0, tick++));
  const store = AiStore.open(root);
  try {
    for (const file of TARGETS) {
      const outcome = await checkChapter(file, { root, store, client: fakeClient(undefined, usage, extract), model: MODEL, signal: new AbortController().signal, now });
      assert.equal(outcome.stopped, null);
    }
  } finally {
    store.close();
  }
  const { predictions } = toPredictions(join(root, '.loreweave', 'ai.db'), 'm8-test');
  await mkdir(join(root, 'review', 'eval'), { recursive: true });
  await writeFile(join(root, 'review', 'eval', 'predictions.json'), JSON.stringify(predictions));
}

/** 기준 ai.db를 직접 고친다 (변조 시험) */
export function tamper(root: string, sql: string, ...args: (string | number)[]) {
  const db = new DatabaseSync(join(root, '.loreweave', 'ai.db'));
  try {
    db.prepare(sql).run(...args);
  } finally {
    db.close();
  }
}
