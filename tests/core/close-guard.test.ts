// 창 닫기 가드 (src/main/ipc.ts guardWindowClose): 실제 ipc.ts를 TypeScript로 옮겨 실행하고 Electron을 가짜로 바꿔 확인한다.
// 정책: 저장 완료(true) 응답이 있어야 닫는다. 10초가 지나도 답이 없으면 닫지 않고 native 안내로 "계속 기다리기"/"닫기 취소"를 묻는다.
// 닫기 시도마다 번호가 있고, 취소했거나 끝난 시도의 늦은 응답과 다른 창의 응답은 이후 시도를 승인하지 못한다. 타이머는 node:test의 가짜 타이머로 앞당긴다 (실제 10초를 기다리지 않는다).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import ts from 'typescript';

type Reply = (event: { sender: unknown }, proceed: boolean, attempt: number) => void;
type CloseHandler = (event: { preventDefault(): void }) => void;

function setup() {
  const listeners = new Map<string, Reply[]>();
  const dialogs: { buttons: string[]; resolve(response: number): void; reject(e: unknown): void; aborted: boolean }[] = [];
  const fakes: Record<string, unknown> = {
    electron: {
      app: { getPath: () => 'fake-user-data' },
      ipcMain: {
        handle: () => {},
        on: (name: string, fn: Reply) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
        removeListener: (name: string, fn: Reply) => listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== fn)),
      },
      BrowserWindow: { fromWebContents: () => ({}) },
      dialog: {
        showMessageBox: (_win: unknown, opts: { buttons: string[]; signal?: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const entry = { buttons: opts.buttons, aborted: false, resolve: (response: number) => resolve({ response }), reject };
            dialogs.push(entry);
            opts.signal?.addEventListener('abort', () => {
              entry.aborted = true;
              reject(new Error('aborted'));
            });
          }),
      },
    },
    '../preload/api.ts': { CHANNELS: new Proxy({}, { get: (_t, key) => key }), STALE_PROJECT: 'stale' },
  };
  const source = readFileSync(join(__dirname, '../../src/main/ipc.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const real = createRequire(__filename);
  const mod = { exports: {} as { guardWindowClose(win: unknown): void } };
  new Function('require', 'module', 'exports', code)((name: string, ..._rest: unknown[]) => fakes[name] ?? (name.startsWith('node:') ? real(name) : {}), mod, mod.exports);

  const handlers: Record<string, CloseHandler[]> = {};
  const sent: number[] = [];
  let destroyed = false;
  const webContents = { id: 'own', send: (_channel: string, attempt: number) => void sent.push(attempt) };
  const win = {
    webContents,
    isDestroyed: () => destroyed,
    on: (event: string, fn: CloseHandler) => void (handlers[event] = [...(handlers[event] ?? []), fn]),
    once: (event: string, fn: CloseHandler) => void (handlers[event] = [...(handlers[event] ?? []), fn]),
    /** BrowserWindow.close(): 'close' 처리기가 막지 않으면 파괴되고 'closed'가 난다 */
    close() {
      let prevented = false;
      for (const fn of handlers['close'] ?? []) fn({ preventDefault: () => void (prevented = true) });
      if (!prevented) {
        destroyed = true;
        for (const fn of handlers['closed'] ?? []) fn({ preventDefault() {} });
      }
    },
  };
  mod.exports.guardWindowClose(win);
  const reply = (proceed: boolean, attempt: number, from: unknown = webContents) => {
    for (const fn of listeners.get('replyClose') ?? []) fn({ sender: from }, proceed, attempt);
  };
  return { win, sent, dialogs, reply, destroyed: () => destroyed, replyListeners: () => (listeners.get('replyClose') ?? []).length };
}
const flush = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());

test('정상: 저장 완료(true) 응답이 있으면 추가 확인 없이 닫히고, 리스너를 정리한다', () => {
  const t = setup();
  t.win.close();
  assert.deepEqual(t.sent, [1]);
  assert.equal(t.destroyed(), false, '답을 받기 전에는 닫지 않는다');
  t.reply(true, 1);
  assert.equal(t.destroyed(), true);
  assert.equal(t.dialogs.length, 0);
  assert.equal(t.replyListeners(), 0, '창이 닫히면 reply 리스너를 정리한다');
});

test('false 응답(사용자 취소)이면 창을 두고, 다시 닫으면 새 시도 번호로 묻는다', () => {
  const t = setup();
  t.win.close();
  t.reply(false, 1);
  assert.equal(t.destroyed(), false);
  t.win.close();
  assert.deepEqual(t.sent, [1, 2]);
  t.reply(true, 2);
  assert.equal(t.destroyed(), true);
});

test('10초가 지나도 답이 없으면 닫지 않고 native 안내를 한 번 띄운다. 중복 닫기는 시도·안내·타이머를 늘리지 않는다', async () => {
  const t = setup();
  t.win.close();
  t.win.close(); // 중복 닫기
  assert.deepEqual(t.sent, [1], '중복 닫기가 새 시도를 만들지 않는다');
  mock.timers.tick(10_000);
  await flush();
  assert.equal(t.destroyed(), false, 'timeout만으로 닫지 않는다');
  assert.equal(t.dialogs.length, 1);
  assert.deepEqual(t.dialogs[0]!.buttons, ['계속 기다리기', '닫기 취소']);
  t.win.close();
  mock.timers.tick(30_000);
  await flush();
  assert.equal(t.dialogs.length, 1, '안내가 떠 있는 동안 안내를 중복해 띄우지 않는다');
  assert.equal(t.destroyed(), false);
});

test('계속 기다리기: 같은 시도를 이어 가고 다시 시간이 지나면 다시 묻는다. 늦게 온 저장 완료 응답이면 닫히고 안내는 닫힌다', async () => {
  const t = setup();
  t.win.close();
  mock.timers.tick(10_000);
  await flush();
  t.dialogs[0]!.resolve(0);
  await flush();
  assert.equal(t.destroyed(), false);
  mock.timers.tick(10_000);
  await flush();
  assert.equal(t.dialogs.length, 2, '다시 시간이 지나면 다시 묻는다');
  t.reply(true, 1); // 늦게 온 저장 완료
  assert.equal(t.destroyed(), true);
  assert.equal(t.dialogs[1]!.aborted, true, '열려 있던 안내를 닫는다');
});

test('닫기 취소: 시도가 끝나고, 늦은 응답과 옛 타이머는 이후 시도를 승인하지 못한다', async () => {
  const t = setup();
  t.win.close();
  mock.timers.tick(10_000);
  await flush();
  t.dialogs[0]!.resolve(1); // 닫기 취소
  await flush();
  t.reply(true, 1); // 취소한 시도의 늦은 저장 완료
  assert.equal(t.destroyed(), false, '취소된 시도는 늦은 저장 완료로도 닫히지 않는다');
  mock.timers.tick(60_000);
  await flush();
  assert.equal(t.destroyed(), false, '옛 타이머가 닫지 않는다');
  assert.equal(t.dialogs.length, 1, '취소된 시도는 더 묻지 않는다');
  // 다시 시도: 새 시도 번호. 옛 시도(1)의 늦은 응답으로는 승인되지 않고, 새 시도의 응답으로만 닫힌다
  t.win.close();
  assert.deepEqual(t.sent, [1, 2]);
  t.reply(true, 1);
  assert.equal(t.destroyed(), false, '옛 시도 번호의 응답은 새 시도를 승인하지 못한다');
  t.reply(true, 2);
  assert.equal(t.destroyed(), true);
});

test('다른 창의 응답은 무시하고, renderer가 취소(false)하면 열려 있던 안내를 닫으며, 안내를 띄우지 못하면 닫지 않고 시도를 끝낸다', async () => {
  const t = setup();
  t.win.close();
  t.reply(true, 1, { id: 'other-window' });
  assert.equal(t.destroyed(), false, '다른 창의 응답은 승인이 아니다');
  mock.timers.tick(10_000);
  await flush();
  t.reply(false, 1); // 안내가 떠 있는 동안 renderer가 닫기를 취소했다
  assert.equal(t.dialogs[0]!.aborted, true);
  await flush();
  assert.equal(t.destroyed(), false);

  const u = setup();
  u.win.close();
  mock.timers.tick(10_000);
  await flush();
  u.dialogs[0]!.reject(new Error('dialog failed'));
  await flush();
  assert.equal(u.destroyed(), false, '안내 실패는 닫는 근거가 아니다');
  mock.timers.tick(60_000);
  await flush();
  assert.equal(u.destroyed(), false);
  u.win.close();
  assert.deepEqual(u.sent, [1, 2], '안내가 실패해도 다시 닫기를 시도할 수 있다');
});
