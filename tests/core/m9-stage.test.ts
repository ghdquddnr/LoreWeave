// M9 단계 장부와 M4 회귀 경로 (M9-PLAN 4·5절). 가짜 AI 클라이언트로 네트워크 없이 확인한다.
//   - 실제 원고(real)와 합성 원고(m4)가 저장소 밖 장부 하나의 한도를 함께 쓴다 (둘째 실행, 재시작, 동시 실행, 비정상 종료, 재시도)
//   - M4 3회는 회마다 따로 저장·채점하고, 분모(정답 20개, 검사한 화)와 확신도 필터 전후 집계가 맞는다

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { costUsd, type Usage } from '../../src/core/ai/cost.ts';
import { DETECT_SCHEMA } from '../../src/core/ai/detection.ts';
import { AiError, MAX_OUTPUT_TOKENS, type AiClient, type JsonCall, type JsonResult } from '../../src/main/ai-client.ts';
import { AiStore } from '../../src/main/ai-db.ts';
import { prepareCheck } from '../../src/main/checker.ts';
import { loadChapters, loadGroundTruth } from '../../spikes/m0a-ai-feasibility/src/benchmark.ts';
import { evaluate } from '../../spikes/m0a-ai-feasibility/src/evaluate.ts';
import type { Predictions } from '../../spikes/m0a-ai-feasibility/src/schema.ts';
import { DETECT2_SYSTEM } from '../../scripts/lib/detect2.ts';
import { differsFromBenchmark, judgeM4, m4Passed, M4_CRITERIA, M0A_BENCHMARK, scoreM4 } from '../../scripts/lib/m4-score.ts';
import { runM9 } from '../../scripts/lib/m9-run.ts';
import { BudgetRefused, callCostBound, withReservation } from '../../scripts/lib/reserve.ts';
import { M9_STAGE, StageLedger, StageLedgerError } from '../../scripts/lib/stage-ledger.ts';
import { fakeClient, M0A, makeBaseline, MODEL, REPO, TARGETS } from './fixtures/m9-fixture.ts';

let tmp: string;
let baseline: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'loreweave-m9s-'));
  baseline = join(tmp, 'm8');
  await makeBaseline(baseline);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const ledgerDir = () => join(tmp, 'ledger');
const run = (over: Partial<Parameters<typeof runM9>[0]> & { client?: AiClient } = {}) => {
  const connected: number[] = [];
  const client = over.client ?? fakeClient();
  return {
    connected,
    options: {
      label: 'real',
      baseline,
      work: join(tmp, `work-${Math.random().toString(36).slice(2)}`),
      predictions: join(baseline, 'review', 'eval', 'predictions.json'),
      targets: TARGETS,
      runs: 2,
      ledgerDir: ledgerDir(),
      run: true,
      connect: () => {
        connected.push(1);
        return client;
      },
      repoRoot: REPO,
      ...over,
    } as Parameters<typeof runM9>[0],
  };
};

/** 기준의 검사 요청 하나의 비용 상한 (모든 묶음이 같은 크기라 하나로 충분하다) */
async function boundPerCall(): Promise<number> {
  const store = AiStore.open(baseline);
  try {
    const p = await prepareCheck('003.md', { root: baseline, store });
    assert.ok(typeof p !== 'string');
    return Math.max(...p.users.map((user) => callCostBound(MODEL, { system: DETECT2_SYSTEM, user, schema: DETECT_SCHEMA }, MAX_OUTPUT_TOKENS)));
  } finally {
    store.close();
  }
}

// ---- 단계 장부 자체

test('장부: 단계 ID·한도를 고정하고, 다른 단계·큰 한도로는 열지 않는다', () => {
  assert.deepEqual(M9_STAGE, { id: 'm9-detect2', limitUsd: 1.2 });
  assert.throws(() => StageLedger.open(ledgerDir(), { id: 'm9-detect2', limitUsd: 1.21 }), StageLedgerError);
  assert.throws(() => StageLedger.open(ledgerDir(), { id: 'm9-detect2', limitUsd: Number.NaN }), StageLedgerError);
  const l = StageLedger.open(ledgerDir());
  l.close();
  // 같은 폴더를 다른 한도로 다시 열 수 없다 (한도를 늘리거나 잔액을 새로 시작하지 못한다)
  assert.throws(() => StageLedger.open(ledgerDir(), { id: 'm9-detect2', limitUsd: 1.0 }), /다릅니다/);
  assert.throws(() => StageLedger.open(ledgerDir(), { id: 'other', limitUsd: 1.2 }), /다릅니다/);
  assert.equal(existsSync(join(ledgerDir(), 'ledger.lock')), false);
});

test('장부: 열려 있는 동안 다른 실행은 열 수 없고(잠금), 닫으면 지출이 그대로 남은 채 다시 열린다', () => {
  const a = StageLedger.open(ledgerDir());
  assert.throws(() => StageLedger.open(ledgerDir()), /잠겨/);
  a.startRun('real-1');
  const r = a.reserve(0.1);
  a.settle(r, 0.03);
  a.finishRun('real-1', 'done');
  a.close();
  const b = StageLedger.open(ledgerDir());
  try {
    assert.ok(Math.abs(b.committed() - 0.03) < 1e-12);
    assert.match(b.cannotStart(['real-1', 'real-2'])!, /real-1\(done\)/);
    assert.throws(() => b.startRun('real-1'), /다시 하지 않습니다/);
  } finally {
    b.close();
  }
});

test('장부: 비정상 종료로 정산하지 못한 예약은 다시 열 때 예약액 전부를 지출로 남기고, 그 회차는 다시 하지 않는다', () => {
  const a = StageLedger.open(ledgerDir());
  a.startRun('real-1');
  a.reserve(0.25);
  // 비정상 종료: 정산도 close도 하지 못했다. 파일만 남는다 (잠금 파일은 사람이 프로세스가 없음을 확인하고 지운다)
  const crashed = join(tmp, 'crashed');
  mkdirSync(crashed);
  copyFileSync(join(ledgerDir(), 'ledger.json'), join(crashed, 'ledger.json'));
  const b = StageLedger.open(crashed);
  try {
    assert.ok(Math.abs(b.committed() - 0.25) < 1e-12);
    const s = b.summary();
    assert.equal(s.runs['real-1']!.state, 'interrupted');
    assert.equal(s.runs['real-1']!.unknown, 1);
    assert.equal(b.snapshot().unknownUsage, 1);
    assert.match(b.cannotStart(['real-1'])!, /interrupted/);
  } finally {
    b.close();
  }
  // 잠금이 남아 있는 원래 폴더는 열리지 않는다
  assert.throws(() => StageLedger.open(ledgerDir()), /잠겨/);
});

test('장부: 회차 없이 예약할 수 없고, 정산하지 않은 예약이 있으면 회차를 끝낼 수 없다', () => {
  const l = StageLedger.open(ledgerDir(), { id: 't', limitUsd: 1 });
  try {
    assert.throws(() => l.reserve(0.1), /회차/);
    l.startRun('m4-1');
    const r = l.reserve(0.1);
    assert.throws(() => l.finishRun('m4-1', 'done'), /정산하지 않은/);
    l.settle(r, null);
    assert.throws(() => l.settle(r, 0), /이미 정산/);
    l.finishRun('m4-1', 'done');
    assert.ok(Math.abs(l.committed() - 0.1) < 1e-12);
  } finally {
    l.close();
  }
});

/** 응답을 직접 풀어 주는 가짜 클라이언트 */
function gated() {
  const pending: { resolve(u: Usage): void; reject(e: unknown): void }[] = [];
  const client: AiClient = {
    async check() {},
    json: () =>
      new Promise<JsonResult>((resolve, reject) => {
        pending.push({ resolve: (u) => resolve({ data: {}, usage: u, modelVersion: 'm', latencyMs: 1 }), reject });
      }),
  };
  return { client, pending };
}
const call = (signal?: AbortSignal): JsonCall => ({ model: MODEL, system: DETECT2_SYSTEM, user: '본문', schema: DETECT_SCHEMA, signal });
const u: Usage = { inputTokens: 2000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 300 };

test('장부: 재시도·취소·usage 불명은 장부 한 곳에서만 세고, 다시 열어도 그대로다 (withReservation과 중복 계산 없음)', async () => {
  const bound = callCostBound(MODEL, call(), MAX_OUTPUT_TOKENS);
  const l = StageLedger.open(ledgerDir());
  l.startRun('real-1');
  const { client, pending } = gated();
  const ai = withReservation(client, { model: MODEL, budget: l, retries: 1 });
  const p = ai.json(call());
  pending[0]!.reject(new AiError('연결 끊김', 'network'));
  await new Promise((r) => setImmediate(r));
  pending[1]!.resolve(u);
  await p;
  const controller = new AbortController();
  const q = ai.json(call(controller.signal));
  controller.abort();
  pending[2]!.reject(new AiError('취소', 'network'));
  await assert.rejects(q);
  assert.equal(pending.length, 3);
  const expected = bound + costUsd(MODEL, u) + bound;
  assert.ok(Math.abs(l.committed() - expected) < 1e-12);
  assert.deepEqual({ attempts: ai.ledger().attempts, unknown: ai.ledger().unknownUsage, inFlight: ai.ledger().inFlight }, { attempts: 3, unknown: 2, inFlight: 0 });
  l.finishRun('real-1', 'done');
  l.close();
  const again = StageLedger.open(ledgerDir());
  try {
    assert.ok(Math.abs(again.committed() - expected) < 1e-12);
  } finally {
    again.close();
  }
});

test('장부: 진행 중 예약까지 합쳐 한도를 넘는 동시 호출은 보내지 않는다', async () => {
  const bound = callCostBound(MODEL, call(), MAX_OUTPUT_TOKENS);
  const l = StageLedger.open(ledgerDir(), { id: 't', limitUsd: bound * 1.5 });
  l.startRun('real-1');
  const { client, pending } = gated();
  const ai = withReservation(client, { model: MODEL, budget: l });
  const first = ai.json(call());
  await assert.rejects(ai.json(call()), BudgetRefused);
  assert.equal(pending.length, 1);
  pending[0]!.resolve(u);
  await first;
  await assert.rejects(ai.json(call()), BudgetRefused);
  assert.equal(pending.length, 1);
  l.finishRun('real-1', 'done');
  l.close();
});

// ---- 두 데이터셋이 장부를 함께 쓴다

test('공유: real 2회 뒤 m4가 같은 장부의 남은 금액만 쓰고, 넘으면 첫 호출 전에 멈춘다', async () => {
  const B = await boundPerCall();
  // 한 호출이 상한의 절반보다 비싸게 정산되게 해서, real 전체(8호출)는 통과하고 m4 첫 호출은 남은 금액을 넘게 한다
  const heavy: Usage = { inputTokens: Math.ceil(((B * 0.75) / 0.1) * 1e6), cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const c = costUsd(MODEL, heavy);
  assert.ok(2 * c > B);
  // real: 화마다 2묶음 동시. 마지막 묶음 쌍을 예약할 때 최대 6c + 2B. m4 첫 예약은 8c + B
  const limit = (6 * c + 2 * B + (8 * c + B)) / 2;
  const stage = { id: 'test-shared', limitUsd: limit };
  const realClient = fakeClient(undefined, heavy);
  const real = await runM9(run({ client: realClient, stage }).options);
  assert.equal(real.stage, 'done', real.reason ?? '');
  assert.equal(realClient.calls.length, 8);
  assert.ok(Math.abs(real.stageSummary!.committedUsd - 8 * c) < 1e-9);

  const m4Client = fakeClient(undefined, heavy);
  const m4 = run({ client: m4Client, stage, label: 'm4', runs: 3, predictions: null });
  const r = await runM9(m4.options);
  assert.equal(r.stage, 'stopped');
  assert.match(r.reason!, /한도/);
  assert.equal(m4Client.calls.length, 0);
  assert.equal(r.stageSummary!.runs['m4-1']!.state, 'stopped');
  assert.equal(r.stageSummary!.runs['m4-1']!.attempts, 0);
  assert.ok(r.stageSummary!.committedUsd <= limit);

  // 따로 실행해 장부를 새로 시작하는 길은 없다: 같은 장부 폴더는 지출이 남아 있고, 다른 한도로는 열리지 않는다
  const retry = run({ client: fakeClient(undefined, heavy), stage, label: 'm4', runs: 3, predictions: null });
  const again = await runM9(retry.options);
  assert.equal(again.stage, 'refused');
  assert.match(again.reason!, /m4-1\(stopped\)/);
  assert.equal(retry.connected.length, 0);
});

test('공유: 이미 시작한 회차는 재시작해도 다시 보내지 않고, 장부가 잠겨 있으면 연결하지 않는다', async () => {
  const first = await runM9(run().options);
  assert.equal(first.stage, 'done');
  const restart = run();
  const r = await runM9(restart.options);
  assert.equal(r.stage, 'refused');
  assert.match(r.reason!, /real-1\(done\).*real-2\(done\)/);
  assert.equal(restart.connected.length, 0);

  const holder = StageLedger.open(ledgerDir());
  try {
    const concurrent = run({ label: 'm4', runs: 3, predictions: null });
    const c = await runM9(concurrent.options);
    assert.equal(c.stage, 'refused');
    assert.match(c.reason!, /잠겨/);
    assert.equal(concurrent.connected.length, 0);
  } finally {
    holder.close();
  }
});

test('공유: 지난 실행이 비정상 종료해 남긴 미정산 예약도 잔액에서 빠진다', async () => {
  const B = await boundPerCall();
  const stage = { id: 'test-crash', limitUsd: B * 3 };
  const a = StageLedger.open(ledgerDir(), stage);
  a.startRun('real-1');
  a.reserve(B * 2.5);
  // 비정상 종료 흉내: 파일만 남기고 잠금은 사람이 지웠다
  const json = readFileSync(join(ledgerDir(), 'ledger.json'), 'utf8');
  a.close();
  writeFileSync(join(ledgerDir(), 'ledger.json'), json);
  const m4Client = fakeClient();
  const r = await runM9(run({ client: m4Client, stage, label: 'm4', runs: 3, predictions: null }).options);
  // 남은 0.5B로는 한 호출도 예약할 수 없다
  assert.equal(r.stage, 'stopped');
  assert.equal(m4Client.calls.length, 0);
  assert.equal(r.stageSummary!.runs['real-1']!.state, 'interrupted');
  assert.ok(Math.abs(r.stageSummary!.committedUsd - B * 2.5) < 1e-12);
});

test('장부 폴더가 저장소·기준·작업 폴더와 겹치면 아무것도 만들지 않고 거절한다', async () => {
  for (const dir of [join(baseline, 'ledger'), join(REPO, 'm9-ledger-should-not-exist')]) {
    const x = run({ ledgerDir: dir });
    const r = await runM9(x.options);
    assert.equal(r.stage, 'refused');
    assert.match(r.reason!, /장부 폴더/);
    assert.equal(existsSync(dir), false);
    assert.equal(existsSync(x.options.work), false);
    assert.equal(x.connected.length, 0);
  }
  const w = join(tmp, 'work-x');
  const inWork = run({ work: w, ledgerDir: join(w, 'ledger') });
  assert.equal((await runM9(inWork.options)).stage, 'refused');
  assert.equal(existsSync(w), false);
  // 대조만 할 때는 장부가 필요 없고 만들지도 않는다
  const dry = await runM9(run({ run: false, ledgerDir: undefined }).options);
  assert.equal(dry.stage, 'preflight-ok');
  assert.equal(existsSync(ledgerDir()), false);
  const noLedger = await runM9(run({ ledgerDir: undefined }).options);
  assert.equal(noLedger.stage, 'refused');
});

// ---- M4 회귀 경로

test('M4 경로: 3회가 회마다 따로 저장·채점되고, 평가기 출력이 없는 기준은 순서 대조를 건너뛰었다고 남긴다', async () => {
  const client = fakeClient();
  const scored: string[] = [];
  const x = run({
    client,
    label: 'm4',
    runs: 3,
    predictions: null,
    afterRun: (label, p) => {
      scored.push(label);
      return { label, chapters: p.chapters.length };
    },
  });
  const r = await runM9(x.options);
  assert.equal(r.stage, 'done', r.reason ?? '');
  assert.deepEqual(scored, ['m4-1', 'm4-2', 'm4-3']);
  assert.equal(r.scores.length, 3);
  assert.equal(client.calls.length, 3 * 4);
  for (const p of r.preflight) assert.deepEqual(p.skipped, ['order']);
  for (const n of [1, 2, 3]) {
    const p = JSON.parse(readFileSync(join(x.options.work, `run-${n}`, 'eval', 'predictions.json'), 'utf8')) as Predictions;
    assert.equal(p.run_id, `m9-detect2-m4-${n}`);
    const s = AiStore.open(join(x.options.work, `run-${n}`));
    try {
      assert.equal(s.check('003.md')!.promptVersion, 'detect-2-candidate');
    } finally {
      s.close();
    }
  }
  assert.deepEqual(Object.keys(r.stageSummary!.runs).sort(), ['m4-1', 'm4-2', 'm4-3']);
});

/** 정답표의 test 오류로 만든 합성 예측. tpConf로 정답 결과의 확신도를, fp로 오탐 수를 정한다 */
function syntheticPredictions(run: string, tpConf: (i: number) => number, fp: number): Predictions {
  const gt = loadGroundTruth(M0A_BENCHMARK);
  const chapters = new Map<number, Predictions['chapters'][number]>();
  for (let n = 2; n <= 15; n++) chapters.set(n, { target_chapter: n, context: [], findings: [] });
  gt.errors
    .filter((e) => e.split === 'test')
    .forEach((e, i) =>
      chapters.get(e.target.chapter)!.findings.push({ category: e.category, target_quote: e.target.quotes[0]!, claim: '합성', evidence: [], confidence: tpConf(i) }),
    );
  // 정답·함정이 없는 실제 문장 (제목 줄): unlabeled 오탐
  const titles = [...Array(15).keys()].map((k) => k + 1).filter((n) => n >= 2);
  for (let k = 0; k < fp; k++) {
    const n = titles[k % titles.length]!;
    const title = readFileSync(join(M0A, `ch${String(n).padStart(2, '0')}.md`), 'utf8').split('\n')[0]!.replace(/^#\s*/, '');
    chapters.get(n)!.findings.push({ category: 'number', target_quote: title, claim: '합성 오탐', evidence: [], confidence: 0.95 });
  }
  return { run_id: run, strategy: 'product-b', model: MODEL, chapters: [...chapters.values()] };
}

test('M4 채점: 분모는 test 정답 20개와 검사한 14화, 확신도 0.7 필터 전후를 따로 센다', () => {
  // 20개 중 3개는 확신도 0.6 (필터 전에는 찾고, 필터 뒤에는 숨음)
  const s = scoreM4('m4-1', syntheticPredictions('m4-1', (i) => (i < 3 ? 0.6 : 0.9), 0), 14);
  assert.equal(s.checkedChapters, 14);
  assert.deepEqual([s.before.tp, s.before.total, s.after.tp, s.after.total], [20, 20, 17, 20]);
  assert.equal(s.after.fp, 0);
  assert.equal(s.pass, true);
  const four = scoreM4('m4-2', syntheticPredictions('m4-2', (i) => (i < 4 ? 0.6 : 0.9), 0), 14);
  assert.equal(four.after.tp, 16);
  assert.equal(four.pass, false);
  assert.match(four.failures.join(), /Recall 16\/20/);
});

test('M4 채점: 화당 오탐 0.3과 Precision 85% 경계, 검사한 화 수가 다르면 실패', () => {
  // 오탐 4개 / 14화 = 0.286 (통과), 5개 = 0.357 (실패). Precision 20/24 = 83% (실패)
  const ok = scoreM4('a', syntheticPredictions('a', () => 0.9, 3), 14);
  assert.ok(ok.after.fp === 3 && ok.pass, ok.failures.join());
  const fp4 = scoreM4('b', syntheticPredictions('b', () => 0.9, 4), 14);
  assert.ok(Math.abs(fp4.after.fpPerChapter - 4 / 14) < 1e-12);
  assert.match(fp4.failures.join(), /Precision/);
  const fp5 = scoreM4('c', syntheticPredictions('c', () => 0.9, 5), 14);
  assert.match(fp5.failures.join(), /화당 오탐/);
  const wrongCount = scoreM4('d', syntheticPredictions('d', () => 0.9, 0), 15);
  assert.equal(wrongCount.pass, false);
  assert.equal(M4_CRITERIA.minTestTp, 17);
  // 결과가 없으면 Precision을 정할 수 없어 실패다
  const none = judgeM4('e', scoreM4Raw('e'), 14);
  assert.equal(none.pass, false);
});

/** 결과가 하나도 없는 회의 평가기 출력 */
function scoreM4Raw(run: string) {
  const p = syntheticPredictions(run, () => 0.9, 0);
  for (const c of p.chapters) c.findings = [];
  return evaluate(p, loadGroundTruth(M0A_BENCHMARK), loadChapters(M0A_BENCHMARK));
}

test('M4 판정: 세 회가 모두, 서로 다른 회로 통과해야 한다', () => {
  const pass = (run: string) => scoreM4(run, syntheticPredictions(run, () => 0.9, 0), 14);
  assert.equal(m4Passed([pass('m4-1'), pass('m4-2'), pass('m4-3')]), true);
  assert.equal(m4Passed([pass('m4-1'), pass('m4-2')]), false);
  assert.equal(m4Passed([pass('m4-1'), pass('m4-1'), pass('m4-2')]), false);
  const fail = scoreM4('m4-3', syntheticPredictions('m4-3', () => 0.5, 0), 14);
  assert.equal(m4Passed([pass('m4-1'), pass('m4-2'), fail]), false);
});

test('M4 원고 확인: 벤치마크와 바이트까지 같아야 정답표를 쓴다', () => {
  const project = join(tmp, 'm4');
  mkdirSync(join(project, 'chapters'), { recursive: true });
  for (let n = 1; n <= 15; n++) copyFileSync(join(M0A, `ch${String(n).padStart(2, '0')}.md`), join(project, 'chapters', `${String(n).padStart(3, '0')}.md`));
  assert.equal(differsFromBenchmark(project), null);
  writeFileSync(join(project, 'chapters', '009.md'), readFileSync(join(project, 'chapters', '009.md'), 'utf8') + '\n덧붙임\n');
  assert.match(differsFromBenchmark(project)!, /009\.md/);
});
