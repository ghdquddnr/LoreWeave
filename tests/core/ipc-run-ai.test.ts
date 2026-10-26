// main IPC의 분석·검사 단일 실행 (src/main/ipc.ts runAi). 실제 ipc.ts를 TypeScript로 옮겨 실행하고,
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
      dialog: { showOpenDialog: async () => ({ filePaths: ['fake-project'], canceled: false }) },
    },
    '../preload/api.ts': { CHANNELS: new Proxy({}, { get: (_t, key) => key }) },
    './settings.ts': {
      // 프로젝트 열기·기타 경로는 바로 답하고, runAi의 설정 읽기만 테스트가 풀어 준다
      readSettings: (_dir: string) => later(settingsQueue),
      updateSettings: async () => {},
    },
    './secrets.ts': { loadApiKey: () => later(keyQueue) },
    './project-files.ts': { listChapters: async () => [] },
    './watch.ts': { watchChapters: () => () => {} },
    './index-db.ts': { INDEX_DIR: '.index', ManuscriptIndex: { open: () => ({ close() {} }) } },
    './indexer.ts': { syncIndex: async () => {} },
    './ai-db.ts': { AiStore: { open: () => ({ close() {} }) } },
    './ai-client.ts': {
      createOpenAiClient: () => {
        clients++;
        return {};
      },
      toAiError: (e: unknown) => e,
    },
    './analyzer.ts': { analyzeChapters: runWork('analyze'), analysisStates: async () => ({}), estimate: async () => ({}) },
    './checker.ts': { checkChapter: runWork('check'), checkStates: async () => ({}), planCheck: async () => ({}) },
  };
  const source = readFileSync(join(__dirname, '../../src/main/ipc.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const real = createRequire(__filename);
  const mod = { exports: {} as { registerIpc(): void } };
  new Function('require', 'module', 'exports', code)((name: string) => fakes[name] ?? (name.startsWith('node:') ? real(name) : {}), mod, mod.exports);
  mod.exports.registerIpc();
  const sender = { send() {} };
  return {
    handlers,
    settingsQueue,
    keyQueue,
    work,
    clients: () => clients,
    open: async () => {
      // 프로젝트를 연다 (openProject의 설정 쓰기는 바로 끝난다)
      await (handlers.get('projectChoose')!({ sender }) as Promise<unknown>);
    },
    analyze: () => handlers.get('aiAnalyze')!({ sender }, ['001.md']) as Promise<unknown>,
    check: () => handlers.get('aiRunCheck')!({ sender }, '003.md') as Promise<unknown>,
    cancel: () => handlers.get('aiCancel')!({}),
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
