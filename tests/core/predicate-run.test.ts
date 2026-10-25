// M9 후속 실험 runner (scripts/lib/predicate-run.ts). 가짜 AI 클라이언트로 네트워크 없이 확인한다.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { DETECT_PROMPT_VERSION, DETECT_SCHEMA, DETECT_SYSTEM, type PriorFact } from '../../src/core/ai/detection.ts';
import type { Extraction } from '../../src/core/ai/extraction.ts';
import { AiError, type AiClient, type JsonCall } from '../../src/main/ai-client.ts';
import { AiStore } from '../../src/main/ai-db.ts';
import { filesFingerprint } from '../../scripts/lib/m9-preflight.ts';
import { additionReason, FIXED_JUDGE_SET, PREDICATE_PROMPT, PREDICATE_STAGE, realSummary, runPredicate } from '../../scripts/lib/predicate-run.ts';
import { M9_STAGE, StageLedger } from '../../scripts/lib/stage-ledger.ts';
import { extractionOf, fakeClient, makeBaseline, MANY, REPO, tamper, TARGETS, usage } from './fixtures/m9-fixture.ts';

/** 1화에 인물이 아닌 대상(한결대학교)의 "위치" 사실 30개, 3화에 김민수의 "위치 (오늘)" 사실 하나: 3화 검사에서만 30개가 더해진다 */
const PLACE = '한결대학교 대운동장은 입학식에 온 신입생과 가족들로 북적였다.';
const extract = (n: number): Extraction => {
  const base = extractionOf(n);
  if (n === 1)
    return {
      ...base,
      entities: [...base.entities, { name: '한결대학교', aliases: [] }],
      facts: [...base.facts, ...Array.from({ length: 30 }, (_, i) => ({ entity: '한결대학교', predicate: '위치', value: `장소 ${i}`, quote: PLACE }))],
    };
  if (n === 3) return { ...base, facts: [{ entity: '김민수', predicate: '위치 (오늘)', value: '기차', quote: '창밖으로 북한강이 지나가고 있었다.' }] };
  return base;
};

let tmp: string;
let m4: string;
let real: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'loreweave-m9p-'));
  m4 = join(tmp, 'm4base');
  real = join(tmp, 'realbase');
  await makeBaseline(m4, extract);
  await makeBaseline(real, extract);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const APPROVAL = 'm9p-predicate-test-0001';
type Over = Partial<Parameters<typeof runPredicate>[0]> & { client?: AiClient; m4Pass?: (label: string) => boolean };
function options(over: Over = {}) {
  const connected: number[] = [];
  const client = (over.client ?? fakeClient(undefined, usage, extract)) as ReturnType<typeof fakeClient>;
  const pass = over.m4Pass ?? (() => true);
  const o: Parameters<typeof runPredicate>[0] = {
    m4: { baseline: m4, predictions: null, targets: TARGETS },
    real: { baseline: real, predictions: join(real, 'review', 'eval', 'predictions.json'), targets: TARGETS },
    work: join(tmp, `work-${Math.random().toString(36).slice(2)}`),
    repoRoot: REPO,
    run: false,
    connect: () => {
      connected.push(1);
      return client;
    },
    scoreM4: (label) => ({ run: label, pass: pass(label) }),
    scoreReal: (label, p) => ({ run: label, chapters: p.chapters.length }),
    ...over,
  };
  return { o, connected, client };
}
const runOpts = (over: Over = {}) => options({ run: true, approval: APPROVAL, ledgerDir: join(tmp, 'ledger'), ...over });
const sources = () => filesFingerprint([join(m4, '.loreweave', 'ai.db'), join(real, '.loreweave', 'ai.db'), join(real, 'chapters', '003.md'), join(real, 'review', 'eval', 'predictions.json')]);

// ---- 대조 (기본 경로)

test('기본(대조만): 두 데이터셋 다섯 회차를 대조하고, 연결·호출·장부가 없다. 화별 추가 수와 묶음은 공개 집계에, fingerprint는 작업 폴더에만', async () => {
  const before = sources();
  const { o, connected, client } = options();
  const r = await runPredicate(o);
  assert.equal(r.stage, 'preflight-ok', r.reason ?? '');
  assert.equal(connected.length + client.calls.length, 0);
  assert.equal(existsSync(join(tmp, 'ledger')), false);
  assert.deepEqual(r.preflight.map((p) => p.label), ['m4-1', 'm4-2', 'm4-3', 'real-1', 'real-2']);
  for (const p of r.preflight) {
    assert.equal(p.base.ok, true);
    assert.deepEqual(p.base.skipped, p.label.startsWith('m4') ? ['order'] : []);
    assert.deepEqual(p.addition.facts, { base: MANY * 2, added: 30 });
    assert.deepEqual(p.addition.batches, { base: 4, plus: 4 });
    assert.deepEqual(p.addition.perChapter.map((c) => [c.chapter, c.added]), [[2, 0], [3, 30]]);
  }
  const pub = JSON.stringify(r.preflight);
  assert.ok(!/[0-9a-f]{64}/.test(pub) && !pub.includes('장소'));
  assert.match(readFileSync(join(o.work, 'preflight-m4-1.json'), 'utf8'), /plusFingerprint/);
  assert.equal(sources(), before);
});

test('실행 조건: 승인 ID나 장부 폴더가 없거나 잘못되면 아무것도 만들지 않고 연결하지 않는다', async () => {
  for (const over of [{ approval: undefined }, { approval: 'X' }, { ledgerDir: undefined }, { ledgerDir: join(m4, 'ledger') }, { ledgerDir: join(REPO, 'm9p-ledger-should-not-exist') }] as Over[]) {
    const { o, connected } = runOpts(over);
    const r = await runPredicate(o);
    assert.equal(r.stage, 'refused', JSON.stringify(over));
    assert.equal(connected.length, 0);
    assert.equal(existsSync(o.work), false);
  }
  // M4 순서 대조 생략은 M4에만, 실제 원고는 반드시 대조
  const swapped = options({ m4: { baseline: m4, predictions: join(real, 'review', 'eval', 'predictions.json'), targets: TARGETS } });
  assert.equal((await runPredicate(swapped.o)).stage, 'refused');
  const noOrder = options({ real: { baseline: real, predictions: null, targets: TARGETS } });
  assert.equal((await runPredicate(noOrder.o)).stage, 'refused');
});

test('대조: 기준 사실의 인용이 바뀌면 실패하고, 실행이어도 연결·호출 0', async () => {
  tamper(real, "UPDATE facts SET quote = '김민수는 웃었다.' WHERE ord = 0 AND analysis_id = (SELECT id FROM analyses WHERE file = '001.md')");
  const { o, connected, client } = runOpts();
  const r = await runPredicate(o);
  assert.equal(r.stage, 'preflight-failed');
  assert.equal(connected.length + client.calls.length, 0);
  assert.equal(existsSync(join(tmp, 'ledger')), false);
});

test('추가 요청 검사: 기존 사실 보존·순서, 중복, 화 순서, 400개 경계를 어기면 이유를 돌려준다', () => {
  const f = (chapter: number, i: number): PriorFact => ({ chapter, entity: 'e', predicate: 'p', value: `v${i}`, quote: 'q' });
  const base = [f(1, 0), f(1, 1), f(2, 2)];
  const plus = [f(1, 0), f(1, 9), f(1, 1), f(2, 2)];
  assert.equal(additionReason(base, plus, [plus]), null);
  assert.match(additionReason(base, [f(1, 0), f(2, 2)], [[f(1, 0), f(2, 2)]])!, /빠졌거나/);
  assert.match(additionReason(base, [f(1, 1), f(1, 0), f(2, 2)], [[f(1, 1), f(1, 0), f(2, 2)]])!, /빠졌거나 순서/);
  assert.match(additionReason(base, [...plus, f(1, 0)], [[...plus, f(1, 0)]])!, /두 번/);
  assert.match(additionReason(base, [f(2, 2), f(1, 0), f(1, 1)], [[f(2, 2), f(1, 0), f(1, 1)]])!, /화 순서/);
  const many = Array.from({ length: 5 }, (_, i) => f(1, i));
  assert.equal(additionReason([], many, [many.slice(0, 2), many.slice(2, 4), many.slice(4)], 2), null);
  assert.match(additionReason([], many, [many.slice(0, 3), many.slice(3)], 2)!, /묶음 수/);
  assert.match(additionReason([], many, [many.slice(0, 1), many.slice(1, 3), many.slice(3)], 2)!, /경계/);
});

// ---- 실행

test('실행: M4 3회 → 실제 원고 2회, detect-1과 추가 요청을 보내고 회차마다 따로 저장·집계한다', async () => {
  const before = sources();
  const { o, client } = runOpts();
  const r = await runPredicate(o);
  assert.equal(r.stage, 'done', r.reason ?? '');
  // 회마다 2화 2묶음 + 3화 2묶음
  assert.equal(client.calls.length, 5 * 4);
  assert.ok(client.calls.every((c) => c.system === DETECT_SYSTEM && c.schema === DETECT_SCHEMA && c.maxOutputTokens === 16_000));
  const third = client.calls.filter((c) => c.user.includes('<chapter n="3">'));
  assert.equal(third.length, 5 * 2);
  assert.ok(third.every((c) => (c.user.match(/^- /gm) ?? []).length <= 400));
  assert.equal(third.slice(0, 2).reduce((n, c) => n + (c.user.match(/장소 \d+/g) ?? []).length, 0), 30);
  assert.equal(r.m4Scores.length, 3);
  assert.equal(r.realSummaries.length, 2);
  assert.deepEqual(Object.entries(r.stageSummary!.runs).map(([k, v]) => [k, v.state]), [['m4-1', 'done'], ['m4-2', 'done'], ['m4-3', 'done'], ['real-1', 'done'], ['real-2', 'done']]);
  const s = AiStore.open(join(o.work, 'real', 'run-2'));
  try {
    assert.equal(s.check('003.md')!.promptVersion, PREDICATE_PROMPT.version);
  } finally {
    s.close();
  }
  assert.equal(DETECT_PROMPT_VERSION, 'detect-1');
  assert.equal(sources(), before);
  assert.equal(existsSync(join(o.work, 'real', 'run-1', 'eval', 'predictions.json')), true);
});

test('M4 관문: 한 회라도 기준 8에 미달하면 실제 원고 회차를 시작하지 않는다', async () => {
  const { o, client } = runOpts({ m4Pass: (label) => label !== 'm4-2' });
  const r = await runPredicate(o);
  assert.equal(r.stage, 'm4-failed');
  assert.equal(client.calls.length, 2 * 4);
  assert.deepEqual(Object.keys(r.stageSummary!.runs), ['m4-1', 'm4-2']);
  const s = AiStore.open(join(o.work, 'real', 'run-1'));
  try {
    assert.equal(s.check('003.md')!.promptVersion, 'detect-1');
  } finally {
    s.close();
  }
});

test('재시작·장부: 시작한 회차가 있으면 다시 하지 않고, M9 장부나 다른 승인 ID의 장부로는 열지 않는다', async () => {
  const first = await runPredicate(runOpts({ m4Pass: () => false }).o);
  assert.equal(first.stage, 'm4-failed');
  const again = runOpts();
  const r = await runPredicate(again.o);
  assert.equal(r.stage, 'refused');
  assert.match(r.reason!, /m4-1\(done\)/);
  assert.equal(again.connected.length, 0);

  const other = runOpts({ approval: 'm9p-predicate-test-0002' });
  assert.match((await runPredicate(other.o)).reason!, /승인 ID/);
  assert.equal(other.connected.length, 0);

  const m9 = join(tmp, 'm9-ledger');
  StageLedger.open(m9, M9_STAGE).close();
  const reuse = runOpts({ ledgerDir: m9 });
  assert.match((await runPredicate(reuse.o)).reason!, /단계/);
  assert.equal(reuse.connected.length, 0);
  assert.notEqual(PREDICATE_STAGE.id, M9_STAGE.id);
});

test('실행: 연결하는 동안 실제 원고 복사본 본문이 바뀌면 첫 호출 전에 멈춘다 (호출 0)', async () => {
  const client = fakeClient(undefined, usage, extract);
  const work = join(tmp, 'work-x');
  const r = await runPredicate(
    runOpts({
      work,
      client,
      connect: () => {
        const file = join(work, 'real', 'run-2', 'chapters', '003.md');
        writeFileSync(file, readFileSync(file, 'utf8') + '\n덧붙임\n');
        return client;
      },
    }).o,
  );
  assert.equal(r.stage, 'stopped');
  assert.match(r.reason!, /real-2 003\.md/);
  assert.equal(client.calls.length, 0);
});

test('중간 실패: 재시도까지 실패하면 그 회차를 멈추고, 실패한 시도의 예약액을 지출로 남기며 실제 원고로 가지 않는다', async () => {
  const seen = new Map<string, number>();
  const base = fakeClient(undefined, usage, extract);
  const client = {
    calls: base.calls,
    check: async () => {},
    json: async (call: JsonCall) => {
      const k = (seen.get(call.user) ?? 0) + 1;
      seen.set(call.user, k);
      // 2화 첫 묶음: m4-1에서 1번째는 성공, m4-2에서 2번째(처음)와 3번째(재시도)는 연결 오류
      if (call.user.includes('<chapter n="2">') && call.user.includes('| 값 0 |') && (k === 2 || k === 3)) throw new AiError('연결 끊김', 'network');
      return base.json(call);
    },
  };
  const { o } = runOpts({ client });
  const r = await runPredicate(o);
  assert.equal(r.stage, 'stopped');
  assert.equal(r.stageSummary!.runs['m4-2']!.state, 'stopped');
  assert.equal(r.stageSummary!.runs['m4-2']!.unknown, 2);
  assert.equal(r.stageSummary!.runs['real-1'], undefined);
  assert.equal(r.ledger!.inFlight, 0);
  assert.ok(r.ledger!.unknownUsage === 2 && r.ledger!.spent > 0);
});

test('예산: 상한 비용 한 번분도 안 되면 첫 호출 전에 멈춘다', async () => {
  const { o, client } = runOpts({ stage: { id: 'm9p-small', limitUsd: 0.001 } });
  const r = await runPredicate(o);
  assert.equal(r.stage, 'stopped');
  assert.match(r.reason!, /한도/);
  assert.equal(client.calls.length, 0);
});

// ---- 실제 원고 집계

test('실제 원고 집계: 기존 고정 12개 judge와 새 입력 기준 judge를 따로 센다', () => {
  const m8 = JSON.parse(readFileSync(join(REPO, 'spikes', 'm8-real', 'results.json'), 'utf8')) as { seeds: { id: string; retrieved: boolean }[] };
  assert.deepEqual([...FIXED_JUDGE_SET], m8.seeds.filter((s) => s.retrieved).map((s) => s.id));
  const per_error = Object.fromEntries(m8.seeds.map((s) => [s.id, s.retrieved || s.id === 'S09']));
  const findings = ['S03', 'S06', 'S09', 'S13', 'S20', 'S04'].map((id, i) => ({ label: 'tp', error_id: id, target_chapter: i, finding: { confidence: 0.9 } }));
  findings.push({ label: 'unlabeled', error_id: undefined as unknown as string, target_chapter: 99, finding: { confidence: 0.8 } });
  const s = realSummary('real-1', { retrieval: { per_error }, findings });
  assert.deepEqual(s.judgeFixed12, { found: 4, total: 12, regressionTarget: 6 });
  assert.deepEqual(s.judgeNew, { found: 5, total: 13, recordOnly: true });
  assert.deepEqual(s.outsideGroundTruth, [{ id: 'real-1-u1', chapter: 99, verdict: '' }]);
  assert.equal(s.humanJudgment, 'pending');
});

// ---- 공유 중단과 취소 (묶음 4개 이상)

/** 1화 사실 1,250개: 2화·3화 검사가 4묶음씩 된다 */
const big = (n: number): Extraction => {
  const e = extract(n);
  return n === 1 ? { ...e, facts: Array.from({ length: 1250 }, (_, i) => ({ ...e.facts[i % MANY]!, value: `값 ${i}` })) } : e;
};

/** 요청마다 직접 풀어 주는 가짜 클라이언트. signal이 끊기면 그 요청은 취소 오류로 끝난다 */
function gatedClient() {
  const pending: { call: JsonCall; resolve(data?: unknown): void; reject(e: unknown): void; settled: boolean }[] = [];
  const client = {
    calls: [] as JsonCall[],
    check: async () => {},
    json(call: JsonCall) {
      client.calls.push(call);
      return new Promise<{ data: unknown; usage: typeof usage; modelVersion: string; latencyMs: number }>((resolve, reject) => {
        const p = {
          call,
          settled: false,
          resolve: (data: unknown = { findings: [] }) => {
            p.settled = true;
            resolve({ data, usage, modelVersion: 'gpt-6-luna-test', latencyMs: 1 });
          },
          reject: (e: unknown) => {
            p.settled = true;
            reject(e);
          },
        };
        call.signal?.addEventListener('abort', () => !p.settled && p.reject(new Error('aborted')), { once: true });
        pending.push(p);
      });
    },
  };
  return { client, pending };
}
/** 대조(파일 복사·DB)가 끝나고 요청이 나갈 때까지 기다린다 (최대 30초) */
const until = async (cond: () => boolean) => {
  const end = Date.now() + 30_000;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), '기다린 조건이 오지 않았습니다');
};

async function bigBaselines() {
  await rm(m4, { recursive: true, force: true });
  await rm(real, { recursive: true, force: true });
  await makeBaseline(m4, big);
  await makeBaseline(real, big);
}

/** 첫 묶음과 둘째 묶음이 동시에 나간 상태에서 첫 묶음을 fail로 끝내고, 둘째는 성공시킨다 */
async function failFirst(fail: (p: ReturnType<typeof gatedClient>['pending'][number]) => void, expectedSends: number) {
  await bigBaselines();
  const { client, pending } = gatedClient();
  const { o } = runOpts({ client });
  const run = runPredicate(o);
  await until(() => pending.length === 2);
  fail(pending[0]!);
  // 재시도가 있으면 그 시도도 기다렸다가 실패시킨다
  for (let i = 2; i < expectedSends; i++) {
    await until(() => pending.length === i + 1);
    pending[i]!.reject(new AiError('연결 끊김', 'network'));
  }
  await new Promise((r) => setTimeout(r, 20));
  pending[1]!.resolve();
  const r = await run;
  return { r, client, pending, o };
}

async function assertHaltedAfterFirstChapter(r: Awaited<ReturnType<typeof runPredicate>>, o: Parameters<typeof runPredicate>[0], sends: number, client: { calls: JsonCall[] }) {
  assert.equal(r.stage, 'stopped', r.reason ?? '');
  assert.equal(client.calls.length, sends, `보낸 요청 ${client.calls.length}`);
  assert.ok(client.calls.every((c) => c.user.includes('<chapter n="2">')));
  assert.equal(r.ledger!.inFlight, 0);
  assert.equal(r.ledger!.attempts, sends);
  assert.deepEqual(Object.keys(r.stageSummary!.runs), ['m4-1']);
  assert.equal(r.stageSummary!.runs['m4-1']!.state, 'stopped');
  // 그 화는 저장하지 않았다 (복사본의 검사 기록은 기준의 detect-1 그대로)
  const s = AiStore.open(join(o.work, 'm4', 'run-1'));
  try {
    assert.equal(s.check('002.md')!.promptVersion, 'detect-1');
    assert.equal(s.check('003.md')!.promptVersion, 'detect-1');
  } finally {
    s.close();
  }
}

for (const [name, kind] of [['인증(auth)', 'auth'], ['모델(model)', 'model']] as const) {
  test(`공유 중단: 4묶음 중 첫 묶음이 ${name} 오류면, 이미 보낸 둘째만 정산하고 새 묶음·다음 화·실제 원고를 보내지 않는다`, { timeout: 60_000 }, async () => {
    const { r, client, o } = await failFirst((p) => p.reject(new AiError('합성 오류', kind)), 2);
    await assertHaltedAfterFirstChapter(r, o, 2, client);
    assert.equal(r.ledger!.unknownUsage, 1);
  });
}

test('공유 중단: 첫 묶음이 재시도까지 소진되면 새 묶음을 보내지 않는다 (보낸 것: 첫 묶음, 재시도, 둘째 묶음)', { timeout: 60_000 }, async () => {
  const { r, client, o } = await failFirst((p) => p.reject(new AiError('연결 끊김', 'network')), 3);
  await assertHaltedAfterFirstChapter(r, o, 3, client);
  assert.equal(r.ledger!.unknownUsage, 2);
});

test('공유 중단: 첫 묶음의 응답 형식이 틀리면 새 묶음을 보내지 않고 그 화를 저장하지 않는다', { timeout: 60_000 }, async () => {
  const { r, client, o } = await failFirst((p) => p.resolve({ findings: 'bad' }), 2);
  await assertHaltedAfterFirstChapter(r, o, 2, client);
  assert.equal(r.ledger!.unknownUsage, 0);
  assert.match(r.reason!, /형식|findings/);
});

test('취소: 두 묶음이 나간 사이 밖에서 취소하면 진행 중 요청을 끊고, 예약액을 지출로 남기고, 새 요청·다음 회차를 보내지 않는다', { timeout: 60_000 }, async () => {
  await bigBaselines();
  const { client, pending } = gatedClient();
  const cancel = new AbortController();
  const { o } = runOpts({ client, signal: cancel.signal });
  const run = runPredicate(o);
  await until(() => pending.length === 2);
  cancel.abort();
  const r = await run;
  await assertHaltedAfterFirstChapter(r, o, 2, client);
  assert.equal(r.ledger!.unknownUsage, 2);
  assert.match(r.reason!, /취소/);
  // 장부는 닫혔고 잠금이 남지 않았다
  assert.equal(existsSync(join(tmp, 'ledger', 'ledger.lock')), false);
});

test('취소: 연결 전에 이미 취소됐으면 연결하지 않는다', async () => {
  const cancel = new AbortController();
  cancel.abort();
  const { o, connected } = runOpts({ signal: cancel.signal });
  const r = await runPredicate(o);
  assert.equal(r.stage, 'stopped');
  assert.equal(connected.length, 0);
});
