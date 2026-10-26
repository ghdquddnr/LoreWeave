// main IPC의 분석·검사 단일 실행 (src/main/ipc.ts runAi)과 AI 패널 요청(분석 상태·결과 조회·무시)의 프로젝트 token 경계. 실제 ipc.ts를 TypeScript로 옮겨 실행하고,
// Electron·설정·키·분석·검사를 가짜로 바꿔 네트워크·키·원고 없이 확인한다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** ipc.ts를 가짜 의존성으로 불러 IPC 핸들러를 돌려준다. 설정·키 읽기와 작업은 테스트가 풀어 준다 */
function loadIpc() {
  const handlers = new Map<string, Handler>();
  const settingsQueue: { resolve(v: unknown): void; reject(e: unknown): void }[] = [];
  const keyQueue: { resolve(v: unknown): void }[] = [];
  const work: { kind: string; signal: AbortSignal; finish: () => void }[] = [];
  let clients = 0;
  /** 지금까지 연 AI 저장소 (가짜). 닫힌 저장소를 읽으면 실제 node:sqlite처럼 던진다 */
  const stores: { path: string; closed: boolean; dismissed: string[] }[] = [];
  /** ai.db가 있는 것으로 볼지 (분석 상태·결과 조회·무시가 저장소를 연다) */
  let aiDb = false;
  /** 다음 프로젝트 열기에서 고를 폴더 */
  let nextPath = 'fake-project';
  /** 분석 상태 읽기(analysisStates)는 테스트가 풀어 준다 */
  const statesQueue: { resolve(v: unknown): void }[] = [];
  const later = <T>(queue: { resolve(v: T): void; reject?(e: unknown): void }[]) =>
    new Promise<T>((resolve, reject) => queue.push({ resolve, reject } as never));
  const runWork = (kind: string) => async (_x: unknown, o: { signal: AbortSignal }) => {
    const d = deferred();
    work.push({ kind, signal: o.signal, finish: () => d.resolve() });
    await d.promise;
    return { kind };
  };
  const fakes: Record<string, unknown> = {
    electron: {
      app: { getPath: () => 'fake-user-data' },
      ipcMain: { handle: (name: string, fn: Handler) => handlers.set(name, fn) },
      BrowserWindow: { fromWebContents: () => ({}) },
      dialog: { showOpenDialog: async () => ({ filePaths: [nextPath], canceled: false }) },
    },
    '../preload/api.ts': { CHANNELS: new Proxy({}, { get: (_t, key) => key }), STALE_PROJECT: '원고 폴더가 바뀌어 이 요청을 처리하지 않았습니다' },
    './settings.ts': {
      // 프로젝트 열기·기타 경로는 바로 답하고, runAi의 설정 읽기만 테스트가 풀어 준다
      readSettings: (_dir: string) => later(settingsQueue),
      updateSettings: async () => {},
    },
    './secrets.ts': { loadApiKey: () => later(keyQueue) },
    './project-files.ts': { listChapters: async () => [], chapterFileNames: async () => [] },
    './watch.ts': { watchChapters: () => () => {} },
    './index-db.ts': { INDEX_DIR: '.index', ManuscriptIndex: { open: () => ({ close() {} }) } },
    './indexer.ts': { syncIndex: async () => {} },
    'node:fs': { existsSync: (p: string) => aiDb && p.endsWith('ai.db') },
    './ai-db.ts': {
      AiStore: {
        open: (path: string) => {
          const s = { path, closed: false, dismissed: [] as string[] };
          stores.push(s);
          const open = () => {
            if (s.closed) throw new Error('database is not open');
          };
          return {
            close: () => void (s.closed = true),
            check: (file: string) => (open(), { file, path, findings: [{ ord: 0, category: 'age', key: `${path}-key` }] }),
            analysis: (file: string) => (open(), { file, path }),
            dismiss: (file: string, _c: string, key: string) => (open(), s.dismissed.push(`${file}:${key}`)),
            totalCost: () => (open(), 0),
            recoveredFrom: null,
            assertOpen: open,
          };
        },
      },
    },
    './ai-client.ts': {
      createOpenAiClient: () => {
        clients++;
        return {};
      },
      toAiError: (e: unknown) => e,
    },
    './analyzer.ts': {
      analyzeChapters: runWork('analyze'),
      analysisStates: async (path: string, store: { assertOpen(): void }) => {
        await later(statesQueue);
        store.assertOpen();
        return { [`${path}.md`]: 'fresh' };
      },
      estimate: async () => ({}),
    },
    './checker.ts': { checkChapter: runWork('check'), checkStates: async () => ({}), planCheck: async () => ({}) },
  };
  const source = readFileSync(join(__dirname, '../../src/main/ipc.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const real = createRequire(__filename);
  const mod = { exports: {} as { registerIpc(): void } };
  new Function('require', 'module', 'exports', code)((name: string) => fakes[name] ?? (name.startsWith('node:') ? real(name) : {}), mod, mod.exports);
  mod.exports.registerIpc();
  const sender = { send() {} };
  /** 마지막으로 연 프로젝트의 token (분석·검사 요청에 함께 보낸다) */
  let token = 0;
  return {
    handlers,
    settingsQueue,
    keyQueue,
    work,
    stores,
    statesQueue,
    clients: () => clients,
    withAiDb: () => void (aiDb = true),
    open: async (path = 'fake-project') => {
      // 프로젝트를 연다 (openProject의 설정 쓰기는 바로 끝난다)
      nextPath = path;
      token = ((await handlers.get('projectChoose')!({ sender })) as { token: number }).token;
      return token;
    },
    analyze: (t = token) => handlers.get('aiAnalyze')!({ sender }, ['001.md'], t) as Promise<unknown>,
    check: (t = token) => handlers.get('aiRunCheck')!({ sender }, '003.md', t) as Promise<unknown>,
    estimate: (t: number) => handlers.get('aiEstimate')!({ sender }, ['001.md'], t) as Promise<unknown>,
    planCheck: (t: number) => handlers.get('aiPlanCheck')!({ sender }, '003.md', t) as Promise<unknown>,
    cancel: () => handlers.get('aiCancel')!({}),
    status: (t: number) => handlers.get('aiAnalysisStatus')!({}, t) as Promise<unknown>,
    analysis: (t: number) => Promise.resolve().then(() => handlers.get('aiAnalysis')!({}, '001.md', t)),
    checkResult: (t: number) => Promise.resolve().then(() => handlers.get('aiCheckResult')!({}, '001.md', t)),
    dismiss: (t: number) => Promise.resolve().then(() => handlers.get('aiDismiss')!({}, '001.md', 0, t)),
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const settle = (p: Promise<unknown>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e: e instanceof Error ? e.message : String(e) }));
const ok = { aiSendConsent: true, aiModel: 'gpt-6-luna' };

for (const [name, second] of [
  ['분석/분석', 'analyze'],
  ['분석/검사', 'check'],
] as const) {
  test(`단일 진입 (${name}): 설정을 읽는 동안 들어온 두 번째 요청은 거절되고, 작업은 하나만 시작한다`, { timeout: 10_000 }, async () => {
    const ipc = loadIpc();
    await ipc.open();
    const first = settle(ipc.analyze());
    const other = settle(second === 'analyze' ? ipc.analyze() : ipc.check());
    await tick();
    assert.deepEqual(await other, { ok: false, e: '이미 분석 중입니다' });
    // 두 번째 요청은 설정도 읽지 않았다
    assert.equal(ipc.settingsQueue.length, 1);
    ipc.settingsQueue[0]!.resolve(ok);
    await tick();
    ipc.keyQueue[0]!.resolve('fake-key');
    await tick();
    assert.equal(ipc.work.length, 1);
    assert.equal(ipc.clients(), 1);
    ipc.work[0]!.finish();
    assert.equal((await first).ok, true);
  });
}

for (const [name, fail] of [
  ['전송 동의 거절', (ipc: ReturnType<typeof loadIpc>) => ipc.settingsQueue[0]!.resolve({ ...ok, aiSendConsent: false })],
  ['설정 읽기 실패', (ipc: ReturnType<typeof loadIpc>) => ipc.settingsQueue[0]!.reject(new Error('설정 파일을 읽을 수 없습니다'))],
  ['키 없음', async (ipc: ReturnType<typeof loadIpc>) => {
    ipc.settingsQueue[0]!.resolve(ok);
    await tick();
    ipc.keyQueue[0]!.resolve(null);
  }],
] as const) {
  test(`복구 (${name}): 앞 요청이 사전조건에서 실패한 뒤에는 다음 요청이 정상으로 진행한다`, { timeout: 10_000 }, async () => {
    const ipc = loadIpc();
    await ipc.open();
    const first = settle(ipc.analyze());
    await tick();
    await fail(ipc);
    assert.equal((await first).ok, false);
    assert.equal(ipc.work.length, 0);
    assert.equal(ipc.clients(), 0);
    const next = settle(ipc.check());
    await tick();
    ipc.settingsQueue.at(-1)!.resolve(ok);
    await tick();
    ipc.keyQueue.at(-1)!.resolve('fake-key');
    await tick();
    assert.equal(ipc.work.length, 1);
    ipc.work[0]!.finish();
    assert.deepEqual(await next, { ok: true, v: { kind: 'check' } });
  });
}

test('취소 (사전조건 대기 중): 설정·키를 읽는 동안 취소하면 작업과 API 클라이언트를 만들지 않고, 다음 요청은 새로 진행한다', { timeout: 10_000 }, async () => {
  const ipc = loadIpc();
  await ipc.open();
  const first = settle(ipc.analyze());
  await tick();
  ipc.cancel();
  ipc.settingsQueue[0]!.resolve(ok);
  await tick();
  ipc.keyQueue[0]!.resolve('fake-key');
  assert.deepEqual(await first, { ok: false, e: '취소했습니다' });
  assert.equal(ipc.work.length, 0);
  assert.equal(ipc.clients(), 0);
  const next = settle(ipc.analyze());
  await tick();
  ipc.settingsQueue.at(-1)!.resolve(ok);
  await tick();
  ipc.keyQueue.at(-1)!.resolve('fake-key');
  await tick();
  assert.equal(ipc.work.length, 1);
  assert.equal(ipc.work[0]!.signal.aborted, false);
  ipc.work[0]!.finish();
  assert.equal((await next).ok, true);
});

test('취소 (작업 중): 진행 중인 작업의 신호로 전달되고, 끝난 뒤 다음 작업은 새 신호를 받는다', { timeout: 10_000 }, async () => {
  const ipc = loadIpc();
  await ipc.open();
  const first = settle(ipc.analyze());
  await tick();
  ipc.settingsQueue[0]!.resolve(ok);
  await tick();
  ipc.keyQueue[0]!.resolve('fake-key');
  await tick();
  assert.equal(ipc.work.length, 1);
  // 작업 중에는 다른 요청을 받지 않는다
  assert.deepEqual(await settle(ipc.check()), { ok: false, e: '이미 분석 중입니다' });
  ipc.cancel();
  assert.equal(ipc.work[0]!.signal.aborted, true);
  ipc.work[0]!.finish();
  await first;
  const next = settle(ipc.check());
  await tick();
  ipc.settingsQueue.at(-1)!.resolve(ok);
  await tick();
  ipc.keyQueue.at(-1)!.resolve('fake-key');
  await tick();
  assert.equal(ipc.work.length, 2);
  assert.equal(ipc.work[1]!.kind, 'check');
  assert.equal(ipc.work[1]!.signal.aborted, false);
  ipc.work[1]!.finish();
  assert.equal((await next).ok, true);
});

test('이전 프로젝트 token: 같은 폴더를 다시 연 뒤 이전 화면의 분석·검사·예상 비용·검사 계획 요청은 설정·키를 읽기 전에 거절되고, 자리를 잡지 않아 새 token 요청은 정상 실행된다', { timeout: 10_000 }, async () => {
  const ipc = loadIpc();
  const old = await ipc.open();
  const now = await ipc.open();
  assert.notEqual(old, now);
  for (const call of [() => ipc.analyze(old), () => ipc.check(old), () => ipc.estimate(old), () => ipc.planCheck(old)]) {
    const r = await settle(call());
    assert.deepEqual(r, { ok: false, e: '원고 폴더가 바뀌어 이 요청을 처리하지 않았습니다' });
  }
  // 거절된 요청은 설정·키를 읽지 않았고, 작업·클라이언트·저장소를 만들지 않았다
  assert.equal(ipc.settingsQueue.length, 0);
  assert.equal(ipc.keyQueue.length, 0);
  assert.equal(ipc.work.length, 0);
  assert.equal(ipc.clients(), 0);
  // 지금 token의 분석은 정상 실행된다 (이전 요청이 자리를 잡지 않았다)
  const run = settle(ipc.analyze(now));
  await tick();
  ipc.settingsQueue.shift()!.resolve(ok);
  await tick();
  ipc.keyQueue.shift()!.resolve('sk-test');
  for (let i = 0; i < 20 && ipc.work.length === 0; i++) await tick();
  assert.equal(ipc.work.length, 1);
  ipc.work[0]!.finish();
  assert.deepEqual(await run, { ok: true, v: { kind: 'analyze' } });
});

const STALE = '원고 폴더가 바뀌어 이 요청을 처리하지 않았습니다';

for (const [name, second] of [
  ['다른 폴더(A→B)', 'fake-B'],
  ['같은 폴더 다시 열기', 'fake-project'],
] as const) {
  test(`AI 패널 (${name}): 이전 화면의 무시·결과·분석 상태 요청은 거절되고 새 프로젝트 저장소에 쓰지 않는다. 지금 token의 요청은 정상이다`, { timeout: 10_000 }, async () => {
    const ipc = loadIpc();
    ipc.withAiDb();
    const old = await ipc.open('fake-project');
    const now = await ipc.open(second);
    for (const call of [() => ipc.dismiss(old), () => ipc.checkResult(old), () => ipc.analysis(old), () => ipc.status(old)]) {
      assert.deepEqual(await settle(call()), { ok: false, e: STALE });
    }
    // 거절은 저장소를 열기 전이다 (새 프로젝트의 ai.db를 열지도, 쓰지도 않았다)
    assert.equal(ipc.stores.length, 0);
    assert.equal(ipc.settingsQueue.length, 0);
    // 지금 token: 조회·무시는 지금 프로젝트의 저장소로 간다
    assert.deepEqual(await settle(ipc.checkResult(now)), { ok: true, v: { file: '001.md', path: second, findings: [{ ord: 0, category: 'age', key: `${second}-key` }] } });
    assert.deepEqual(await settle(ipc.dismiss(now)), { ok: true, v: undefined });
    assert.deepEqual(ipc.stores.map((s) => [s.path, s.dismissed]), [[second, [`001.md:${second}-key`]]]);
  });
}

for (const [name, closedError] of [
  ['저장소가 닫혀 읽기가 실패', true],
  ['읽기는 끝났지만 프로젝트가 바뀜', false],
] as const) {
  test(`분석 상태 늦은 응답 (${name}): 기다리는 사이 다른 프로젝트를 열면 결과도 닫힌 저장소의 오류도 돌려주지 않고 STALE_PROJECT로 끝난다. 새 프로젝트의 분석 상태는 정상이다`, { timeout: 10_000 }, async () => {
    const ipc = loadIpc();
    ipc.withAiDb();
    const old = await ipc.open('fake-A');
    const late = settle(ipc.status(old));
    await tick();
    // 설정 읽기를 기다리는 중 (저장소는 이미 열었다)
    assert.equal(ipc.stores.length, 1);
    if (closedError) {
      await ipc.open('fake-B');
      ipc.settingsQueue.shift()!.resolve(ok);
      await tick();
      ipc.statesQueue.shift()!.resolve(undefined);
    } else {
      ipc.settingsQueue.shift()!.resolve(ok);
      await tick();
      // 상태 읽기가 끝나기 직전에 다른 프로젝트를 연다
      await ipc.open('fake-B');
      ipc.statesQueue.shift()!.resolve(undefined);
    }
    assert.deepEqual(await late, { ok: false, e: STALE });
    // 이전 프로젝트의 저장소는 열기에서 닫혔다
    assert.equal(ipc.stores[0]!.closed, true);
    const now = settle(ipc.status(2));
    await tick();
    ipc.settingsQueue.shift()!.resolve(ok);
    for (let i = 0; i < 20 && ipc.statesQueue.length === 0; i++) await tick();
    ipc.statesQueue.shift()!.resolve(undefined);
    const r = await now;
    assert.equal(r.ok, true);
    assert.deepEqual((r as { v: { states: unknown } }).v.states, { 'fake-B.md': 'fresh' });
  });
}
