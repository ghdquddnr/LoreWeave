// 연속성 검사 실행과 저장 (M4-PLAN 1·3·4·5절). 가짜 AI 클라이언트로 네트워크 없이 확인한다.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';
import type { Extraction } from '../../src/core/ai/extraction.ts';
import { AiError, type AiClient, type JsonCall } from '../../src/main/ai-client.ts';
import { AiStore } from '../../src/main/ai-db.ts';
import { CHANGED_BEFORE_SEND, CHANGED_DURING_CHECK, changedFile, checkChapter, checkStates, planCheck, prepareCheck, runPreparedCheck } from '../../src/main/checker.ts';

const M0A = join(__dirname, '../../spikes/m0a-ai-feasibility/benchmark/chapters');
const usage = { inputTokens: 2000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 300 };
let root: string;
let store: AiStore | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loreweave-check-'));
  await mkdir(join(root, 'chapters'));
  for (const n of ['01', '02', '03']) await copyFile(join(M0A, `ch${n}.md`), join(root, 'chapters', `0${n}.md`));
});

afterEach(async () => {
  store?.close();
  store = null;
  await rm(root, { recursive: true, force: true });
});

const minsu = { name: '김민수', aliases: ['민수'] };
/** 화마다 추출 결과: 1화에서 민수의 나이, 3화에 민수가 나온다 */
const extractionOf = (n: number): Extraction =>
  n === 1
    ? { summary: '입학', entities: [minsu], facts: [{ entity: '김민수', predicate: '나이', value: '스무 살', quote: '둘 다 스무 살이었다.' }] }
    : { summary: `${n}화`, entities: n === 3 ? [minsu] : [{ name: '이지현', aliases: [] }], facts: [] };

const ageFinding = {
  category: 'age',
  target_quote: '"스물두 살입니다."',
  claim: '1화에서 민수는 스무 살이다. 몇 달 뒤 스물두 살일 수 없다.',
  evidence: [{ chapter: 1, quote: '둘 다 스무 살이었다.' }],
  confidence: 0.9,
};
const fakeFinding = { ...ageFinding, target_quote: '민수는 스물다섯 살입니다.' };

type Respond = (call: JsonCall, chapter: number) => unknown;
function fakeClient(detect: Respond = () => ({ findings: [ageFinding, fakeFinding] }), extract?: Respond): AiClient & { calls: JsonCall[] } {
  const calls: JsonCall[] = [];
  return {
    calls,
    async check() {},
    async json(call) {
      calls.push(call);
      const n = Number(/<chapter n="(\d+)">/.exec(call.user)![1]);
      const data = call.schema.name === 'chapter_extraction' ? (extract ?? ((_c, k) => extractionOf(k)))(call, n) : detect(call, n);
      return { data, usage, modelVersion: 'gpt-6-luna-test', latencyMs: 1 };
    },
  };
}

const options = (client: AiClient, signal = new AbortController().signal) => {
  store ??= AiStore.open(root);
  return { root, store, client, model: 'gpt-6-luna', signal, now: () => new Date('2026-10-25T00:00:00Z') };
};

test('계획: 1화와 번호 없는 화는 검사할 수 없고, 분석이 필요한 화와 예상 비용을 알려 준다', async () => {
  await assert.rejects(planCheck(root, null, '001.md', 'gpt-6-luna'), /앞 화가 없어/);
  await writeFile(join(root, 'chapters', '외전.md'), '본문\n');
  await assert.rejects(planCheck(root, null, '외전.md', 'gpt-6-luna'), /화 번호가 없어/);
  await writeFile(join(root, 'chapters', '3.md'), '본문\n');
  await assert.rejects(planCheck(root, null, '003.md', 'gpt-6-luna'), /화 번호가 같은 파일.*003\.md, 3\.md|화 번호가 같은 파일.*3\.md, 003\.md/);
  await rm(join(root, 'chapters', '3.md'));

  const before = await planCheck(root, null, '003.md', 'gpt-6-luna');
  assert.deepEqual(before.analyze, ['001.md', '002.md', '003.md']);
  assert.equal(before.priors, 2);
  assert.ok(before.costUsd > 0 && before.costUsd < 0.02);

  await checkChapter('003.md', options(fakeClient()));
  const after = await planCheck(root, store, '003.md', 'gpt-6-luna');
  assert.deepEqual(after.analyze, []);
  assert.ok(after.costUsd > 0 && after.costUsd < before.costUsd);
});

test('검사: 필요한 화를 먼저 분석하고, 원고에 있는 결과만 위치와 함께 저장한다', async () => {
  const before = await readFile(join(root, 'chapters', '003.md'));
  const client = fakeClient();
  const outcome = await checkChapter('003.md', options(client));
  assert.equal(outcome.stopped, null);
  assert.equal(outcome.checked, true);
  assert.equal(outcome.analysis?.done, 3);
  assert.deepEqual([outcome.findings, outcome.dropped], [1, 1]);
  assert.equal(outcome.costUsd.toFixed(5), ((4 * (2000 * 0.1 + 300 * 0.5)) / 1e6).toFixed(5));

  // 검사 입력: 3화에 나오는 민수의 1화 사실만 넘긴다
  const detect = client.calls.find((c) => c.schema.name === 'continuity_findings')!;
  assert.match(detect.user, /<facts chapter="1">\n- 김민수 \| 나이 \| 스무 살 \| 원문: "둘 다 스무 살이었다."\n<\/facts>/);
  assert.doesNotMatch(detect.user, /facts chapter="2"/);

  const saved = store!.check('003.md')!;
  assert.equal(saved.promptVersion, 'detect-1');
  assert.equal(saved.factCount, 1);
  assert.deepEqual(saved.inputs.map((i) => i.file), ['001.md', '002.md']);
  const [f] = saved.findings;
  assert.ok(f);
  assert.equal(f.dismissed, false);
  const lines3 = (await readFile(join(root, 'chapters', '003.md'), 'utf8')).split('\n');
  assert.equal(lines3[f.target.line]!.slice(f.target.start, f.target.end), '"스물두 살입니다."');
  const lines1 = (await readFile(join(root, 'chapters', '001.md'), 'utf8')).split('\n');
  const e = f.evidence[0]!;
  assert.equal(e.file, '001.md');
  assert.equal(lines1[e.line]!.slice(e.start, e.end), '둘 다 스무 살이었다.');
  assert.deepEqual(await readFile(join(root, 'chapters', '003.md')), before);
});

test('앞 화 분석이 실패하면 검사하지 않는다', async () => {
  const client = fakeClient(undefined, (_c, n) => {
    if (n === 2) throw new AiError('응답이 끝나지 않았습니다', 'incomplete');
    return extractionOf(n);
  });
  const outcome = await checkChapter('003.md', options(client));
  assert.equal(outcome.checked, false);
  assert.match(outcome.stopped!, /분석하지 못한 화가 있어 검사하지 않았습니다: 002\.md/);
  assert.ok(!client.calls.some((c) => c.schema.name === 'continuity_findings'));
  assert.equal(store!.check('003.md'), null);
});

test('검사 호출이 실패하면 저장하지 않고 이유를 알린다', async () => {
  const outcome = await checkChapter('003.md', options(fakeClient(() => ({ findings: [{ category: 'weather' }] }))));
  assert.match(outcome.stopped!, /검사 결과 형식이 다릅니다/);
  assert.equal(store!.check('003.md'), null);
  const keyProblem = await checkChapter('003.md', options(fakeClient(() => {
    throw new AiError('API 키가 올바르지 않습니다.', 'auth');
  })));
  assert.equal(keyProblem.stopped, 'API 키가 올바르지 않습니다.');
});

test('무시: 다시 검사해도 같은 문장의 결과는 숨고, 문장을 고치면 다시 보인다', async () => {
  await checkChapter('003.md', options(fakeClient()));
  const first = store!.check('003.md')!.findings[0]!;
  store!.dismiss('003.md', first.category, first.key, '2026-10-25T00:00:00Z');
  // 모델이 따옴표 없이 인용해도 원고의 같은 문장이면 같은 결과다
  await checkChapter('003.md', options(fakeClient(() => ({ findings: [{ ...ageFinding, target_quote: '스물두 살입니다.' }] }))));
  assert.equal(store!.check('003.md')!.findings[0]!.dismissed, true);

  const path = join(root, 'chapters', '003.md');
  await writeFile(path, (await readFile(path, 'utf8')).replace('"스물두 살입니다."', '"스물두 살입니다, 교수님."'));
  await checkChapter('003.md', options(fakeClient(() => ({ findings: [{ ...ageFinding, target_quote: '"스물두 살입니다, 교수님."' }] }))));
  const again = store!.check('003.md')!.findings[0]!;
  assert.equal(again.dismissed, false);
});

test('검사 상태: 없음 / 검사 뒤 그대로 / 이 화나 앞 화가 바뀌면 바뀜', async () => {
  store = AiStore.open(root);
  assert.deepEqual(await checkStates(root, store), { '001.md': 'none', '002.md': 'none', '003.md': 'none' });
  await checkChapter('003.md', options(fakeClient()));
  assert.equal((await checkStates(root, store))['003.md'], 'fresh');
  await writeFile(join(root, 'chapters', '002.md'), '# 2화\n\n바뀐 본문\n');
  assert.equal((await checkStates(root, store))['003.md'], 'stale');
  await checkChapter('003.md', options(fakeClient()));
  assert.equal((await checkStates(root, store))['003.md'], 'fresh');
  await rm(join(root, 'chapters', '001.md'));
  assert.equal((await checkStates(root, store))['003.md'], 'stale');
});

test('취소하면 검사를 보내지 않는다', async () => {
  const controller = new AbortController();
  const client = fakeClient(undefined, (_c, n) => {
    controller.abort();
    return extractionOf(n);
  });
  const outcome = await checkChapter('003.md', options(client, controller.signal));
  assert.equal(outcome.checked, false);
  assert.equal(outcome.stopped, '취소했습니다');
  assert.ok(!client.calls.some((c) => c.schema.name === 'continuity_findings'));
});

test('나눠 검사: 사실이 batchSize보다 많으면 묶음마다 따로 묻고, 같은 결과는 하나로 합친다', async () => {
  const many = (n: number): Extraction =>
    n === 1
      ? {
          summary: '입학',
          entities: [minsu],
          facts: [
            { entity: '김민수', predicate: '나이', value: '스무 살', quote: '둘 다 스무 살이었다.' },
            { entity: '김민수', predicate: '첫날', value: '대학생이 된 첫날', quote: '대학생이 된 첫날이었다.' },
            { entity: '김민수', predicate: '친구', value: '성진', quote: '성진은 민수 옆에 털썩 앉았다.' },
          ],
        }
      : extractionOf(n);
  const client = fakeClient(() => ({ findings: [ageFinding] }), (_c, n) => many(n));
  const outcome = await checkChapter('003.md', { ...options(client), batchSize: 2 });
  const detects = client.calls.filter((c) => c.schema.name === 'continuity_findings');
  assert.equal(detects.length, 2);
  assert.equal(detects.filter((c) => c.user.includes('둘 다 스무 살이었다.')).length, 1);
  assert.equal(outcome.findings, 1);
  const saved = store!.check('003.md')!;
  assert.equal(saved.factCount, 3);
  assert.equal(saved.findings.length, 1);
  assert.equal(saved.costUsd.toFixed(5), ((2 * (2000 * 0.1 + 300 * 0.5)) / 1e6).toFixed(5));
});

test('나눠 검사: 두 묶음이 같은 결과를 다른 설명·확신도로 내면, 저장·화면에는 확신도가 높은 묶음의 설명이 남는다 (낮은 확신도의 부정 설명이 높은 확신도로 보이지 않는다)', async () => {
  const many = (n: number): Extraction =>
    n === 1
      ? {
          summary: '입학',
          entities: [minsu],
          facts: [
            { entity: '김민수', predicate: '나이', value: '스무 살', quote: '둘 다 스무 살이었다.' },
            { entity: '김민수', predicate: '첫날', value: '대학생이 된 첫날', quote: '대학생이 된 첫날이었다.' },
            { entity: '김민수', predicate: '친구', value: '성진', quote: '성진은 민수 옆에 털썩 앉았다.' },
          ],
        }
      : extractionOf(n);
  // 첫 묶음: 낮은 확신도의 부정 설명, 둘째 묶음: 높은 확신도의 유효 설명
  const client = fakeClient(
    (call) => ({
      findings: [
        call.user.includes('둘 다 스무 살이었다.')
          ? { ...ageFinding, claim: '모순이라고 단정할 수 없다', confidence: 0.1 }
          : { ...ageFinding, claim: '나이가 맞지 않는다', confidence: 0.95 },
      ],
    }),
    (_c, n) => many(n),
  );
  const outcome = await checkChapter('003.md', { ...options(client), batchSize: 2 });
  assert.equal(outcome.findings, 1);
  assert.equal(outcome.lowConfidence, 0);
  const saved = store!.check('003.md')!;
  assert.equal(saved.findings.length, 1);
  assert.equal(saved.findings[0]!.claim, '나이가 맞지 않는다');
  assert.equal(saved.findings[0]!.confidence, 0.95);
});

test('나눠 검사: 묶음 하나라도 실패하면 저장하지 않는다', async () => {
  let n = 0;
  const client = fakeClient(() => {
    if (++n === 2) throw new AiError('응답이 끝나지 않았습니다', 'incomplete');
    return { findings: [ageFinding] };
  }, (_c, k) => (k === 1 ? { ...extractionOf(1), facts: [...extractionOf(1).facts, { entity: '김민수', predicate: '첫날', value: '대학생이 된 첫날', quote: '대학생이 된 첫날이었다.' }] } : extractionOf(k)));
  const outcome = await checkChapter('003.md', { ...options(client), batchSize: 1 });
  assert.equal(outcome.checked, false);
  assert.equal(outcome.stopped, '응답이 끝나지 않았습니다');
  assert.equal(store!.check('003.md'), null);
});

test('계획: 앞 화 사실이 CHECK_BATCH_SIZE보다 많으면 나눠 검사할 횟수와 그만큼의 비용을 어림한다', async () => {
  await checkChapter('003.md', options(fakeClient()));
  const small = await planCheck(root, store, '003.md', 'gpt-6-luna');
  assert.equal(small.batches, 1);
  // 1화에 사실 450개가 있다고 친다
  const first = store!.analysis('001.md')!;
  const fact = first.facts[0]!;
  store!.saveAnalysis({ ...first, facts: Array.from({ length: 450 }, () => fact) });
  const big = await planCheck(root, store, '003.md', 'gpt-6-luna');
  assert.deepEqual(big.analyze, []);
  assert.equal(big.batches, 2);
  assert.ok(big.costUsd > small.costUsd);
});

test('확신도가 MIN_CONFIDENCE보다 낮은 결과는 저장하되 보이는 수에서 뺀다', async () => {
  const low = { ...ageFinding, category: 'number', claim: '모순은 아니다', confidence: 0.1 };
  const outcome = await checkChapter('003.md', options(fakeClient(() => ({ findings: [ageFinding, low] }))));
  assert.deepEqual([outcome.findings, outcome.lowConfidence], [1, 1]);
  assert.deepEqual(store!.check('003.md')!.findings.map((f) => f.confidence), [0.9, 0.1]);
});

// ---- 묶음 실패·취소 뒤 추가 전송 막기

/** 1화 사실 5개: batchSize 1이면 3화 검사가 5묶음이 된다 */
const five = (n: number): Extraction =>
  n === 1 ? { ...extractionOf(1), facts: Array.from({ length: 5 }, (_, i) => ({ entity: '김민수', predicate: '나이', value: `스무 살 ${i}`, quote: '둘 다 스무 살이었다.' })) } : extractionOf(n);

/** 추출은 바로 답하고, 검사 요청은 테스트가 하나씩 풀어 준다. 동시에 진행 중인 검사 수의 최댓값을 센다 */
function deferredClient() {
  const pending: { resolve(data: unknown): void; reject(e: unknown): void }[] = [];
  let inFlight = 0;
  const client = {
    detects: 0,
    maxInFlight: 0,
    async check() {},
    async json(call: JsonCall) {
      const n = Number(/<chapter n="(\d+)">/.exec(call.user)![1]);
      if (call.schema.name === 'chapter_extraction') return { data: five(n), usage, modelVersion: 'gpt-6-luna-test', latencyMs: 1 };
      client.detects++;
      inFlight++;
      client.maxInFlight = Math.max(client.maxInFlight, inFlight);
      try {
        const data = await new Promise<unknown>((resolve, reject) => pending.push({ resolve, reject }));
        return { data, usage, modelVersion: 'gpt-6-luna-test', latencyMs: 1 };
      } finally {
        inFlight--;
      }
    },
  };
  return { client, pending };
}

const until = async (cond: () => boolean) => {
  const end = Date.now() + 10_000;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
  assert.ok(cond(), '기다린 조건이 오지 않았습니다');
};

/** 검사 호출 기록 (ok, 비용) */
function checkCalls(): { ok: number; cost_usd: number }[] {
  const db = new DatabaseSync(join(root, '.loreweave', 'ai.db'), { readOnly: true });
  try {
    return db.prepare("SELECT ok, cost_usd FROM calls WHERE kind = 'check' ORDER BY id").all() as { ok: number; cost_usd: number }[];
  } finally {
    db.close();
  }
}

for (const [name, fail] of [
  ['인증 오류', (p: { reject(e: unknown): void }) => p.reject(Object.assign(new AiError('API 키가 올바르지 않습니다', 'auth'), { usage }))],
  ['일반 최종 실패', (p: { reject(e: unknown): void }) => p.reject(new AiError('OpenAI 오류 (500)', 'other'))],
  ['응답 형식 오류', (p: { resolve(d: unknown): void }) => p.resolve({ findings: 'bad' })],
] as const) {
  test(`묶음 실패(${name}): 5묶음 중 첫 묶음이 실패하면 이미 보낸 둘째까지만 보내고, 기록은 남기고, 저장하지 않는다`, { timeout: 20_000 }, async () => {
    // 먼저 정상 검사를 하나 저장해 둔다 (실패한 검사가 지우거나 바꾸지 않아야 한다)
    const ok = deferredClient();
    const firstRun = checkChapter('003.md', { ...options(ok.client as unknown as AiClient), batchSize: 1 });
    for (let i = 0; i < 5; i++) {
      await until(() => ok.pending.length > i);
      ok.pending[i]!.resolve({ findings: [] });
    }
    assert.equal((await firstRun).checked, true);
    const saved = store!.check('003.md')!;
    const callsBefore = checkCalls().length;

    const { client, pending } = deferredClient();
    const run = checkChapter('003.md', { ...options(client as unknown as AiClient), batchSize: 1 });
    await until(() => pending.length === 2);
    fail(pending[0] as never);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(client.detects, 2);
    pending[1]!.resolve({ findings: [] });
    const outcome = await run;
    assert.equal(outcome.checked, false);
    assert.ok(outcome.stopped);
    assert.equal(client.detects, 2);
    assert.equal(client.maxInFlight, 2);
    assert.deepEqual(store!.check('003.md'), saved);
    // 둘째 묶음(성공)은 기록된다. 첫 묶음은 usage가 있을 때만 기록된다
    const calls = checkCalls().slice(callsBefore);
    assert.ok(calls.some((c) => c.ok === 1 && c.cost_usd > 0));
    assert.equal(calls.length, name === '일반 최종 실패' ? 1 : 2);
  });
}

test('취소: 검사를 시작하기 전에 취소하면 검사 요청을 하나도 보내지 않는다', async () => {
  const { client } = deferredClient();
  const controller = new AbortController();
  controller.abort();
  const outcome = await checkChapter('003.md', { ...options(client as unknown as AiClient, controller.signal), batchSize: 1 });
  assert.equal(outcome.checked, false);
  assert.equal(client.detects, 0);
  assert.equal(store!.check('003.md'), null);
});

test('취소: 두 묶음이 나간 뒤 취소하면 새 묶음을 보내지 않고, 늦게 성공한 응답도 저장하지 않는다 (호출 기록은 남긴다)', { timeout: 20_000 }, async () => {
  const { client, pending } = deferredClient();
  const controller = new AbortController();
  const run = checkChapter('003.md', { ...options(client as unknown as AiClient, controller.signal), batchSize: 1 });
  await until(() => pending.length === 2);
  controller.abort();
  // provider가 취소를 무시하고 늦게 성공했다
  pending[0]!.resolve({ findings: [ageFinding] });
  pending[1]!.resolve({ findings: [] });
  const outcome = await run;
  assert.equal(outcome.checked, false);
  assert.equal(outcome.stopped, '취소했습니다');
  assert.equal(client.detects, 2);
  assert.equal(store!.check('003.md'), null);
  assert.equal(checkCalls().filter((c) => c.ok === 1).length, 2);
});

test('정상: 5묶음은 동시에 최대 2개씩 모두 보내고 결과를 합쳐 저장한다', { timeout: 20_000 }, async () => {
  const { client, pending } = deferredClient();
  const run = checkChapter('003.md', { ...options(client as unknown as AiClient), batchSize: 1 });
  for (let i = 0; i < 5; i++) {
    await until(() => pending.length > i);
    pending[i]!.resolve({ findings: [ageFinding] });
  }
  const outcome = await run;
  assert.equal(outcome.checked, true);
  assert.equal(client.detects, 5);
  assert.equal(client.maxInFlight, 2);
  assert.equal(store!.check('003.md')!.findings.length, 1);
  assert.equal(store!.check('003.md')!.factCount, 5);
});

test('취소: API 응답이 다 온 뒤 근거 화를 읽는 동안 취소해도 저장하지 않는다 (감독 재현, 호출 기록은 남긴다)', { timeout: 20_000 }, async () => {
  const { client, pending } = deferredClient();
  const controller = new AbortController();
  const run = checkChapter('003.md', { ...options(client as unknown as AiClient, controller.signal), batchSize: 1 });
  for (let i = 0; i < 5; i++) {
    await until(() => pending.length > i);
    pending[i]!.resolve({ findings: [ageFinding] });
    if (i === 4) setImmediate(() => controller.abort());
  }
  const outcome = await run;
  assert.equal(controller.signal.aborted, true);
  assert.equal(outcome.checked, false);
  assert.equal(outcome.stopped, '취소했습니다');
  assert.equal(store!.check('003.md'), null);
  // 다섯 묶음 모두 보냈고 끝났으므로 호출 기록과 비용은 모두 남는다
  const calls = checkCalls();
  assert.equal(calls.filter((c) => c.ok === 1).length, 5);
  assert.ok(outcome.costUsd > 0);
});

test('취소: 마지막 응답 뒤 어느 시점에 취소하든 취소된 상태로 저장하는 일은 없다 (저장 호출을 직접 감시)', { timeout: 60_000 }, async () => {
  let duringEvidence = 0;
  for (let ticks = 0; ticks <= 12; ticks++) {
    // 회마다 새 ai.db로 시작한다 (먼저 닫고 지운다)
    store?.close();
    store = null;
    await rm(join(root, '.loreweave'), { recursive: true, force: true });
    const { client, pending } = deferredClient();
    const controller = new AbortController();
    const opts = { ...options(client as unknown as AiClient, controller.signal), batchSize: 1 };
    const saves: boolean[] = [];
    const save = opts.store.saveCheck.bind(opts.store);
    opts.store.saveCheck = (c) => {
      saves.push(controller.signal.aborted);
      save(c);
    };
    const run = checkChapter('003.md', opts);
    for (let i = 0; i < 5; i++) {
      await until(() => pending.length > i);
      pending[i]!.resolve({ findings: [ageFinding] });
    }
    // 마지막 응답 뒤 ticks번째 이벤트 루프에서 취소한다
    let n = ticks;
    const later = () => (n-- <= 0 ? controller.abort() : setImmediate(later));
    setImmediate(later);
    const outcome = await run;
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(saves.every((aborted) => !aborted), `${ticks}틱: 취소된 상태에서 저장했다`);
    if (outcome.checked) assert.equal(saves.length, 1);
    else {
      assert.equal(saves.length, 0);
      assert.equal(store!.check('003.md'), null);
      duringEvidence++;
    }
  }
  // 적어도 한 번은 API 응답 뒤(근거 읽기·저장 전) 취소가 걸려 저장을 막았다
  assert.ok(duringEvidence > 0);
});

// ---- 검사 중 원고 버전이 섞이지 않게

/** 정상 검사로 경고 하나를 저장해 둔다 */
async function savedCheck() {
  const first = await checkChapter('003.md', options(fakeClient(() => ({ findings: [ageFinding] }))));
  assert.equal(first.findings, 1);
  return store!.check('003.md')!;
}

for (const [name, change, expectDeleted] of [
  ['근거 문장이 바뀜 (감독 재현)', async () => {
    const p = join(root, 'chapters', '001.md');
    await writeFile(p, (await readFile(p, 'utf8')).replace('둘 다 스무 살이었다.', '두 사람의 나이는 알 수 없었다.'));
  }, false],
  ['검사하는 화가 바뀜', async () => {
    const p = join(root, 'chapters', '003.md');
    await writeFile(p, (await readFile(p, 'utf8')) + '\n덧붙인 줄\n');
  }, false],
  ['근거 화 파일이 없어짐', async () => rm(join(root, 'chapters', '001.md')), true],
] as const) {
  test(`버전: 응답을 기다리는 동안 ${name}이면 새 검사를 저장하지 않고 기존 결과를 지키며, 호출 기록은 남긴다`, { timeout: 20_000 }, async () => {
    const before = await savedCheck();
    const callsBefore = checkCalls().length;
    const { client, pending } = deferredClient();
    const run = checkChapter('003.md', { ...options(client as unknown as AiClient), batchSize: 100 });
    await until(() => pending.length === 1);
    await change();
    // 옛 인용을 담은 성공 응답이 돌아온다
    pending[0]!.resolve({ findings: [ageFinding] });
    const outcome = await run;
    assert.equal(outcome.checked, false);
    assert.equal(outcome.stopped, CHANGED_DURING_CHECK);
    assert.deepEqual(store!.check('003.md'), before);
    assert.equal(checkCalls().length, callsBefore + 1);
    assert.equal(checkCalls().at(-1)!.ok, 1);
    assert.equal(expectDeleted, !existsSync(join(root, 'chapters', '001.md')));
  });
}

test('버전: 검사를 준비한 뒤 보내기 전에 원고가 바뀌면 호출하지 않는다', async () => {
  const before = await savedCheck();
  const prepared = await prepareCheck('003.md', { root, store: store! });
  assert.ok(typeof prepared !== 'string');
  const p = join(root, 'chapters', '001.md');
  await writeFile(p, (await readFile(p, 'utf8')) + '\n덧붙인 줄\n');
  const client = fakeClient();
  const r = await runPreparedCheck(prepared, options(client));
  assert.equal(r.stopped, CHANGED_BEFORE_SEND);
  assert.equal(client.calls.length, 0);
  assert.deepEqual(store!.check('003.md'), before);
});

test('버전: 원고가 그대로면 같은 검사가 정상 저장된다 (회귀)', async () => {
  await savedCheck();
  const prepared = await prepareCheck('003.md', { root, store: store! });
  assert.ok(typeof prepared !== 'string');
  assert.equal(await changedFile(root, prepared), null);
  const r = await runPreparedCheck(prepared, options(fakeClient(() => ({ findings: [ageFinding] }))));
  assert.equal(r.checked, true);
  assert.equal(r.findings, 1);
});
