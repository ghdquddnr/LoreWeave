// 실험 runner의 원래 응답 기록(scripts/lib/raw-record.ts)과 오프라인 재생(raw-replay.ts). 가짜 AI 클라이언트로 네트워크 없이 확인한다.

import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { costUsd } from '../../src/core/ai/cost.ts';
import { AiError, type AiClient, type JsonCall } from '../../src/main/ai-client.ts';
import { AiStore } from '../../src/main/ai-db.ts';
import { toPredictions } from '../../scripts/export-predictions.ts';
import { runM10 } from '../../scripts/lib/m10-run.ts';
import { sha256 } from '../../scripts/lib/m9-preflight.ts';
import { ambiguousRequests, rawRecorder, RawRecordError } from '../../scripts/lib/raw-record.ts';
import { readRaw, replayRun, replaySummary } from '../../scripts/lib/raw-replay.ts';
import { fakeClient, makeBaseline, REPO, TARGETS, usage } from './fixtures/m9-fixture.ts';

let tmp: string;
let m4: string;
let real: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'loreweave-raw-'));
  m4 = join(tmp, 'm4base');
  real = join(tmp, 'realbase');
  await makeBaseline(m4);
  await makeBaseline(real);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const TARGET = '"스물두 살입니다."';
const EVIDENCE = { chapter: 1, quote: '둘 다 스무 살이었다.' };
const finding = (over: Record<string, unknown> = {}) => ({ category: 'age', target_quote: TARGET, claim: '나이 모순', evidence: [EVIDENCE], confidence: 0.9, ...over });
/** 3화 첫 묶음: 유효(0.6) + 이 화 문장 없음 + 근거 없음, 둘째 묶음: 같은 키 다른 설명(0.9). 2화는 결과 없음 */
const firstBatch = (call: JsonCall) => call.user.includes('| 값 0 |');
const detect = (call: JsonCall) =>
  !call.user.includes('<chapter n="3">')
    ? { findings: [] }
    : firstBatch(call)
      ? {
          findings: [
            finding({ claim: '첫 묶음 설명', confidence: 0.6 }),
            finding({ target_quote: '원고에 없는 문장이다.' }),
            finding({ evidence: [{ chapter: 1, quote: '1화에 없는 근거 문장이다.' }] }),
          ],
        }
      : { findings: [finding({ claim: '둘째 묶음 설명', confidence: 0.9 })] };

type Over = Partial<Parameters<typeof runM10>[0]>;
function options(client: AiClient, over: Over = {}) {
  const work = join(tmp, `work-${Math.random().toString(36).slice(2)}`);
  const o: Parameters<typeof runM10>[0] = {
    m4: { baseline: m4, predictions: null, targets: TARGETS },
    real: { baseline: real, predictions: join(real, 'review', 'eval', 'predictions.json'), targets: TARGETS },
    work,
    repoRoot: REPO,
    run: true,
    approval: 'raw-record-test-0001',
    ledgerDir: join(tmp, `ledger-${Math.random().toString(36).slice(2)}`),
    connect: () => client,
    scoreM4: (label) => ({ run: label, pass: true }),
    recordM4: (label) => ({ run: label }),
    scoreReal: (label) => ({ run: label }),
    ...over,
  };
  return o;
}
const LABELS = ['m4-1', 'm4-2', 'm4-3', 'm4-4', 'real-1', 'real-2'];
const runRoot = (o: Parameters<typeof runM10>[0], label: string) => {
  const [d, n] = label.split('-');
  return join(o.work, d!, `run-${n}`);
};
const findingsOf = (o: Parameters<typeof runM10>[0], label: string) =>
  JSON.stringify(toPredictions(join(runRoot(o, label), '.loreweave', 'ai.db'), 'x').predictions.chapters.map((c) => c.findings));

test('기록 켬: 시도마다 원래 응답을 남기고, 오프라인 재생(위치 검증 → 합치기)이 저장된 검사 결과와 같다. 버린 이유(이 화 문장 없음 / 근거 없음)를 구별한다', async () => {
  const o = options(fakeClient(detect), { recordRaw: true });
  const r = await runM10(o);
  assert.equal(r.stage, 'done', r.reason ?? '');
  assert.equal(r.rawRecorded, true);
  assert.deepEqual(readdirSync(join(o.work, 'raw')).sort(), LABELS.map((l) => `${l}.jsonl`).sort());
  for (const label of LABELS) {
    const raw = join(o.work, 'raw', `${label}.jsonl`);
    const chapters = await replayRun(runRoot(o, label), raw, join(runRoot(o, label), '.loreweave', 'ai.db'));
    const s = replaySummary(label, chapters, readRaw(raw).attempts);
    assert.deepEqual(s.attempts, { total: 4, response: 4, error: 0, aborted: 0, retried: 0, unattributed: 0 });
    assert.equal(s.matchesStored, 2, label);
    assert.deepEqual(s.differsFromStored, []);
    assert.equal(s.rawFindings, 4);
    assert.equal(s.kept, 2);
    assert.deepEqual(s.dropped, { noTarget: 1, noEvidence: 1, both: 0 });
    // 같은 키의 두 결과는 하나로, 설명은 확신도가 높은 둘째 묶음의 것
    const c3 = chapters.find((c) => c.file === '003.md')!;
    assert.equal(c3.merged.length, 1);
    assert.equal(c3.merged[0]!.claim, '둘째 묶음 설명');
    assert.equal(c3.findings.filter((f) => f.batch === 0).length, 3);
  }
});

test('기록 끔과 켬: 호출 수·요청·단계 장부·저장된 검사 결과가 같고, 끄면 raw 폴더가 없다', async () => {
  const off = fakeClient(detect);
  const on = fakeClient(detect);
  const oOff = options(off);
  const oOn = options(on, { recordRaw: true });
  const rOff = await runM10(oOff);
  const rOn = await runM10(oOn);
  assert.equal(rOff.stage, 'done');
  assert.equal(rOn.stage, 'done');
  assert.equal(rOff.rawRecorded, false);
  assert.equal(existsSync(join(oOff.work, 'raw')), false);
  assert.equal(off.calls.length, on.calls.length);
  assert.deepEqual(off.calls.map((c) => sha256(c.user)).sort(), on.calls.map((c) => sha256(c.user)).sort());
  assert.equal(rOff.ledger!.attempts, rOn.ledger!.attempts);
  assert.ok(Math.abs(rOff.ledger!.spent - rOn.ledger!.spent) < 1e-12);
  for (const label of LABELS) assert.equal(findingsOf(oOff, label), findingsOf(oOn, label), label);
});

/** 요청마다 직접 풀어 주는 가짜 클라이언트. auto가 켜지면 새 요청은 바로 응답한다 */
function gatedClient() {
  const pending: { call: JsonCall; resolve(): void; reject(e: unknown): void; settled: boolean }[] = [];
  let auto = false;
  const client = {
    calls: [] as JsonCall[],
    check: async () => {},
    setAuto() {
      auto = true;
    },
    json(call: JsonCall) {
      client.calls.push(call);
      const data = detect(call);
      if (auto) return Promise.resolve({ data, usage, modelVersion: 'gpt-6-luna-test', latencyMs: 1 });
      return new Promise<{ data: unknown; usage: typeof usage; modelVersion: string; latencyMs: number }>((resolve, reject) => {
        const p = {
          call,
          settled: false,
          resolve: () => {
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

test('동시 2·역순 완료: 둘째 묶음이 먼저 끝나도 화·묶음 귀속이 요청 fingerprint대로이고, 재생이 저장 결과와 같다', { timeout: 60_000 }, async () => {
  const { client, pending } = gatedClient();
  const o = options(client, { recordRaw: true });
  const run = runM10(o);
  await until(() => pending.length === 2);
  pending[1]!.resolve();
  await new Promise((r) => setTimeout(r, 20));
  // 이 뒤의 요청(3화 묶음)은 바로 응답한다. 같은 틱에 켜므로 그 요청들이 나가기 전이다
  client.setAuto();
  pending[0]!.resolve();
  const r = await run;
  assert.equal(r.stage, 'done', r.reason ?? '');
  const { attempts } = readRaw(join(o.work, 'raw', 'm4-1.jsonl'));
  const byUser = new Map(client.calls.map((c) => [sha256(c.user), { file: /<chapter n="2">/.test(c.user) ? '002.md' : '003.md', batch: firstBatch(c) ? 0 : 1 }]));
  for (const a of attempts) assert.deepEqual({ file: a.file, batch: a.batch }, byUser.get(a.userSha));
  const first = attempts.filter((a) => a.file === '002.md');
  assert.ok(first.find((a) => a.batch === 1)!.seqEnd < first.find((a) => a.batch === 0)!.seqEnd, '둘째 묶음이 먼저 끝났다');
  const chapters = await replayRun(runRoot(o, 'm4-1'), join(o.work, 'raw', 'm4-1.jsonl'), join(runRoot(o, 'm4-1'), '.loreweave', 'ai.db'));
  assert.ok(chapters.every((c) => c.matchesStored === true));
});

test('재시도: 응답 없는 연결 실패(시도 1)와 재시도 응답(시도 2)을 따로 남기고, 장부 시도 수와 맞으며, 재생이 저장 결과와 같다', async () => {
  let failed = false;
  const base = fakeClient(detect);
  const client = {
    calls: base.calls,
    check: async () => {},
    json: async (call: JsonCall) => {
      if (!failed && call.user.includes('<chapter n="2">') && firstBatch(call)) {
        failed = true;
        base.calls.push(call);
        throw new AiError('연결 끊김', 'network');
      }
      return base.json(call);
    },
  };
  const o = options(client, { recordRaw: true });
  const r = await runM10(o);
  assert.equal(r.stage, 'done', r.reason ?? '');
  const { attempts } = readRaw(join(o.work, 'raw', 'm4-1.jsonl'));
  const b0 = attempts.filter((a) => a.file === '002.md' && a.batch === 0);
  assert.deepEqual(b0.map((a) => [a.attempt, a.outcome, a.errorKind ?? null, a.data === undefined]), [[1, 'error', 'network', true], [2, 'response', null, false]]);
  assert.equal(attempts.length, r.stageSummary!.runs['m4-1']!.attempts);
  const chapters = await replayRun(runRoot(o, 'm4-1'), join(o.work, 'raw', 'm4-1.jsonl'), join(runRoot(o, 'm4-1'), '.loreweave', 'ai.db'));
  assert.ok(chapters.every((c) => c.matchesStored === true));
});

test('취소: 진행 중 두 시도는 응답 없이 aborted로 남고, 그 화는 저장되지 않으며, 재생은 불완전으로 표시한다', { timeout: 60_000 }, async () => {
  const { client, pending } = gatedClient();
  const cancel = new AbortController();
  const o = options(client, { recordRaw: true, signal: cancel.signal });
  const run = runM10(o);
  await until(() => pending.length === 2);
  cancel.abort();
  const r = await run;
  assert.equal(r.stage, 'stopped');
  const { attempts } = readRaw(join(o.work, 'raw', 'm4-1.jsonl'));
  assert.deepEqual(attempts.map((a) => [a.outcome, a.data === undefined]), [['aborted', true], ['aborted', true]]);
  const chapters = await replayRun(runRoot(o, 'm4-1'), join(o.work, 'raw', 'm4-1.jsonl'), join(runRoot(o, 'm4-1'), '.loreweave', 'ai.db'));
  const c2 = chapters.find((c) => c.file === '002.md')!;
  assert.equal(c2.complete, false);
  // 복사본의 검사 기록은 기준의 detect-1 그대로 (이 실행은 저장하지 않았다)
  const s = AiStore.open(runRoot(o, 'm4-1'));
  try {
    assert.equal(s.check('002.md')!.promptVersion, 'detect-1');
  } finally {
    s.close();
  }
});

test('기록 실패: 응답을 받은 뒤 쓰지 못하면 진단 완료로 보지 않고 새 요청을 멈추며, 그 usage로 장부를 정확히 정산하고, 그 화는 저장하지 않는다', async () => {
  const client = fakeClient(detect);
  let attemptsWritten = 0;
  const o = options(client, {
    recordRaw: true,
    rawWrite: (path, value) => {
      if ((value as { type: string }).type === 'attempt' && ++attemptsWritten === 2) throw new Error('디스크 가득 참');
      appendFileSync(path, JSON.stringify(value) + '\n');
    },
  });
  const r = await runM10(o);
  assert.equal(r.stage, 'stopped');
  assert.match(r.reason!, /기록하지 못해/);
  // 이미 동시에 보낸 두 묶음 뒤로는 보내지 않았다
  assert.equal(client.calls.length, 2);
  assert.equal(r.ledger!.attempts, 2);
  assert.equal(r.ledger!.inFlight, 0);
  assert.equal(r.ledger!.unknownUsage, 0);
  assert.ok(Math.abs(r.ledger!.spent - 2 * costUsd('gpt-6-luna', usage)) < 1e-12);
  assert.deepEqual(Object.keys(r.stageSummary!.runs), ['m4-1']);
  const s = AiStore.open(runRoot(o, 'm4-1'));
  try {
    assert.equal(s.check('002.md')!.promptVersion, 'detect-1');
  } finally {
    s.close();
  }
});

// ---- 검토 반영: 본문이 같은 요청, 이번 회차 저장과 기준의 예전 기록 구분

test('본문이 같은 요청: 어느 묶음의 응답인지 가릴 수 없으면 조용히 한 묶음으로 몰지 않고 회차 시작을 거부한다 (제품은 같은 사실을 합쳐 실제 경로에서는 생기지 않는다)', () => {
  assert.match(ambiguousRequests([{ file: '002.md', users: ['same', 'same'] }])!, /002\.md 묶음 1, 002\.md 묶음 2/);
  assert.equal(ambiguousRequests([{ file: '002.md', users: ['a', 'b'] }, { file: '003.md', users: ['c'] }]), null);
  const dir = join(tmp, 'raw-amb');
  const recorder = rawRecorder(dir, 't');
  assert.throws(() => recorder.startRun('m4-1', [{ file: '002.md', users: ['same', 'same'], factChapters: [1], inputs: [{ file: '002.md', contentHash: 'h' }] }]), RawRecordError);
  // 시작하지 못한 회차로는 보낼 수 없고, 아무 시도도 남지 않는다
  const client = recorder.wrap(fakeClient());
  return assert.rejects(client.json({ model: 'gpt-6-luna', system: 's', user: '<chapter n="2">same', schema: { name: 'continuity_findings', schema: {} } } as JsonCall), RawRecordError).then(() => {
    assert.equal(existsSync(join(dir, 'm4-1.jsonl')), false);
  });
});

test('역순 완료 + 재시도: 둘째 묶음이 먼저 끝나고 첫 묶음이 연결 실패 뒤 재시도로 응답해도, 묶음·시도 귀속이 정확하고 재생이 이번 저장과 같다', { timeout: 60_000 }, async () => {
  const { client, pending } = gatedClient();
  const o = options(client, { recordRaw: true });
  const run = runM10(o);
  await until(() => pending.length === 2);
  const b0 = pending.find((p) => firstBatch(p.call))!;
  const b1 = pending.find((p) => !firstBatch(p.call))!;
  b1.resolve();
  await new Promise((r) => setTimeout(r, 20));
  b0.reject(new AiError('연결 끊김', 'network'));
  await until(() => pending.length === 3);
  client.setAuto();
  pending[2]!.resolve();
  const r = await run;
  assert.equal(r.stage, 'done', r.reason ?? '');
  const { attempts } = readRaw(join(o.work, 'raw', 'm4-1.jsonl'));
  const c2 = attempts.filter((a) => a.file === '002.md').map((a) => [a.batch, a.attempt, a.outcome]);
  assert.deepEqual(c2, [[1, 1, 'response'], [0, 1, 'error'], [0, 2, 'response']]);
  const chapters = await replayRun(runRoot(o, 'm4-1'), join(o.work, 'raw', 'm4-1.jsonl'), join(runRoot(o, 'm4-1'), '.loreweave', 'ai.db'));
  assert.ok(chapters.every((c) => c.complete && c.matchesStored === true));
});

test('기준의 예전 검사 기록은 이번 저장이 아니다: 계획만 있고 시도가 없는 화는 불완전·미저장이며 성공 일치로 세지 않는다 (감독 재현)', async () => {
  const raw = join(tmp, 'plan-only.jsonl');
  writeFileSync(raw, JSON.stringify({ type: 'plan', run: 'm4-1', file: '002.md', batches: 2, factChapters: [1] }) + '\n');
  const chapters = await replayRun(real, raw, join(real, '.loreweave', 'ai.db'));
  const s = replaySummary('m4-1', chapters, []);
  assert.deepEqual(s.incomplete, ['002.md']);
  assert.deepEqual(s.notSaved, ['002.md']);
  assert.equal(s.matchesStored, 0);
  assert.equal(chapters[0]!.matchesStored, null);
});

test('성공 응답 뒤 취소: 두 묶음 응답을 다 받았어도 저장 전에 취소되면 그 화는 이번 저장이 아니다. 내용이 기준 기록과 우연히 같아도 일치로 세지 않는다', { timeout: 60_000 }, async () => {
  const { client, pending } = gatedClient();
  const cancel = new AbortController();
  const o = options(client, { recordRaw: true, signal: cancel.signal });
  const run = runM10(o);
  await until(() => pending.length === 2);
  // 2화 응답은 결과 없음 = 기준(가짜 기준 검사도 결과 없음)과 같은 내용
  pending[0]!.resolve();
  pending[1]!.resolve();
  cancel.abort();
  const r = await run;
  assert.equal(r.stage, 'stopped');
  const raw = join(o.work, 'raw', 'm4-1.jsonl');
  const { attempts, saved } = readRaw(raw);
  assert.deepEqual(attempts.map((a) => a.outcome), ['response', 'response']);
  assert.deepEqual(saved, []);
  const chapters = await replayRun(runRoot(o, 'm4-1'), raw, join(runRoot(o, 'm4-1'), '.loreweave', 'ai.db'));
  const c2 = chapters.find((c) => c.file === '002.md')!;
  assert.equal(c2.complete, true);
  assert.equal(c2.merged.length, 0);
  assert.equal(c2.stored, null);
  assert.equal(c2.matchesStored, null);
});

test('저장 기록 실패: 이 화를 DB에 저장한 뒤 saved 기록을 쓰지 못하면 새 요청을 멈추고, 그 화는 이번 저장으로 세지 않으며, 장부는 이미 보낸 호출만 정확히 정산한다', async () => {
  const client = fakeClient(detect);
  const o = options(client, {
    recordRaw: true,
    rawWrite: (path, value) => {
      if ((value as { type: string }).type === 'saved') throw new Error('디스크 가득 참');
      appendFileSync(path, JSON.stringify(value) + '\n');
    },
  });
  const r = await runM10(o);
  assert.equal(r.stage, 'stopped');
  assert.match(r.reason!, /저장 기록을 남기지 못해/);
  // 2화 두 묶음만 보내고 멈췄다
  assert.equal(client.calls.length, 2);
  assert.equal(r.ledger!.attempts, 2);
  assert.equal(r.ledger!.inFlight, 0);
  assert.equal(r.ledger!.unknownUsage, 0);
  assert.ok(Math.abs(r.ledger!.spent - 2 * costUsd('gpt-6-luna', usage)) < 1e-12);
  const raw = join(o.work, 'raw', 'm4-1.jsonl');
  const chapters = await replayRun(runRoot(o, 'm4-1'), raw, join(runRoot(o, 'm4-1'), '.loreweave', 'ai.db'));
  const c2 = chapters.find((c) => c.file === '002.md')!;
  // DB에는 이번 결과가 저장됐지만, saved 기록이 없으므로 이번 저장으로 세지 않는다
  assert.equal(c2.complete, true);
  assert.equal(c2.stored, null);
  assert.equal(c2.matchesStored, null);
});

// ---- 검토 반영 2: 실행 때 입력 원고 버전

test('입력 버전: 실행 뒤 대상 화만 / 근거 화만 / 둘 다 바뀌면 버전 오류로 따로 세고 성공 일치·남김·버림 집계에서 뺀다. 결과가 비어 기준과 우연히 같아도 마찬가지다. 그대로면 일치한다', async () => {
  // 모든 응답이 결과 없음 → 다시 돌린 결과(빈 목록)가 어떤 원고로도 우연히 같아지는 경우
  const o = options(fakeClient(), { recordRaw: true });
  const r = await runM10(o);
  assert.equal(r.stage, 'done', r.reason ?? '');
  const touch = (label: string, file: string) => appendFileSync(join(runRoot(o, label), 'chapters', file), '\n덧붙인 줄\n');
  touch('m4-1', '003.md'); // 대상만 (3화는 다른 화의 근거가 아니다)
  touch('m4-2', '001.md'); // 근거만 (2·3화 모두의 근거)
  touch('m4-3', '002.md'); // 2화는 대상, 3화에는 근거
  touch('m4-3', '001.md');
  const summary = async (label: string) => {
    const raw = join(o.work, 'raw', `${label}.jsonl`);
    const chapters = await replayRun(runRoot(o, label), raw, join(runRoot(o, label), '.loreweave', 'ai.db'));
    return { chapters, s: replaySummary(label, chapters, readRaw(raw).attempts) };
  };
  const one = await summary('m4-1');
  assert.deepEqual(one.s.versionMismatch, ['003.md']);
  assert.deepEqual(one.chapters.find((c) => c.file === '003.md')!.versionMismatch, ['003.md']);
  assert.equal(one.s.matchesStored, 1);
  const two = await summary('m4-2');
  assert.deepEqual(two.s.versionMismatch, ['002.md', '003.md']);
  assert.deepEqual(two.chapters.map((c) => c.versionMismatch), [['001.md'], ['001.md']]);
  assert.equal(two.s.matchesStored, 0);
  const three = await summary('m4-3');
  assert.deepEqual(three.chapters.map((c) => c.versionMismatch.sort()), [['001.md', '002.md'], ['001.md', '002.md']]);
  assert.equal(three.s.matchesStored, 0);
  // 버전 오류인 화의 원래 결과는 남김·버림 집계에 넣지 않는다 (이 화들은 결과가 없지만, 이번 저장 기록은 그대로 남아 있다)
  assert.ok(three.chapters.every((c) => c.findings.length === 0 && c.matchesStored === null && c.stored !== null));
  const four = await summary('m4-4');
  assert.deepEqual(four.s.versionMismatch, []);
  assert.equal(four.s.matchesStored, 2);
});

test('입력 버전: 기록된 계획에 입력 해시가 없으면 버전을 확인할 수 없어 성공 일치로 세지 않는다', async () => {
  const raw = join(tmp, 'no-inputs.jsonl');
  writeFileSync(raw, JSON.stringify({ type: 'plan', run: 'm4-1', file: '002.md', batches: 2, factChapters: [1] }) + '\n');
  const chapters = await replayRun(real, raw, join(real, '.loreweave', 'ai.db'));
  assert.deepEqual(chapters[0]!.versionMismatch, ['(기록 없음)']);
  assert.equal(chapters[0]!.matchesStored, null);
});
