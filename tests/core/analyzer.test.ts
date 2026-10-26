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
import { analysisStates, analyzeChapters, CHANGED_WHILE_ANALYZING, CONCURRENCY, estimate } from '../../src/main/analyzer.ts';

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
  // 1화가 저장되는 순간 2화가 키 문제로 멈춘다. 저장 전에 멈추면 1화도 저장하지 않으므로, 타이밍이 아니라 1화 저장에 맞춰 실패시킨다.
  // 실패는 microtask로 전파되어, 3화가 파일을 읽고 중단 여부를 확인하기 전에 멈춤이 걸린다
  let fail2!: () => void;
  const failed2 = new Promise<void>((_r, reject) => (fail2 = () => reject(new AiError('API 키가 올바르지 않습니다.', 'auth'))));
  failed2.catch(() => {});
  const stop = fakeClient(async (c) => {
    if (c.user.includes('<chapter n="2">')) await failed2;
    return extraction('x');
  });
  const opts = options(stop);
  const save = opts.store.saveAnalysis.bind(opts.store);
  opts.store.saveAnalysis = (a) => {
    save(a);
    if (a.file === '001.md') fail2();
  };
  const stopped = await analyzeChapters(['001.md', '002.md', '003.md'], opts);
  opts.store.saveAnalysis = save;
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

test('취소: 다음 화를 보내지 않고, 취소 전에 끝난 화는 남으며, 응답을 기다리던 화는 저장하지 않는다', async () => {
  // 이전에는 응답을 기다리는 동안 취소한 화의 늦은 성공도 "끝난 화"로 저장했다. 이제는 취소 전에 실제로 끝난 화만 남는다
  const controller = new AbortController();
  const client = fakeClient(async (call) => {
    const n = Number(/<chapter n="(\d+)">/.exec(call.user)![1]);
    if (n === 2) {
      // 1화가 저장된 뒤에 취소한다 (타이밍이 아니라 저장을 확인하고)
      const end = Date.now() + 5_000;
      while (!store!.analysis('001.md') && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
      controller.abort();
    }
    return extraction('둘 다 스무 살이었다.');
  });
  const result = await analyzeChapters(['001.md', '002.md', '003.md'], options(client, controller.signal));
  assert.equal(client.calls.length, 2);
  assert.equal(result.stopped, '취소했습니다');
  assert.equal(result.done, 1);
  assert.ok(store!.analysis('001.md'));
  assert.equal(store!.analysis('002.md'), null);
  assert.equal(store!.analysis('003.md'), null);
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

  // 형식 1(M3 첫 배포) 파일은 결과를 둔 채 지금 형식(4)으로 올린다
  const path = join(root, '.loreweave', 'ai.db');
  const v1 = new DatabaseSync(path);
  v1.exec(
    `ALTER TABLE analyses DROP COLUMN chunks; DROP TABLE dismissals; DROP TABLE finding_evidence; DROP TABLE findings; DROP TABLE check_inputs; DROP TABLE checks;
     ALTER TABLE calls DROP COLUMN kind; ALTER TABLE calls DROP COLUMN latency_ms; PRAGMA user_version = 1`,
  );
  v1.close();
  store = AiStore.open(root);
  assert.ok(store.analysis('001.md'));
  store.close();
  store = null;
  const v2 = new DatabaseSync(path);
  assert.equal((v2.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4);
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

test('나눠 추출: 긴 화는 조각마다 묻고 합쳐 저장하며, 비용은 조각 합, 조각 수를 남긴다', async () => {
  const long = ['# 9화', '', ...Array.from({ length: 12 }, (_, i) => [`${'가'.repeat(200)} 문장${i}이다.`, '']).flat()].join('\n');
  await writeFile(join(root, 'chapters', '009.md'), long);
  const client = fakeClient((call) => {
    const i = /문장(\d+)이다/.exec(call.user)![1];
    return { summary: `조각${i}`, entities: [{ name: '김민수', aliases: [] }], facts: [{ entity: '김민수', predicate: '문장', value: i!, quote: `문장${i}이다.` }] };
  });
  const progress = await analyzeChapters(['009.md'], options(client));
  assert.ok(client.calls.length >= 2, `calls ${client.calls.length}`);
  const saved = store!.analysis('009.md')!;
  assert.equal(saved.chunks, client.calls.length);
  assert.equal(saved.facts.length, client.calls.length);
  assert.equal(saved.entities.length, 1);
  assert.equal(progress.costUsd.toFixed(5), (client.calls.length * 0.00062).toFixed(5));
  const one = await estimate(root, ['001.md'], 'gpt-6-luna');
  const split = await estimate(root, ['009.md'], 'gpt-6-luna');
  assert.ok(split.costUsd > one.costUsd);
});

for (const kind of ['auth', 'model', 'rate-limit'] as const) {
  test(`나눠 추출 중단 전파 (${kind}): 한 화가 멈추면 다른 긴 화는 새 조각을 보내지 않고, 일부 조각만으로 저장하지 않으며, 이미 보낸 호출 기록과 이전 분석은 남는다`, async () => {
    const long = (n: number) => ['# 화', '', ...Array.from({ length: 12 }, (_, i) => [`${'가'.repeat(200)} ${n}화문장${i}이다.`, '']).flat()].join('\n');
    await writeFile(join(root, 'chapters', '008.md'), long(8));
    await writeFile(join(root, 'chapters', '009.md'), long(9));
    // 009화에는 이전에 완성된 분석이 있다
    store = AiStore.open(root);
    store.saveAnalysis({ file: '009.md', contentHash: 'old', model: 'gpt-6-luna', modelVersion: 'v', promptVersion: 'extract-1', summary: '이전 분석', droppedQuotes: 0, costUsd: 0, createdAt: 't', entities: [], facts: [] });

    let release!: () => void;
    const failed = new Promise<void>((r) => (release = r));
    let started9!: () => void;
    const sent9 = new Promise<void>((r) => (started9 = r));
    const calls: number[] = [];
    const client: AiClient = {
      async check() {},
      async json(call) {
        const n = Number(/<chapter n="(\d+)">/.exec(call.user)![1]);
        calls.push(n);
        if (n === 8) {
          // 009화가 첫 조각을 보낸 뒤, 008화 첫 조각이 키·모델·한도 문제로 멈춘다. 009화의 첫 응답은 그 뒤에 돌아온다
          await sent9;
          setTimeout(release, 0);
          throw new AiError('멈춤', kind);
        }
        started9();
        await failed;
        await new Promise((r) => setTimeout(r, 5));
        return { data: { summary: 's', entities: [], facts: [] }, usage, modelVersion: 'v', latencyMs: 1 };
      },
    };
    const progress = await analyzeChapters(['008.md', '009.md'], options(client));
    assert.equal(progress.stopped, '멈춤');
    assert.deepEqual(calls.filter((n) => n === 9).length, 1, `009화 요청 ${calls.filter((n) => n === 9).length}회`);
    // 일부 조각만 합친 분석으로 덮어쓰지 않았다
    assert.equal(store!.analysis('009.md')!.summary, '이전 분석');
    assert.equal(store!.analysis('008.md'), null);
    // 이미 보낸 009화 첫 조각의 호출은 기록에 남는다
    store!.close();
    store = null;
    const raw = new DatabaseSync(join(root, '.loreweave', 'ai.db'));
    const logged = raw.prepare("SELECT count(*) AS n FROM calls WHERE file = '009.md'").get() as { n: number };
    raw.close();
    assert.equal(logged.n, 1);
  });
}

// ---- 취소·멈춤 뒤 늦게 온 성공 응답

const loggedCalls = (file: string) => {
  const raw = new DatabaseSync(join(root, '.loreweave', 'ai.db'), { readOnly: true });
  try {
    return raw.prepare('SELECT ok, cost_usd FROM calls WHERE file = ? ORDER BY id').all(file) as { ok: number; cost_usd: number }[];
  } finally {
    raw.close();
  }
};

test('늦은 성공 (단일 조각): 응답을 기다리는 동안 취소하면 늦게 온 성공으로 기존 분석을 덮어쓰지 않고, 호출 기록은 남긴다', async () => {
  await analyzeChapters(['001.md'], options(fakeClient(() => extraction('둘 다 스무 살이었다.'))));
  const before = store!.analysis('001.md');
  const controller = new AbortController();
  const client = fakeClient(() => {
    controller.abort();
    return { ...extraction('둘 다 스무 살이었다.'), summary: '늦은 응답' };
  });
  const result = await analyzeChapters(['001.md'], options(client, controller.signal));
  assert.equal(result.stopped, '취소했습니다');
  assert.equal(result.done, 0);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(store!.analysis('001.md'), before);
  // 처음 분석 1건 + 이번 1건, 이번 호출도 성공으로 비용과 함께 남는다
  const calls = loggedCalls('001.md');
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.ok === 1 && calls[1]!.cost_usd > 0);
  assert.ok(result.costUsd > 0);
});

test('늦은 성공 (여러 조각): 마지막 조각을 기다리는 동안 취소하면 저장하지 않고, 더 보내지 않으며, 조각 호출 기록은 모두 남는다', async () => {
  const long = ['# 9화', '', ...Array.from({ length: 12 }, (_, i) => [`${'가'.repeat(200)} 문장${i}이다.`, '']).flat()].join('\n');
  await writeFile(join(root, 'chapters', '009.md'), long);
  store = AiStore.open(root);
  store.saveAnalysis({ file: '009.md', contentHash: 'old', model: 'gpt-6-luna', modelVersion: 'v', promptVersion: 'extract-1', summary: '이전 분석', droppedQuotes: 0, costUsd: 0, createdAt: 't', entities: [], facts: [] });
  const before = store.analysis('009.md');
  // 조각 수를 먼저 센다 (취소 없이 끝까지 보내 보는 별도 폴더 없이, 같은 분할 함수의 결과와 같다)
  const { splitForExtraction } = await import('../../src/core/ai/extraction.ts');
  const { chapterLines } = await import('../../src/main/analyzer.ts');
  const chunks = splitForExtraction((await chapterLines(root, '009.md')).lines).length;
  assert.ok(chunks >= 2);
  const controller = new AbortController();
  const client = fakeClient((call, n) => {
    if (n === chunks) controller.abort();
    const i = /문장(\d+)이다/.exec(call.user)![1];
    return { summary: `조각${i}`, entities: [], facts: [] };
  });
  const result = await analyzeChapters(['009.md'], options(client, controller.signal));
  assert.equal(client.calls.length, chunks);
  assert.equal(result.stopped, '취소했습니다');
  assert.equal(result.done, 0);
  assert.deepEqual(store!.analysis('009.md'), before);
  assert.equal(loggedCalls('009.md').filter((c) => c.ok === 1).length, chunks);
});

for (const kind of ['auth', 'model', 'rate-limit'] as const) {
  test(`늦은 성공 (다른 화 ${kind} 멈춤): 진행 중이던 화의 마지막 응답이 늦게 성공해도 저장하지 않고, 다음 화는 보내지 않는다`, async () => {
    store = AiStore.open(root);
    store.saveAnalysis({ file: '002.md', contentHash: 'old', model: 'gpt-6-luna', modelVersion: 'v', promptVersion: 'extract-1', summary: '이전 분석', droppedQuotes: 0, costUsd: 0, createdAt: 't', entities: [], facts: [] });
    const before = store.analysis('002.md');
    let release!: () => void;
    const stopped = new Promise<void>((r) => (release = r));
    let sent2!: () => void;
    const started2 = new Promise<void>((r) => (sent2 = r));
    const calls: number[] = [];
    const client: AiClient = {
      async check() {},
      async json(call) {
        const n = Number(/<chapter n="(\d+)">/.exec(call.user)![1]);
        calls.push(n);
        if (n === 1) {
          await started2;
          setTimeout(release, 0);
          throw new AiError('멈춤', kind);
        }
        sent2();
        await stopped;
        await new Promise((r) => setTimeout(r, 5));
        return { data: { ...extraction('둘 다 스무 살이었다.'), summary: '늦은 응답' }, usage, modelVersion: 'v', latencyMs: 1 };
      },
    };
    const result = await analyzeChapters(['001.md', '002.md', '003.md'], options(client));
    assert.equal(result.stopped, '멈춤');
    assert.deepEqual(calls.sort(), [1, 2]);
    assert.equal(result.done, 0);
    assert.deepEqual(result.failed.map((f) => f.file), ['001.md']);
    assert.deepEqual(store!.analysis('002.md'), before);
    assert.equal(store!.analysis('003.md'), null);
    assert.equal(loggedCalls('002.md').filter((c) => c.ok === 1).length, 1);
  });
}

// ---- 분석하는 동안 원고가 바뀌거나 없어지면

const priorAnalysis = (file: string) => {
  store ??= AiStore.open(root);
  store.saveAnalysis({ file, contentHash: 'old', model: 'gpt-6-luna', modelVersion: 'v', promptVersion: 'extract-1', summary: '이전 분석', droppedQuotes: 0, costUsd: 0.5, createdAt: 't', entities: [], facts: [] });
  return store.analysis(file);
};

for (const [name, change] of [
  ['다른 본문으로 바뀜 (감독 재현)', () => writeFile(join(root, 'chapters', '001.md'), '# 1화\n\n본문을 고쳤다.\n')],
  ['파일이 없어짐', () => rm(join(root, 'chapters', '001.md'))],
] as const) {
  test(`원고 변경 (단일 조각): 응답을 기다리는 동안 ${name}이면 옛 응답으로 기존 분석을 바꾸지 않고 그 화만 실패로 남기며, 호출 기록은 남긴다`, async () => {
    const before = priorAnalysis('001.md');
    const client = fakeClient(async () => {
      await change();
      return { ...extraction('둘 다 스무 살이었다.'), summary: '옛 본문의 응답' };
    });
    const result = await analyzeChapters(['001.md'], options(client));
    assert.deepEqual(result.failed, [{ file: '001.md', message: CHANGED_WHILE_ANALYZING }]);
    assert.equal(result.stopped, null);
    // 그 화만 실패한 경우는 기존 규칙대로 처리한 화 수(done)에 들어간다
    assert.equal(result.done, 1);
    assert.deepEqual(store!.analysis('001.md'), before);
    const calls = loggedCalls('001.md');
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.ok === 1 && calls[0]!.cost_usd > 0);
  });
}

const longChapter = (n: number) => ['# 화', '', ...Array.from({ length: 12 }, (_, i) => [`${'가'.repeat(200)} ${n}화문장${i}이다.`, '']).flat()].join('\n');
async function chunkCount(file: string) {
  const { splitForExtraction } = await import('../../src/core/ai/extraction.ts');
  const { chapterLines } = await import('../../src/main/analyzer.ts');
  return splitForExtraction((await chapterLines(root, file)).lines).length;
}

for (const at of ['first', 'last'] as const) {
  test(`원고 변경 (여러 조각, ${at === 'first' ? '첫' : '마지막'} 조각 대기 중): 저장하지 않고, ${at === 'first' ? '새 조각을 더 보내지 않으며' : '조각을 더 보내지 않고'}, 보낸 조각의 기록은 남긴다`, async () => {
    await writeFile(join(root, 'chapters', '009.md'), longChapter(9));
    const chunks = await chunkCount('009.md');
    assert.ok(chunks >= 2);
    const before = priorAnalysis('009.md');
    const client = fakeClient(async (_c, n) => {
      if ((at === 'first' && n === 1) || (at === 'last' && n === chunks)) await writeFile(join(root, 'chapters', '009.md'), longChapter(9) + '\n고친 줄\n');
      return { summary: 's', entities: [], facts: [] };
    });
    const result = await analyzeChapters(['009.md'], options(client));
    assert.equal(client.calls.length, at === 'first' ? 1 : chunks);
    assert.deepEqual(result.failed, [{ file: '009.md', message: CHANGED_WHILE_ANALYZING }]);
    assert.equal(result.stopped, null);
    assert.deepEqual(store!.analysis('009.md'), before);
    assert.equal(loggedCalls('009.md').filter((c) => c.ok === 1).length, at === 'first' ? 1 : chunks);
  });
}

test('원고 변경: 바뀐 화만 실패로 남기고 다른 화는 계속 분석한다 (전역 중단이 아니다)', async () => {
  const client = fakeClient(async (call) => {
    if (call.user.includes('<chapter n="1">')) await writeFile(join(root, 'chapters', '001.md'), '# 1화\n\n고쳤다.\n');
    return extraction('x');
  });
  const result = await analyzeChapters(['001.md', '002.md', '003.md'], options(client));
  assert.equal(result.stopped, null);
  assert.deepEqual(result.failed.map((f) => f.file), ['001.md']);
  assert.equal(store!.analysis('001.md'), null);
  assert.ok(store!.analysis('002.md'));
  assert.ok(store!.analysis('003.md'));
  assert.equal(client.calls.length, 3);
});

test('원고 확인 뒤 취소: 마지막 응답 뒤 어느 시점에 취소하든 취소된 상태로 저장하는 일은 없다 (저장 호출을 직접 감시)', { timeout: 60_000 }, async () => {
  let notSaved = 0;
  for (let ticks = 0; ticks <= 12; ticks++) {
    store?.close();
    store = null;
    await rm(join(root, '.loreweave'), { recursive: true, force: true });
    const controller = new AbortController();
    const client = fakeClient(() => {
      let n = ticks;
      const later = () => (n-- <= 0 ? controller.abort() : setImmediate(later));
      setImmediate(later);
      return extraction('둘 다 스무 살이었다.');
    });
    const opts = options(client, controller.signal);
    const saves: boolean[] = [];
    const save = opts.store.saveAnalysis.bind(opts.store);
    opts.store.saveAnalysis = (a) => {
      saves.push(controller.signal.aborted);
      save(a);
    };
    const result = await analyzeChapters(['001.md'], opts);
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(saves.every((aborted) => !aborted), `${ticks}틱: 취소된 상태에서 저장했다`);
    if (saves.length === 0) {
      assert.equal(result.stopped, '취소했습니다');
      assert.equal(store!.analysis('001.md'), null);
      notSaved++;
    }
  }
  assert.ok(notSaved > 0);
});
