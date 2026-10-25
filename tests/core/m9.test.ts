// M9 오프라인 구현 (M9-PLAN 4·5절): detect-2 후보, 기준 입력 대조, 호출 전 예약. 가짜 AI 클라이언트로 네트워크 없이 확인한다.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';
import { costUsd } from '../../src/core/ai/cost.ts';
import { DETECT_PROMPT_VERSION, DETECT_SCHEMA, DETECT_SYSTEM } from '../../src/core/ai/detection.ts';
import { modelInfo } from '../../src/core/ai/models.ts';
import { AiError, MAX_OUTPUT_TOKENS, type AiClient, type JsonCall } from '../../src/main/ai-client.ts';
import { AiStore } from '../../src/main/ai-db.ts';
import { checkChapter, prepareCheck } from '../../src/main/checker.ts';
import { fakeClient, M0A, makeBaseline, MODEL, REPO, tamper, TARGETS, usage } from './fixtures/m9-fixture.ts';
import { buildDetect2, DETECT2_SYSTEM, DETECT2_VERSION } from '../../scripts/lib/detect2.ts';
import { filesFingerprint, preflight } from '../../scripts/lib/m9-preflight.ts';
import { M9_STAGE_LIMIT_USD, overlapReason, runM9 } from '../../scripts/lib/m9-run.ts';
import { BudgetRefused, callCostBound, inputTokenBound, MESSAGE_OVERHEAD_TOKENS, withReservation } from '../../scripts/lib/reserve.ts';

let tmp: string;
let baseline: string;

const m9 = (over: Partial<Parameters<typeof runM9>[0]> = {}) => {
  const connected: AiClient[] = [];
  const client = fakeClient();
  const options: Parameters<typeof runM9>[0] = {
    label: 'real',
    baseline,
    work: join(tmp, 'work'),
    predictions: join(baseline, 'review', 'eval', 'predictions.json'),
    targets: TARGETS,
    runs: 2,
    ledgerDir: join(tmp, 'ledger'),
    run: false,
    connect: () => {
      connected.push(client);
      return client;
    },
    repoRoot: REPO,
    ...over,
  };
  return { options, client, connected };
};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'loreweave-m9-'));
  baseline = join(tmp, 'm8');
  await makeBaseline(baseline);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ---- detect-2 후보와 제품 기본값

test('detect-2: 규칙 2만 바뀌고 나머지 제외 규칙·출력 형식은 그대로, 제품 기본값은 detect-1', () => {
  assert.equal(DETECT_PROMPT_VERSION, 'detect-1');
  // M0-A에서 검증한 문구 그대로 (sha256 앞 12자리, detection.ts 머리말)
  assert.equal(createHash('sha256').update(DETECT_SYSTEM).digest('hex').slice(0, 12), '53207cd406ae');
  assert.notEqual(DETECT2_SYSTEM, DETECT_SYSTEM);
  assert.equal(DETECT2_VERSION, 'detect-2-candidate');
  for (const kept of ['별명, 호칭, 직함으로 부르는 것', '회상 장면', '인물의 거짓말이나 착각', '이전 내용과 충돌하지 않는 새 정보', '사망 전에 써 둔 편지나 유품'])
    assert.ok(DETECT2_SYSTEM.includes(kept), kept);
  assert.ok(DETECT2_SYSTEM.includes('본문에 없는 설명을 짐작해 만들지 않는다'));
  assert.ok(DETECT2_SYSTEM.includes('계산해서 비교'));
  assert.ok(!DETECT2_SYSTEM.includes('시간 경과에 따른 자연스러운 변화'));
  // 뒤 규칙은 번호만 하나씩 밀린다
  const tail = (s: string) => s.slice(s.indexOf('target_quote:')).replace(/^\d+\. /gm, '');
  assert.equal(tail(DETECT2_SYSTEM), tail(DETECT_SYSTEM));
  assert.match(DETECT2_SYSTEM, /^9\. 같은 모순은 한 번만/m);
  assert.throws(() => buildDetect2('다른 문구'), /예상과 달라/);
});

test('제품 검사는 여전히 detect-1로 보내고 detect-1로 저장한다', async () => {
  const root = join(tmp, 'product');
  await mkdir(join(root, 'chapters'), { recursive: true });
  for (const n of ['01', '02']) await copyFile(join(M0A, `ch${n}.md`), join(root, 'chapters', `0${n}.md`));
  const client = fakeClient();
  const store = AiStore.open(root);
  try {
    await checkChapter('002.md', { root, store, client, model: MODEL, signal: new AbortController().signal });
    const checks = client.calls.filter((c) => c.schema === DETECT_SCHEMA);
    assert.ok(checks.length > 0);
    assert.ok(checks.every((c) => c.system === DETECT_SYSTEM && c.maxOutputTokens === undefined));
    assert.equal(store.check('002.md')!.promptVersion, 'detect-1');
  } finally {
    store.close();
  }
});

// ---- 기준 입력 대조

test('대조: 그대로인 복사본은 모든 화가 맞고, 대조만 하면 클라이언트를 만들지 않는다', async () => {
  const before = filesFingerprint([join(baseline, '.loreweave', 'ai.db'), join(baseline, 'chapters', '003.md')]);
  const { options, connected } = m9();
  const r = await runM9(options);
  assert.equal(r.stage, 'preflight-ok', r.reason ?? '');
  assert.equal(r.connected, false);
  assert.equal(connected.length, 0);
  assert.equal(r.preflight.length, 2);
  for (const p of r.preflight) {
    assert.equal(p.ok, true);
    assert.equal(p.passed, 2);
    // 2화·3화 모두 1화 사실 450개를 받아 2묶음씩
    assert.equal(p.batches, 2 + 2);
  }
  // 기준 폴더는 읽기만 한다
  assert.equal(filesFingerprint([join(baseline, '.loreweave', 'ai.db'), join(baseline, 'chapters', '003.md')]), before);
  // 공개 집계에는 fingerprint·원문이 없다
  assert.ok(!JSON.stringify(r.preflight).includes('스무 살'));
  assert.ok(!/[0-9a-f]{64}/.test(JSON.stringify(r.preflight)));
});

const tampers: [string, (root: string) => Promise<void> | void, RegExp][] = [
  [
    '인용',
    (root) => tamper(root, "UPDATE facts SET quote = '둘 다 스물한 살이었다.' WHERE ord = 5 AND analysis_id = (SELECT id FROM analyses WHERE file = '001.md')"),
    /order/,
  ],
  [
    '순서',
    (root) => {
      // 인용이 다른 두 사실(0번, 1번)의 자리를 바꾼다. 내용은 그대로다
      const a = "analysis_id = (SELECT id FROM analyses WHERE file = '001.md')";
      tamper(root, `UPDATE facts SET ord = -1 WHERE ord = 0 AND ${a}`);
      tamper(root, `UPDATE facts SET ord = 0 WHERE ord = 1 AND ${a}`);
      tamper(root, `UPDATE facts SET ord = 1 WHERE ord = -1 AND ${a}`);
    },
    /order/,
  ],
  ['사실 수(묶음 경계)', (root) => tamper(root, "DELETE FROM facts WHERE ord = 449 AND analysis_id = (SELECT id FROM analyses WHERE file = '001.md')"), /fact-count/],
  ['묶음 호출 기록', (root) => tamper(root, "DELETE FROM calls WHERE id = (SELECT MAX(id) FROM calls WHERE file = '003.md' AND kind = 'check')"), /batches/],
  ['분석 시각', (root) => tamper(root, "UPDATE analyses SET created_at = '2027-01-01T00:00:00.000Z' WHERE file = '001.md'"), /provenance/],
  ['앞 화 해시', (root) => tamper(root, "UPDATE check_inputs SET content_hash = 'x' WHERE file = '001.md'"), /inputs/],
  ['본문', async (root) => writeFile(join(root, 'chapters', '003.md'), (await readFile(join(root, 'chapters', '003.md'), 'utf8')) + '\n덧붙인 줄\n'), /target-hash|work-analyses/],
];

for (const [name, change, item] of tampers) {
  test(`대조: 기준의 ${name}이(가) 바뀌면 실패하고, --run이어도 API 호출 0`, async () => {
    await change(baseline);
    const { options, client, connected } = m9({ run: true });
    const r = await runM9(options);
    assert.equal(r.stage, 'preflight-failed');
    assert.equal(r.connected, false);
    assert.equal(connected.length, 0);
    assert.equal(client.calls.length, 0);
    const items = r.preflight.flatMap((p) => Object.keys(p.failuresByItem));
    assert.ok(items.some((i) => item.test(i)), `${name}: ${items.join(',')}`);
  });
}

test('대조: 값만 바꾼 변조는 M8 기록으로는 알 수 없다 (재구성 한계). 작업 복사본과 기준이 다르면 실패한다', async () => {
  // 기준 자체의 값 변조: 값은 M8 당시 따로 기록되지 않았다. 이 경우 대조는 통과한다 (보고서에 한계로 밝힌다)
  tamper(baseline, "UPDATE facts SET value = '바뀐 값' WHERE ord = 3 AND analysis_id = (SELECT id FROM analyses WHERE file = '001.md')");
  const passed = await runM9(m9().options);
  assert.equal(passed.stage, 'preflight-ok');
  // 작업 복사본만 다르면(복사 뒤 변경) 기준과 비교해 잡는다
  const work = join(tmp, 'w2');
  await mkdir(work);
  await mkdir(join(work, 'chapters'));
  for (const f of ['001.md', '002.md', '003.md']) await copyFile(join(baseline, 'chapters', f), join(work, 'chapters', f));
  await mkdir(join(work, '.loreweave'));
  await copyFile(join(baseline, '.loreweave', 'ai.db'), join(work, '.loreweave', 'ai.db'));
  tamper(work, "UPDATE facts SET value = '또 바뀐 값' WHERE ord = 4 AND analysis_id = (SELECT id FROM analyses WHERE file = '001.md')");
  const store = AiStore.open(work);
  try {
    const predictions = JSON.parse(await readFile(join(baseline, 'review', 'eval', 'predictions.json'), 'utf8'));
    const report = await preflight({ baselineRoot: baseline, workRoot: work, workStore: store, predictions, targets: TARGETS });
    assert.equal(report.ok, false);
    assert.ok(report.chapters.find((c) => c.file === '003.md')!.failures.some((f) => f.item === 'work-analyses'));
  } finally {
    store.close();
  }
});

test('대조: 기준이 없으면 멈추고 호출 0 (검사 기록 없음, 평가기 출력 없음, ai.db 없음, 저장소 안 폴더)', async () => {
  tamper(baseline, "DELETE FROM checks WHERE file = '002.md'");
  const noCheck = m9({ run: true });
  const r1 = await runM9(noCheck.options);
  assert.equal(r1.stage, 'preflight-failed');
  assert.equal(noCheck.client.calls.length + noCheck.connected.length, 0);

  const noPred = m9({ run: true, work: join(tmp, 'w-a'), predictions: join(tmp, 'none.json') });
  assert.equal((await runM9(noPred.options)).stage, 'refused');
  const noDb = m9({ run: true, work: join(tmp, 'w-b'), baseline: join(tmp, 'empty') });
  assert.equal((await runM9(noDb.options)).stage, 'refused');
  const inRepo = m9({ run: true, work: join(REPO, 'm9-work-should-not-exist') });
  assert.equal((await runM9(inRepo.options)).stage, 'refused');
  const exists = m9({ run: true, work: tmp });
  assert.equal((await runM9(exists.options)).stage, 'refused');
  for (const x of [noPred, noDb, inRepo, exists]) assert.equal(x.client.calls.length + x.connected.length, 0);
});

test('실행: 대조 뒤 실행 직전에 작업 복사본이 바뀌면 보내지 않는다', async () => {
  const client = fakeClient();
  const work = join(tmp, 'work');
  const r = await runM9(
    m9({
      run: true,
      work,
      connect: () => {
        // 연결하는 사이에 다른 손이 run-1의 분석을 바꿨다
        tamper(join(work, 'run-1'), "UPDATE facts SET value = '실행 직전 변경' WHERE ord = 7 AND analysis_id = (SELECT id FROM analyses WHERE file = '001.md')");
        return client;
      },
    }).options,
  );
  assert.equal(r.stage, 'stopped');
  assert.match(r.reason!, /바뀌었|다릅니다/);
  assert.equal(client.calls.length, 0);
});

/** 폴더 아래 모든 파일과 폴더 (경로·크기·수정 시각) */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const st = statSync(p);
      out.push(`${p}|${e.isDirectory() ? 'd' : st.size}|${st.mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
}

const appendLine = async (file: string) => writeFile(file, (await readFile(file, 'utf8')) + '\n연결하는 사이 덧붙인 줄\n');

for (const [name, run, file] of [
  ['run-1의 마지막 대상', 'run-1', '003.md'],
  ['run-2의 첫 대상', 'run-2', '002.md'],
  ['run-2의 마지막 대상', 'run-2', '003.md'],
] as const) {
  test(`실행: 연결하는 동안 ${name} 본문이 바뀌면 첫 호출 전에 멈춘다 (전체 호출 0)`, async () => {
    const client = fakeClient();
    const work = join(tmp, 'work');
    const r = await runM9(
      m9({
        run: true,
        work,
        connect: async () => {
          await appendLine(join(work, run, 'chapters', file));
          return client;
        },
      }).options,
    );
    assert.equal(r.stage, 'stopped');
    assert.ok(r.reason!.startsWith(`${run} ${file}:`), r.reason!);
    assert.equal(client.calls.length, 0);
    assert.equal(r.ledger!.attempts, 0);
    assert.equal(r.ledger!.spent, 0);
  });
}

test('경로: 작업 폴더가 기준 폴더 안이거나, 링크(junction)를 거쳐 기준·저장소 안을 가리키면 아무것도 만들지 않고 거절한다', async () => {
  const before = tree(baseline);
  const cases: string[] = [join(baseline, 'nested-work'), join(baseline, 'a', 'b')];
  // junction: 관리자 권한 없이 만들 수 있다
  const toBase = join(tmp, 'link-to-base');
  symlinkSync(baseline, toBase, 'junction');
  cases.push(join(toBase, 'work'), join(toBase, 'x', 'y'));
  const toRepo = join(tmp, 'link-to-repo');
  symlinkSync(REPO, toRepo, 'junction');
  cases.push(join(toRepo, 'm9-work-should-not-exist'));
  for (const work of cases) {
    const x = m9({ run: true, work });
    const r = await runM9(x.options);
    assert.equal(r.stage, 'refused', work);
    assert.match(r.reason!, /저장소 밖|서로 안/);
    assert.equal(x.connected.length + x.client.calls.length, 0);
    assert.equal(existsSync(work), false, work);
  }
  // 기준을 링크로 가리켜도 같은 폴더로 본다
  const viaLink = m9({ run: true, baseline: toBase, work: join(baseline, 'w') });
  assert.equal((await runM9(viaLink.options)).stage, 'refused');
  assert.deepEqual(tree(baseline), before);
  assert.equal(existsSync(join(REPO, 'm9-work-should-not-exist')), false);
  // 기준이 작업 폴더 안에 있어도 안 된다 (아직 없는 작업 폴더가 기준의 부모일 수는 없으므로 함수로 확인)
  assert.match(overlapReason(REPO, baseline, tmp)!, /서로 안/);
  assert.equal(overlapReason(REPO, baseline, join(tmp, 'elsewhere')), null);
});

test('옵션: 실행 횟수·한도가 잘못되면 폴더를 만들기 전에 거절한다', async () => {
  const bad: [number, number][] = [
    [0, 1],
    [-1, 1],
    [Number.NaN, 1],
    [1.5, 1],
    [11, 1],
    [Number.POSITIVE_INFINITY, 1],
    [2, 0],
    [2, -1],
    [2, Number.NaN],
    [2, Number.POSITIVE_INFINITY],
    [2, M9_STAGE_LIMIT_USD + 0.01],
  ];
  for (const [runs, limitUsd] of bad) {
    const work = join(tmp, `w-${String(runs)}-${String(limitUsd)}`);
    const x = m9({ run: true, work, runs, stage: { id: 'test-bad', limitUsd } });
    const r = await runM9(x.options);
    assert.equal(r.stage, 'refused', `${runs} ${limitUsd}`);
    assert.equal(existsSync(join(tmp, 'ledger')), false);
    assert.equal(x.connected.length + x.client.calls.length, 0);
    assert.equal(existsSync(work), false);
  }
});

test('실행: 통과하면 detect-2로, M8과 같은 사용자 입력을 보내고 기준 폴더는 그대로다', async () => {
  // 기준(detect-1) 때 보낸 사용자 입력
  const store = AiStore.open(join(baseline));
  const expected: string[] = [];
  try {
    for (const f of TARGETS) {
      const p = await prepareCheck(f, { root: baseline, store });
      assert.ok(typeof p !== 'string');
      expected.push(...p.users);
    }
  } finally {
    store.close();
  }
  const before = filesFingerprint([join(baseline, 'chapters', '003.md'), join(baseline, 'review', 'eval', 'predictions.json')]);
  const { options, client } = m9({ run: true });
  const r = await runM9(options);
  assert.equal(r.stage, 'done', r.reason ?? '');
  assert.equal(client.calls.length, expected.length * 2);
  assert.ok(client.calls.every((c) => c.system === DETECT2_SYSTEM && c.schema === DETECT_SCHEMA && c.maxOutputTokens === MAX_OUTPUT_TOKENS));
  assert.deepEqual(client.calls.slice(0, expected.length).map((c) => c.user).sort(), [...expected].sort());
  assert.equal(r.ledger!.attempts, expected.length * 2);
  assert.ok(Math.abs(r.ledger!.spent - expected.length * 2 * costUsd(MODEL, usage)) < 1e-12);
  assert.equal(r.ledger!.inFlight, 0);
  const run1 = AiStore.open(join(tmp, 'work', 'run-1'));
  try {
    assert.equal(run1.check('003.md')!.promptVersion, DETECT2_VERSION);
  } finally {
    run1.close();
  }
  assert.equal(filesFingerprint([join(baseline, 'chapters', '003.md'), join(baseline, 'review', 'eval', 'predictions.json')]), before);
  const snap = new DatabaseSync(join(baseline, '.loreweave', 'ai.db'), { readOnly: true });
  try {
    assert.deepEqual(
      (snap.prepare('SELECT DISTINCT prompt_version AS v FROM checks').all() as { v: string }[]).map((x) => x.v),
      ['detect-1'],
    );
  } finally {
    snap.close();
  }
});

test('실행: 예산이 상한 비용 한 번분도 안 되면 첫 호출 전에 멈추고 저장하지 않는다', async () => {
  const { options, client } = m9({ run: true, stage: { id: 'test-small', limitUsd: 0.001 } });
  const r = await runM9(options);
  assert.equal(r.stage, 'stopped');
  assert.match(r.reason!, /한도/);
  assert.equal(client.calls.length, 0);
  assert.equal(r.ledger!.spent, 0);
  const run1 = AiStore.open(join(tmp, 'work', 'run-1'));
  try {
    assert.equal(run1.check('002.md')!.promptVersion, 'detect-1');
  } finally {
    run1.close();
  }
});

// ---- 호출 전 예약

const call = (user = '본문', signal?: AbortSignal): JsonCall => ({ model: MODEL, system: DETECT_SYSTEM, user, schema: DETECT_SCHEMA, signal });

test('예약: 입력 상한은 UTF-8 바이트 + 스키마 + 형식 몫, 출력은 요청에 거는 상한 전부, 입력 단가는 가장 비싼 것', () => {
  const c = call('가나다');
  const bytes = Buffer.byteLength(DETECT_SYSTEM) + 9 + Buffer.byteLength(JSON.stringify(DETECT_SCHEMA));
  assert.equal(inputTokenBound(c), bytes + MESSAGE_OVERHEAD_TOKENS);
  const p = modelInfo(MODEL).price;
  assert.equal(callCostBound(MODEL, c, 16_000), ((bytes + MESSAGE_OVERHEAD_TOKENS) * p.cacheWrite + 16_000 * p.output) / 1e6);
  // 같은 토큰이 캐시 쓰기로 매겨져도 상한을 넘지 않는다
  const worst = costUsd(MODEL, { inputTokens: inputTokenBound(c), cachedTokens: 0, cacheWriteTokens: inputTokenBound(c), outputTokens: 16_000 });
  assert.ok(worst <= callCostBound(MODEL, c, 16_000) + 1e-15);
});

/** 응답을 직접 풀어 주는 가짜 클라이언트 */
function gated() {
  const pending: { call: JsonCall; resolve(u: typeof usage): void; reject(e: unknown): void }[] = [];
  const client: AiClient = {
    async check() {},
    json: (c) =>
      new Promise((resolve, reject) => {
        pending.push({ call: c, resolve: (u) => resolve({ data: {}, usage: u, modelVersion: 'm', latencyMs: 1 }), reject });
      }),
  };
  return { client, pending };
}

test('예약: 동시에 부른 두 호출이 남은 한도 하나분을 함께 쓰지 않고, 거절 뒤에는 새 호출을 보내지 않는다', async () => {
  const one = callCostBound(MODEL, call(), MAX_OUTPUT_TOKENS);
  const { client, pending } = gated();
  const ai = withReservation(client, { model: MODEL, limitUsd: one * 1.5 });
  const first = ai.json(call());
  const second = ai.json(call());
  await assert.rejects(second, BudgetRefused);
  assert.equal(pending.length, 1);
  assert.ok(Math.abs(ai.ledger().inFlight - one) < 1e-15);
  pending[0]!.resolve(usage);
  await first;
  assert.equal(ai.ledger().inFlight, 0);
  assert.equal(ai.ledger().spent, costUsd(MODEL, usage));
  // 정산 뒤 한도가 남아도 한 번 거절했으면 멈춘다
  await assert.rejects(ai.json(call()), BudgetRefused);
  assert.equal(pending.length, 1);
  assert.ok(ai.ledger().refused);
});

test('예약: 출력 상한을 실제 요청에 걸고 예약에 반영한다', async () => {
  const { client, pending } = gated();
  const ai = withReservation(client, { model: MODEL, limitUsd: 1, maxOutputTokens: 4_000 });
  const p = ai.json(call());
  assert.equal(pending[0]!.call.maxOutputTokens, 4_000);
  assert.ok(Math.abs(ai.ledger().inFlight - callCostBound(MODEL, call(), 4_000)) < 1e-15);
  assert.ok(callCostBound(MODEL, call(), 4_000) < callCostBound(MODEL, call(), 16_000));
  pending[0]!.resolve(usage);
  await p;
});

test('예약: usage가 상한보다 크면 usage로, 실패에 usage가 있으면 usage로, 모르면 예약액 전부를 지출로 남긴다', async () => {
  const bound = callCostBound(MODEL, call(), MAX_OUTPUT_TOKENS);
  const { client, pending } = gated();
  const ai = withReservation(client, { model: MODEL, limitUsd: 10 });
  const big = { inputTokens: 900_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 100 };
  const a = ai.json(call());
  pending[0]!.resolve(big);
  await a;
  assert.equal(ai.ledger().spent, costUsd(MODEL, big));
  const b = ai.json(call());
  pending[1]!.reject(Object.assign(new AiError('끝나지 않음', 'incomplete'), { usage }));
  await assert.rejects(b);
  assert.ok(Math.abs(ai.ledger().spent - costUsd(MODEL, big) - costUsd(MODEL, usage)) < 1e-12);
  const c = ai.json(call());
  pending[2]!.reject(new AiError('알 수 없음', 'other'));
  await assert.rejects(c);
  assert.ok(Math.abs(ai.ledger().spent - costUsd(MODEL, big) - costUsd(MODEL, usage) - bound) < 1e-12);
  assert.equal(ai.ledger().unknownUsage, 1);
  assert.equal(ai.ledger().inFlight, 0);
});

test('예약: 재시도는 시도마다 따로 예약하고, 실패한 시도의 예약액은 지출로 남긴다', async () => {
  const bound = callCostBound(MODEL, call(), MAX_OUTPUT_TOKENS);
  const { client, pending } = gated();
  const ai = withReservation(client, { model: MODEL, limitUsd: 10, retries: 1 });
  const p = ai.json(call());
  pending[0]!.reject(new AiError('연결 끊김', 'network'));
  await new Promise((r) => setImmediate(r));
  assert.equal(pending.length, 2);
  pending[1]!.resolve(usage);
  await p;
  const l = ai.ledger();
  assert.equal(l.attempts, 2);
  assert.ok(Math.abs(l.spent - bound - costUsd(MODEL, usage)) < 1e-12);
  // 인증 오류는 다시 보내지 않는다
  const q = ai.json(call());
  pending[2]!.reject(new AiError('키', 'auth'));
  await assert.rejects(q);
  assert.equal(pending.length, 3);
});

test('예약: 재시도 한도를 넘으면 멈추고, 재시도 예약이 한도를 넘으면 거절한다', async () => {
  const bound = callCostBound(MODEL, call(), MAX_OUTPUT_TOKENS);
  const { client, pending } = gated();
  const ai = withReservation(client, { model: MODEL, limitUsd: bound * 1.5, retries: 3 });
  const p = ai.json(call());
  pending[0]!.reject(new AiError('한도', 'rate-limit'));
  await assert.rejects(p, BudgetRefused);
  assert.equal(pending.length, 1);
  assert.ok(Math.abs(ai.ledger().spent - bound) < 1e-15);
});

test('예약: 취소하면 다시 보내지 않고 예약액을 지출로 남긴다', async () => {
  const bound = callCostBound(MODEL, call(), MAX_OUTPUT_TOKENS);
  const { client, pending } = gated();
  const ai = withReservation(client, { model: MODEL, limitUsd: 10, retries: 3 });
  const controller = new AbortController();
  const p = ai.json(call('본문', controller.signal));
  controller.abort();
  pending[0]!.reject(new AiError('취소', 'network'));
  await assert.rejects(p);
  assert.equal(pending.length, 1);
  assert.ok(Math.abs(ai.ledger().spent - bound) < 1e-15);
  await assert.rejects(ai.json({ ...call(), model: 'gpt-6.1-sol' }), /다른 모델/);
});
