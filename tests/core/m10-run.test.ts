// M10 같은 입력 반복 검사 runner (scripts/lib/m10-run.ts). 가짜 AI 클라이언트로 네트워크 없이 확인한다.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { DETECT_PROMPT_VERSION, DETECT_SCHEMA, DETECT_SYSTEM } from '../../src/core/ai/detection.ts';
import type { Extraction } from '../../src/core/ai/extraction.ts';
import { AiError, type AiClient, type JsonCall } from '../../src/main/ai-client.ts';
import { AiStore } from '../../src/main/ai-db.ts';
import { prepareCheck } from '../../src/main/checker.ts';
import { filesFingerprint } from '../../scripts/lib/m9-preflight.ts';
import { budgetPlan, crossRunReason, M10_PROMPT, M10_STAGE, requestBounds, runM10 } from '../../scripts/lib/m10-run.ts';
import { PREDICATE_STAGE } from '../../scripts/lib/predicate-run.ts';
import { M9_STAGE, StageLedger } from '../../scripts/lib/stage-ledger.ts';
import { extractionOf, fakeClient, makeBaseline, MANY, REPO, tamper, TARGETS, usage } from './fixtures/m9-fixture.ts';

let tmp: string;
let m4: string;
let real: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'loreweave-m10-'));
  m4 = join(tmp, 'm4base');
  real = join(tmp, 'realbase');
  await makeBaseline(m4);
  await makeBaseline(real);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const APPROVAL = 'm10-repeat-test-0001';
type Over = Partial<Parameters<typeof runM10>[0]> & { client?: AiClient; pairPass?: (label: string) => boolean };
function options(over: Over = {}) {
  const connected: number[] = [];
  const client = (over.client ?? fakeClient()) as ReturnType<typeof fakeClient>;
  const pass = over.pairPass ?? (() => true);
  const o: Parameters<typeof runM10>[0] = {
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
    recordM4: (label) => ({ run: label, recordOnly: true }),
    scoreReal: (label, p) => ({ run: label, chapters: p.chapters.length, findings: p.chapters.reduce((n, c) => n + c.findings.length, 0) }),
    ...over,
  };
  return { o, connected, client };
}
const runOpts = (over: Over = {}) => options({ run: true, approval: APPROVAL, ledgerDir: join(tmp, 'ledger'), ...over });
const sources = () => filesFingerprint([join(m4, '.loreweave', 'ai.db'), join(real, '.loreweave', 'ai.db'), join(real, 'chapters', '003.md'), join(real, 'review', 'eval', 'predictions.json')]);
const LABELS = ['m4-1', 'm4-2', 'm4-3', 'm4-4', 'real-1', 'real-2'];

// ---- 대조와 상한 (기본 경로)

test('기본(대조만): 여섯 회차를 대조하고 회차 사이 요청이 같으며, 연결·키·호출·장부가 없다. 공개 집계에 fingerprint가 없다', async () => {
  const before = sources();
  const { o, connected, client } = options();
  const r = await runM10(o);
  assert.equal(r.stage, 'preflight-ok', r.reason ?? '');
  assert.equal(connected.length + client.calls.length, 0);
  assert.equal(existsSync(join(tmp, 'ledger')), false);
  assert.deepEqual(r.preflight.map((p) => p.label), LABELS);
  assert.deepEqual(r.crossRun, { m4: null, real: null });
  for (const p of r.preflight) {
    assert.equal(p.base.ok, true);
    assert.deepEqual(p.base.skipped, p.label.startsWith('m4') ? ['order'] : []);
    assert.deepEqual(p.plan, { chapters: 2, passed: 2, facts: MANY * 2, batches: 4 });
  }
  const pub = JSON.stringify({ preflight: r.preflight, budget: r.budget, crossRun: r.crossRun });
  assert.ok(!/[0-9a-f]{64}/.test(pub));
  assert.match(readFileSync(join(o.work, 'preflight-m4-1.json'), 'utf8'), /fingerprint/);
  assert.equal(sources(), before);
});

test('상한: 보낼 요청마다 callCostBound를 더한 정확한 합이고, 재시도 1이면 두 배이며, 단계 상한과 따로 적는다', async () => {
  const { o } = options();
  const r = await runM10(o);
  const b = r.budget!;
  assert.deepEqual(b.calls, { m4: 4 * 4, real: 2 * 4, total: 24 });
  assert.equal(b.maxAttempts, 48);
  assert.equal(b.maxOutputTokens, 16_000);
  // 같은 요청을 직접 만들어 더한 값과 같다
  const store = AiStore.open(join(o.work, 'm4', 'run-1'));
  let perRun = 0;
  let maxCall = 0;
  try {
    for (const file of TARGETS) {
      const p = await prepareCheck(file, { root: join(o.work, 'm4', 'run-1'), store });
      assert.ok(typeof p !== 'string');
      const bounds = requestBounds(p);
      perRun += bounds.reduce((n, x) => n + x, 0);
      maxCall = Math.max(maxCall, ...bounds);
    }
  } finally {
    store.close();
  }
  assert.ok(Math.abs(b.perRunBoundUsd['m4-1']! - perRun) < 1e-12);
  assert.ok(Math.abs(b.completionBoundUsd.retries0 - 6 * perRun) < 1e-9);
  assert.ok(Math.abs(b.completionBoundUsd.retries1 - 2 * b.completionBoundUsd.retries0) < 1e-12);
  assert.ok(Math.abs(b.maxInFlightUsd - 2 * maxCall) < 1e-12);
  assert.equal(b.stageLimitUsd, M10_STAGE.limitUsd);
  assert.equal(b.completionGuaranteed, b.completionBoundUsd.retries1 <= 1.2);
  // 한도를 넘는 계획이면 완주를 보장하지 않는다고 적는다
  const plans = [{ label: 'm4-1', dataset: 'm4' as const, plans: [{ file: 'x', ok: true, reason: null, facts: 1, batches: 1, fingerprint: 'f', boundUsd: 2, maxCallBoundUsd: 2 }] }];
  assert.equal(budgetPlan(plans, 1.2).completionGuaranteed, false);
});

test('회차 사이 동일성: 요청이나 화 순서가 다른 회차가 있으면 이유를 돌려준다 (그때 기록과의 대조와 별개)', () => {
  const plan = (file: string, fp: string | null) => ({ file, fingerprint: fp });
  const a = { label: 'm4-1', plans: [plan('002.md', 'x'), plan('003.md', 'y')] };
  assert.equal(crossRunReason([a, { label: 'm4-2', plans: [plan('002.md', 'x'), plan('003.md', 'y')] }]), null);
  assert.match(crossRunReason([a, { label: 'm4-2', plans: [plan('002.md', 'x'), plan('003.md', 'z')] }])!, /m4-2 003\.md: 요청/);
  assert.match(crossRunReason([a, { label: 'm4-3', plans: [plan('003.md', 'y'), plan('002.md', 'x')] }])!, /화 순서/);
  assert.match(crossRunReason([a, { label: 'm4-4', plans: [plan('002.md', null), plan('003.md', 'y')] }])!, /요청/);
});

test('실행 조건: 승인 ID나 장부 폴더가 없거나 잘못되면 아무것도 만들지 않고 연결하지 않는다', async () => {
  for (const over of [{ approval: undefined }, { approval: 'X' }, { ledgerDir: undefined }, { ledgerDir: join(m4, 'ledger') }, { ledgerDir: join(REPO, 'm10-ledger-should-not-exist') }] as Over[]) {
    const { o, connected } = runOpts(over);
    const r = await runM10(o);
    assert.equal(r.stage, 'refused', JSON.stringify(over));
    assert.equal(connected.length, 0);
    assert.equal(existsSync(o.work), false);
  }
});

test('대조: 기준 사실이 바뀌면 실패하고, 실행이어도 연결·호출·장부 0', async () => {
  tamper(real, "UPDATE facts SET quote = '김민수는 웃었다.' WHERE ord = 0 AND analysis_id = (SELECT id FROM analyses WHERE file = '001.md')");
  const { o, connected, client } = runOpts();
  const r = await runM10(o);
  assert.equal(r.stage, 'preflight-failed');
  assert.equal(connected.length + client.calls.length, 0);
  assert.equal(existsSync(join(tmp, 'ledger')), false);
});

// ---- 실행

test('실행: M4 4회 → 두 쌍 관문 → 실제 원고 2회, 제품 detect-1 요청만 보내고 회차마다 따로 저장하며 두 회를 합친다', async () => {
  const before = sources();
  const { o, client } = runOpts();
  const r = await runM10(o);
  assert.equal(r.stage, 'done', r.reason ?? '');
  assert.equal(client.calls.length, 6 * 4);
  assert.ok(client.calls.every((c) => c.system === DETECT_SYSTEM && c.schema === DETECT_SCHEMA && c.maxOutputTokens === 16_000 && c.model === 'gpt-6-luna'));
  // 같은 데이터셋의 회차는 같은 입력을 보냈다
  const users = (label: number) => client.calls.slice(label * 4, label * 4 + 4).map((c) => c.user).sort();
  for (const i of [1, 2, 3]) assert.deepEqual(users(i), users(0));
  assert.deepEqual(users(5), users(4));
  assert.equal(r.m4Runs.length, 4);
  assert.deepEqual(r.m4Pairs.map((p) => (p as { run: string }).run), ['m4-1+m4-2', 'm4-3+m4-4']);
  assert.equal(r.realRuns.length, 2);
  assert.ok(r.realMerged);
  assert.deepEqual(Object.entries(r.stageSummary!.runs).map(([k, v]) => [k, v.state]), LABELS.map((l) => [l, 'done']));
  const s = AiStore.open(join(o.work, 'real', 'run-2'));
  try {
    assert.equal(s.check('003.md')!.promptVersion, M10_PROMPT.version);
  } finally {
    s.close();
  }
  assert.equal(M10_PROMPT.system, DETECT_SYSTEM);
  assert.equal(DETECT_PROMPT_VERSION, 'detect-1');
  for (const f of ['merged-m4-1+m4-2.json', 'merged-m4-3+m4-4.json', 'merged-real-1+real-2.json']) assert.equal(existsSync(join(o.work, f)), true, f);
  const p = JSON.parse(readFileSync(join(o.work, 'real', 'run-1', 'eval', 'predictions.json'), 'utf8'));
  assert.equal(p.context_source, 'runner-sent');
  assert.equal(sources(), before);
});

test('실행: 첫 호출 전에 예약이 장부 파일에 남는다', async () => {
  const base = fakeClient();
  const seen: string[] = [];
  const client = {
    calls: base.calls,
    check: async () => {},
    json: async (call: JsonCall) => {
      const ledger = JSON.parse(readFileSync(join(tmp, 'ledger', 'ledger.json'), 'utf8'));
      seen.push(ledger.entries.at(-1)?.state);
      assert.equal(ledger.approval, APPROVAL);
      assert.equal(ledger.stageId, M10_STAGE.id);
      return base.json(call);
    },
  };
  const r = await runM10(runOpts({ client }).o);
  assert.equal(r.stage, 'done', r.reason ?? '');
  assert.equal(seen.length, 24);
  assert.ok(seen.every((x) => x === 'reserved'));
});

test('M4 관문: 합친 두 쌍 중 하나라도 미달이면 실제 원고 회차를 시작하지 않는다 (호출 M4 4회분)', async () => {
  const { o, client } = runOpts({ pairPass: (label) => label !== 'm4-3+m4-4' });
  const r = await runM10(o);
  assert.equal(r.stage, 'm4-failed');
  assert.equal(client.calls.length, 4 * 4);
  assert.deepEqual(Object.keys(r.stageSummary!.runs), ['m4-1', 'm4-2', 'm4-3', 'm4-4']);
  assert.equal(r.realRuns.length, 0);
});

test('재시작·장부: 시작한 회차가 있으면 다시 하지 않고, 다른 승인 ID나 끝난 M9 장부로는 열지 않는다', async () => {
  const first = await runM10(runOpts({ pairPass: () => false }).o);
  assert.equal(first.stage, 'm4-failed');
  const again = runOpts();
  const r = await runM10(again.o);
  assert.equal(r.stage, 'refused');
  assert.match(r.reason!, /m4-1\(done\)/);
  assert.equal(again.connected.length, 0);

  const other = runOpts({ approval: 'm10-repeat-test-0002' });
  assert.match((await runM10(other.o)).reason!, /승인 ID/);
  assert.equal(other.connected.length, 0);

  for (const stage of [M9_STAGE, PREDICATE_STAGE]) {
    const dir = join(tmp, `old-${stage.id}`);
    StageLedger.open(dir, stage).close();
    const reuse = runOpts({ ledgerDir: dir });
    assert.match((await runM10(reuse.o)).reason!, /단계/);
    assert.equal(reuse.connected.length, 0);
  }
});

test('실행: 연결하는 동안 복사본 본문이 바뀌면 첫 호출 전에 멈춘다 (호출 0)', async () => {
  const client = fakeClient();
  const work = join(tmp, 'work-x');
  const r = await runM10(
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

test('예산 거절: 상한 비용 한 번분도 안 되면 첫 호출 전에 멈추고 새 회차를 시작하지 않는다', async () => {
  const { o, client } = runOpts({ stage: { id: 'm10-small', limitUsd: 0.001 } });
  const r = await runM10(o);
  assert.equal(r.stage, 'stopped');
  assert.match(r.reason!, /한도/);
  assert.equal(client.calls.length, 0);
  assert.deepEqual(Object.keys(r.stageSummary!.runs), ['m4-1']);
});

test('중간 실패: m4-3에서 재시도까지 실패하면 그 회차를 멈추고, 끝난 m4-1·m4-2 결과는 남으며, 예약액을 지출로 남기고 관문·실제 원고로 가지 않는다', async () => {
  const seen = new Map<string, number>();
  const base = fakeClient();
  const client = {
    calls: base.calls,
    check: async () => {},
    json: async (call: JsonCall) => {
      const k = (seen.get(call.user) ?? 0) + 1;
      seen.set(call.user, k);
      // 2화 첫 묶음: m4-1·m4-2에서는 성공, m4-3에서 처음(3번째)과 재시도(4번째)는 연결 오류
      if (call.user.includes('<chapter n="2">') && call.user.includes('| 값 0 |') && (k === 3 || k === 4)) throw new AiError('연결 끊김', 'network');
      return base.json(call);
    },
  };
  const { o } = runOpts({ client });
  const r = await runM10(o);
  assert.equal(r.stage, 'stopped');
  assert.equal(r.stageSummary!.runs['m4-3']!.state, 'stopped');
  assert.equal(r.stageSummary!.runs['m4-3']!.unknown, 2);
  assert.equal(r.stageSummary!.runs['m4-4'], undefined);
  assert.equal(r.m4Pairs.length, 0);
  assert.equal(r.ledger!.inFlight, 0);
  for (const n of [1, 2]) assert.equal(existsSync(join(o.work, 'm4', `run-${n}`, 'eval', 'predictions.json')), true);
  assert.equal(existsSync(join(o.work, 'm4', 'run-3', 'eval', 'predictions.json')), false);
});

// ---- 공유 중단과 취소 (묶음 4개)

const big = (n: number): Extraction => {
  const e = extractionOf(n);
  return n === 1 ? { ...e, facts: Array.from({ length: 1250 }, (_, i) => ({ ...e.facts[i % MANY]!, value: `값 ${i}` })) } : e;
};
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
async function failFirst(fail: (p: ReturnType<typeof gatedClient>['pending'][number]) => void, expectedSends: number) {
  await bigBaselines();
  const { client, pending } = gatedClient();
  const { o } = runOpts({ client });
  const run = runM10(o);
  await until(() => pending.length === 2);
  fail(pending[0]!);
  for (let i = 2; i < expectedSends; i++) {
    await until(() => pending.length === i + 1);
    pending[i]!.reject(new AiError('연결 끊김', 'network'));
  }
  await new Promise((r) => setTimeout(r, 20));
  pending[1]!.resolve();
  return { r: await run, client, o };
}
function assertHalted(r: Awaited<ReturnType<typeof runM10>>, o: Parameters<typeof runM10>[0], sends: number, client: { calls: JsonCall[] }) {
  assert.equal(r.stage, 'stopped', r.reason ?? '');
  assert.equal(client.calls.length, sends, `보낸 요청 ${client.calls.length}`);
  assert.ok(client.calls.every((c) => c.user.includes('<chapter n="2">')));
  assert.equal(r.ledger!.inFlight, 0);
  assert.equal(r.ledger!.attempts, sends);
  assert.deepEqual(Object.keys(r.stageSummary!.runs), ['m4-1']);
  assert.equal(r.stageSummary!.runs['m4-1']!.state, 'stopped');
  const s = AiStore.open(join(o.work, 'm4', 'run-1'));
  try {
    assert.equal(s.check('002.md')!.promptVersion, 'detect-1');
  } finally {
    s.close();
  }
}

for (const [name, kind] of [['인증', 'auth'], ['모델', 'model'], ['기타 OpenAI', 'other']] as const) {
  test(`공유 중단: 첫 묶음이 ${name} 오류면 재시도 없이, 이미 보낸 둘째만 정산하고 새 묶음·다음 화·회차를 보내지 않는다`, { timeout: 60_000 }, async () => {
    const { r, client, o } = await failFirst((p) => p.reject(new AiError('합성 오류', kind)), 2);
    assertHalted(r, o, 2, client);
    assert.equal(r.ledger!.unknownUsage, 1);
  });
}

// 요청 한도·잔액(429)은 rate-limit으로 분류되어 연결 오류처럼 한 번 다시 보낸다
for (const [name, kind] of [['연결', 'network'], ['요청 한도·잔액(429)', 'rate-limit']] as const) {
  test(`공유 중단: ${name} 오류가 재시도까지 소진되면 새 묶음을 보내지 않는다 (첫 묶음, 재시도, 둘째 묶음)`, { timeout: 60_000 }, async () => {
    await bigBaselines();
    const { client, pending } = gatedClient();
    const { o } = runOpts({ client });
    const run = runM10(o);
    await until(() => pending.length === 2);
    pending[0]!.reject(new AiError('합성 오류', kind));
    await until(() => pending.length === 3);
    pending[2]!.reject(new AiError('합성 오류', kind));
    await new Promise((r) => setTimeout(r, 20));
    pending[1]!.resolve();
    const r = await run;
    assertHalted(r, o, 3, client);
    assert.equal(r.ledger!.unknownUsage, 2);
  });
}

test('공유 중단: 응답 형식이 틀리면 새 묶음을 보내지 않고 그 화를 저장하지 않는다', { timeout: 60_000 }, async () => {
  const { r, client, o } = await failFirst((p) => p.resolve({ findings: 'bad' }), 2);
  assertHalted(r, o, 2, client);
  assert.equal(r.ledger!.unknownUsage, 0);
});

test('취소: 두 묶음이 나간 사이 취소하면 진행 중 요청을 끊고, 예약액을 지출로 남기고, 새 요청·다음 회차를 보내지 않으며 잠금을 남기지 않는다', { timeout: 60_000 }, async () => {
  await bigBaselines();
  const { client, pending } = gatedClient();
  const cancel = new AbortController();
  const { o } = runOpts({ client, signal: cancel.signal });
  const run = runM10(o);
  await until(() => pending.length === 2);
  cancel.abort();
  const r = await run;
  assertHalted(r, o, 2, client);
  assert.equal(r.ledger!.unknownUsage, 2);
  assert.match(r.reason!, /취소/);
  assert.equal(existsSync(join(tmp, 'ledger', 'ledger.lock')), false);
});

test('취소: 연결 전에 이미 취소됐으면 연결하지 않는다', async () => {
  const cancel = new AbortController();
  cancel.abort();
  const { o, connected } = runOpts({ signal: cancel.signal });
  const r = await runM10(o);
  assert.equal(r.stage, 'stopped');
  assert.equal(connected.length, 0);
});
