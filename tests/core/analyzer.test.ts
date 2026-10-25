// 사실 추출 실행과 분석 결과 저장소 (M3-PLAN 3·4·5절). 가짜 AI 클라이언트로 네트워크 없이 확인한다.

import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';
import type { Extraction } from '../../src/core/ai/extraction.ts';
import { AiError, type AiClient, type JsonCall } from '../../src/main/ai-client.ts';
import { AiStore, NewerFormatError } from '../../src/main/ai-db.ts';
import { analysisStates, analyzeChapters, CONCURRENCY, estimate } from '../../src/main/analyzer.ts';

const M0A = join(__dirname, '../../spikes/m0a-ai-feasibility/benchmark/chapters');
const usage = { inputTokens: 1200, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 1000 };
let root: string;
let store: AiStore | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loreweave-ai-'));
  await mkdir(join(root, 'chapters'));
  for (const n of ['01', '02', '03']) await copyFile(join(M0A, `ch${n}.md`), join(root, 'chapters', `0${n}.md`));
});

afterEach(async () => {
  store?.close();
  store = null;
  await rm(root, { recursive: true, force: true });
});

const extraction = (quote: string): Extraction => ({
  summary: '요약',
  entities: [{ name: '김민수', aliases: ['민수'] }],
  facts: [
    { entity: '김민수', predicate: '나이', value: '스무 살', quote },
    { entity: '김민수', predicate: '나이', value: '스물한 살', quote: '본문에 없는 인용이다' },
  ],
});

function fakeClient(respond: (call: JsonCall, n: number) => unknown): AiClient & { calls: JsonCall[] } {
  const calls: JsonCall[] = [];
  return {
    calls,
    async check() {},
    async json(call) {
      calls.push(call);
      const data = await respond(call, calls.length);
      return { data, usage, modelVersion: 'gpt-6-luna-test', latencyMs: 1 };
    },
  };
}

const options = (client: AiClient, signal = new AbortController().signal) => {
  store ??= AiStore.open(root);
  return { root, store, client, model: 'gpt-6-luna', signal, now: () => new Date('2026-10-25T00:00:00Z') };
};

test('분석: 인용이 본문에 있는 사실만 줄 주소와 함께 저장하고, 호출 비용을 기록한다', async () => {
  const before = await readFile(join(root, 'chapters', '001.md'));
  const client = fakeClient(() => extraction('둘 다 스무 살이었다.'));
  const progress = await analyzeChapters(['001.md'], options(client));
  assert.deepEqual({ ...progress, costUsd: progress.costUsd.toFixed(5) }, { total: 1, done: 1, failed: [], costUsd: '0.00062', stopped: null });
  assert.match(client.calls[0]!.user, /^<chapter n="1">\n1화\. 입학\n/);
  const saved = store!.analysis('001.md')!;
  assert.equal(saved.droppedQuotes, 1);
  assert.equal(saved.facts.length, 1);
  const lines = (await readFile(join(root, 'chapters', '001.md'), 'utf8')).split('\n');
  const fact = saved.facts[0]!;
  assert.equal(lines[fact.line]!.slice(fact.start, fact.end), '둘 다 스무 살이었다.');
  assert.deepEqual(saved.entities, [{ name: '김민수', aliases: ['민수'] }]);
  assert.equal(saved.promptVersion, 'extract-1');
  assert.equal(store!.totalCost().toFixed(5), '0.00062');
  assert.deepEqual(await readFile(join(root, 'chapters', '001.md')), before);
});

test('상태: 분석 없음 / 분석 뒤 그대로 / 분석 뒤 바뀜', async () => {
  await analyzeChapters(['001.md', '002.md'], options(fakeClient(() => extraction('x'))));
  await writeFile(join(root, 'chapters', '002.md'), '# 2화\n\n바뀐 본문\n');
  assert.deepEqual(await analysisStates(root, store!), { '001.md': 'fresh', '002.md': 'stale', '003.md': 'none' });
});

test('키·모델·한도 문제는 멈추고, 그 밖의 실패는 그 화만 실패로 남긴다', async () => {
  const stop = fakeClient((_c, n) => {
    if (n === 2) throw new AiError('API 키가 올바르지 않습니다.', 'auth');
    return extraction('x');
  });
  const stopped = await analyzeChapters(['001.md', '002.md', '003.md'], options(stop));
  assert.equal(stopped.done, 1);
  assert.equal(stopped.stopped, 'API 키가 올바르지 않습니다.');
  assert.equal(stop.calls.length, 2);

  // 두 화를 동시에 보내므로 몇 번째 호출인지가 아니라 어느 화인지로 고른다
  const skip = fakeClient((c) => {
    if (c.user.includes('n="1"')) throw Object.assign(new AiError('응답이 끝나지 않았습니다', 'incomplete'), { usage });
    return extraction('x');
  });
  const before = store!.totalCost();
  const skipped = await analyzeChapters(['001.md', '002.md'], options(skip));
  assert.deepEqual(skipped.failed, [{ file: '001.md', message: '응답이 끝나지 않았습니다' }]);
  assert.equal(skipped.done, 2);
  assert.equal(skipped.stopped, null);
  // 실패한 호출도 사용량이 있으면 비용에 넣는다
  assert.equal((store!.totalCost() - before).toFixed(5), '0.00124');
});

test('두 화씩 동시에 보내고, 호출마다 걸린 시간을 남긴다', async () => {
  let inFlight = 0;
  let most = 0;
  const client = fakeClient(async () => {
    most = Math.max(most, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight--;
    return extraction('x');
  });
  const progress = await analyzeChapters(['001.md', '002.md', '003.md'], options(client));
  assert.equal(CONCURRENCY, 2);
  assert.equal(most, 2);
  assert.equal(progress.done, 3);
  assert.deepEqual(Object.keys(await analysisStates(root, store!)).filter((f) => store!.analysis(f)), ['001.md', '002.md', '003.md']);
  store!.close();
  store = null;
  const raw = new DatabaseSync(join(root, '.loreweave', 'ai.db'));
  const latencies = raw.prepare('SELECT latency_ms FROM calls').all().map((r) => Number(r['latency_ms']));
  raw.close();
  assert.equal(latencies.length, 3);
  for (const ms of latencies) assert.ok(ms >= 15, `latency ${ms}`);
});

test('형식이 다른 응답은 저장하지 않는다', async () => {
  const result = await analyzeChapters(['001.md'], options(fakeClient(() => ({ summary: 1 }))));
  assert.match(result.failed[0]!.message, /추출 결과 형식이 다릅니다/);
  assert.equal(store!.analysis('001.md'), null);
});

test('취소: 다음 화를 보내지 않고, 끝난 화는 남는다', async () => {
  const controller = new AbortController();
  const client = fakeClient(() => {
    controller.abort();
    return extraction('x');
  });
  const result = await analyzeChapters(['001.md', '002.md', '003.md'], options(client, controller.signal));
  assert.equal(client.calls.length, 1);
  assert.equal(result.stopped, '취소했습니다');
  // 두 화를 동시에 읽으므로 먼저 보낸 화가 001이 아닐 수 있다
  assert.equal(['001.md', '002.md', '003.md'].filter((f) => store!.analysis(f)).length, 1);
});

test('다시 분석하면 그 화의 이전 결과를 바꾼다', async () => {
  await analyzeChapters(['001.md'], options(fakeClient(() => extraction('둘 다 스무 살이었다.'))));
  await analyzeChapters(['001.md'], options(fakeClient(() => ({ summary: '두 번째', entities: [], facts: [] }))));
  const saved = store!.analysis('001.md')!;
  assert.equal(saved.summary, '두 번째');
  assert.equal(saved.facts.length, 0);
});

test('예상 비용은 글자 수에 비례하는 상한이다', async () => {
  const one = await estimate(root, ['001.md'], 'gpt-6-luna');
  const three = await estimate(root, ['001.md', '002.md', '003.md'], 'gpt-6-luna');
  assert.ok(one.costUsd > 0 && one.costUsd < 0.005);
  assert.ok(three.chars > 2 * one.chars);
  assert.ok((await estimate(root, ['001.md'], 'gpt-6.1-sol')).costUsd > 10 * one.costUsd);
});

test('저장소: 다시 열어도 결과가 남고, 깨진 파일은 옮겨 두고, 새 형식 파일은 건드리지 않는다', async () => {
  await analyzeChapters(['001.md'], options(fakeClient(() => extraction('x'))));
  store!.close();
  store = AiStore.open(root);
  assert.ok(store.analysis('001.md'));
  assert.equal(store.recoveredFrom, null);
  store.close();
  store = null;

  // 형식 1(M3 첫 배포) 파일은 결과를 둔 채 형식 2로 올린다
  const path = join(root, '.loreweave', 'ai.db');
  const v1 = new DatabaseSync(path);
  v1.exec('ALTER TABLE calls DROP COLUMN latency_ms; PRAGMA user_version = 1');
  v1.close();
  store = AiStore.open(root);
  assert.ok(store.analysis('001.md'));
  store.close();
  store = null;
  const v2 = new DatabaseSync(path);
  assert.equal((v2.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
  assert.deepEqual(v2.prepare('SELECT latency_ms FROM calls').all().map((r) => r['latency_ms']), [null]);
  v2.close();

  for (const suffix of ['-wal', '-shm']) await rm(path + suffix, { force: true });
  await writeFile(path, '깨진 파일');
  store = AiStore.open(root, () => new Date('2026-10-25T01:02:03Z'));
  assert.equal(store.recoveredFrom, `${path}.broken-2026-10-25T01-02-03-000Z`);
  assert.equal(await readFile(store.recoveredFrom!, 'utf8'), '깨진 파일');
  assert.equal(store.analysis('001.md'), null);
  store.close();
  store = null;

  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => AiStore.open(root), NewerFormatError);
  assert.ok((await readdir(join(root, '.loreweave'))).includes('ai.db'));
});
