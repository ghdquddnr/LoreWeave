// E2E 정리의 무기한 대기 방지.
//  (1) 실제 합성 Electron: 충돌로 창이 닫히지 않아도 closeWindow는 한도 안에 끝나고, 이 테스트가 띄운 앱 pid만 끝내며, 기록한다. 정상 닫기는 저장 뒤 닫히고 기록이 없다.
//  (2) 실패 경계(결정적 대역, 실프로세스 종료 없음): 종료 명령 실패 / exit 알림 없음 / 남은 창닫기 요청 영구 대기 / 이미 닫힌 앱의 연결 닫기 영구 대기에서도 각각 한도 안에 끝나고, 종료 확인 여부를 구별해 기록한다.
// 합성 원고·격리 userData, 외부 호출 없음. 한도 초과 기록은 파일 끝에서 실패로 보고되므로, 의도한 기록은 takeCleanupFailures로 가져가 확인한다.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication } from 'playwright';
import { closeWindow, killApp, launch, stubFolderDialog, takeCleanupFailures, tempDir, terminateApp } from './launch.ts';

const alive = (pid: number | undefined) => {
  try {
    process.kill(pid!, 0);
    return true;
  } catch {
    return false;
  }
};
const SMALL = { closeMs: 20, killMs: 20, exitMs: 20, connMs: 20, evalMs: 20 };
const NEVER = new Promise<never>(() => {});

interface FakeSetup {
  /** kill 명령이 하는 일 (emitExit: 자식의 exit 이벤트를 낸다) */
  kill?: (emitExit: () => void) => void;
  pidAlive?: boolean;
  evaluatePending?: boolean;
  closePending?: boolean;
  /** 이미 닫힌 앱: process()가 던진다 */
  closed?: boolean;
}
/** 존재할 수 없는 pid의 앱 대역. 실제 프로세스를 만들지도 끝내지도 않는다 */
function fakeApp(setup: FakeSetup) {
  const emitter = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const touched = { stdioDestroyed: 0, unref: false, handleKill: 0 };
  Object.assign(child, {
    pid: 2_147_483_000,
    exitCode: null,
    signalCode: null,
    kill: () => void (touched.handleKill += 1),
    unref: () => void (touched.unref = true),
    stdin: { destroy: () => void (touched.stdioDestroyed += 1) },
    stdout: { destroy: () => void (touched.stdioDestroyed += 1) },
    stderr: { destroy: () => void (touched.stdioDestroyed += 1) },
  });
  const app = {
    process: () => {
      if (setup.closed) throw new Error('connection disposed');
      return child;
    },
    once: (e: string, f: () => void) => emitter.once(e, f),
    off: (e: string, f: () => void) => emitter.off(e, f),
    evaluate: () => (setup.evaluatePending ? NEVER : Promise.resolve()),
    close: () => (setup.closePending ? NEVER : Promise.resolve()),
  } as unknown as ElectronApplication;
  const opts = {
    ...SMALL,
    kill: () => setup.kill?.(() => child.emit('exit')),
    isAlive: () => setup.pidAlive ?? false,
  };
  return { app, opts, touched, listeners: () => emitter.listenerCount('close') + child.listenerCount('exit') };
}
const timed = async (f: () => Promise<unknown>) => {
  const t = Date.now();
  await f();
  return Date.now() - t;
};
const boom = () => {
  throw new Error('taskkill: 액세스가 거부되었습니다');
};

test('실패 경계 ①: 종료 명령이 실패하고 exit 알림도 없고 pid가 살아 있으면 한도 안에 끝나며 종료 미확인으로 기록하고 자식이 runner를 붙잡지 않게 한다', async () => {
  takeCleanupFailures();
  const f = fakeApp({ kill: boom, pidAlive: true });
  const ms = await timed(() => closeWindow(f.app, f.opts));
  assert.ok(ms < 1000, `${ms}ms`);
  const [failure, ...rest] = takeCleanupFailures();
  assert.equal(rest.length, 0);
  assert.match(failure!, /종료 명령 실패: taskkill/);
  assert.match(failure!, /종료를 확인하지 못했다/);
  assert.match(failure!, /종료 확인=아니오/);
  assert.equal(f.touched.handleKill, 1, '이 앱의 자식 핸들로 한 번 더 시도');
  assert.equal(f.touched.stdioDestroyed, 3);
  assert.equal(f.touched.unref, true);
  assert.equal(f.listeners(), 0, 'listener를 남기지 않는다');
  const g = fakeApp({ kill: boom, pidAlive: true });
  await assert.rejects(() => killApp(g.app, g.opts), /종료를 확인하지 못했다/);
});

test('실패 경계 ②: 종료 명령은 실패했지만 pid가 사라졌으면 종료 확인=예로 구별하고, exit이 와도 남은 창닫기 요청(영구 대기)을 기다리지 않는다', async () => {
  takeCleanupFailures();
  const a = fakeApp({ kill: boom, pidAlive: false, evaluatePending: true });
  assert.ok((await timed(() => closeWindow(a.app, a.opts))) < 1000);
  const [m1] = takeCleanupFailures();
  assert.match(m1!, /종료 명령 실패/);
  assert.match(m1!, /종료 확인=예/);
  assert.match(m1!, /창닫기 요청 한도 초과/);
  const b = fakeApp({ kill: (emitExit) => emitExit(), pidAlive: true, evaluatePending: true });
  assert.ok((await timed(() => closeWindow(b.app, b.opts))) < 1000);
  const [m2] = takeCleanupFailures();
  assert.doesNotMatch(m2!, /종료 명령 실패/);
  assert.match(m2!, /종료 확인=예/);
  assert.equal(b.touched.unref, false, '종료를 확인했으면 자식을 건드리지 않는다');
  assert.equal(b.listeners(), 0);
});

test('실패 경계 ③: 이미 닫힌 앱의 연결 닫기가 영구 대기여도 한도 안에 끝나고 연결 미종료로 기록하며, 중복 정리는 무동작이다', async () => {
  takeCleanupFailures();
  const f = fakeApp({ closed: true, closePending: true });
  assert.ok((await timed(() => closeWindow(f.app, f.opts))) < 200, '닫힌 앱의 closeWindow는 아무것도 기다리지 않는다');
  assert.deepEqual(takeCleanupFailures(), []);
  const ms = await timed(async () => {
    const r = await terminateApp(f.app, f.opts);
    assert.equal(r.connectionClosed, false);
    assert.equal(r.exited, true, '프로세스가 없으면 종료할 것도 없다');
    assert.match(r.notes.join(';'), /연결 닫기 한도 초과/);
  });
  assert.ok(ms < 1000);
});

test('finally 안의 closeWindow는 던지지 않아 원래 오류를 보존하고, 정리 실패는 따로 기록된다', async () => {
  takeCleanupFailures();
  const f = fakeApp({ kill: boom, pidAlive: true, evaluatePending: true, closePending: true });
  await assert.rejects(async () => {
    try {
      throw new Error('ORIGINAL_ASSERTION');
    } finally {
      await closeWindow(f.app, f.opts);
    }
  }, /ORIGINAL_ASSERTION/);
  assert.equal(takeCleanupFailures().length, 1);
});

test('실패 경계 ④ (독립 subprocess, 외부 제한시간): 빠른 evaluate 거절·동기 throw·close 거절은 처리되지 않은 rejection 없이 원래 오류를 보존하고, 정리 실패는 따로 기록되며, 연결 거절을 성공으로 쓰지 않는다', { timeout: 60_000 }, () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'cleanup-rejections.fixture.ts')], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.error, undefined, `외부 제한시간 안에 끝난다: ${run.error}`);
  assert.equal(run.status, 0, `처리되지 않은 rejection 없이 종료한다: ${run.stderr.slice(0, 600)}`);
  assert.doesNotMatch(run.stderr, /Unhandled|triggerUncaught|node:internal/);
  const r = JSON.parse(run.stdout.split(String.fromCharCode(10)).find((l) => l.startsWith('{'))!) as Record<string, { original: boolean; failures: string[] }> & { closedCloseReject: { connectionClosed: boolean; exited: boolean; notes: string[]; killAppThrew: string } };
  for (const name of ['fastEvaluateReject', 'evaluateThrow', 'onceThrow', 'closeReject', 'closeThrow'] as const) {
    assert.equal(r[name]!.original, true, `${name}: 원래 오류 보존`);
    assert.equal(r[name]!.failures.length, 1, `${name}: 정리 실패는 따로 한 건 기록`);
  }
  assert.match(r.fastEvaluateReject!.failures[0]!, /창닫기 요청 거절\(REVIEW_EVALUATE_REJECT\)/);
  assert.match(r.fastEvaluateReject!.failures[0]!, /연결 닫기=예/);
  assert.match(r.onceThrow!.failures[0]!, /닫힘 알림을 걸지 못했다/);
  assert.match(r.closeReject!.failures[0]!, /Playwright 연결 닫기 거절\(REVIEW_CLOSE_REJECT\)/);
  assert.match(r.closeReject!.failures[0]!, /연결 닫기=아니오/, '연결 닫기 거절을 성공으로 쓰지 않는다');
  assert.match(r.closeThrow!.failures[0]!, /연결 닫기=아니오/);
  assert.equal(r.closedCloseReject.connectionClosed, false);
  assert.match(r.closedCloseReject.notes.join(';'), /거절\(REVIEW_CLOSE_REJECT\)/);
  assert.match(r.closedCloseReject.killAppThrew, /연결 닫기=아니오/, 'killApp도 연결 정리 실패를 조용히 성공으로 쓰지 않는다');
});

async function open(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), '# A\n\noriginal\n');
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  return { dir, app, page };
}

test('충돌로 창이 닫히지 않으면 한도 안에 이 앱만 끝내고 기록하며, 외부 원고 바이트는 그대로이고, 중복 정리는 안전하다', { timeout: 60_000 }, async () => {
  const { dir, app, page } = await open('cleanup-conflict');
  const pid = app.process().pid;
  try {
    takeCleanupFailures();
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.locator('.ProseMirror').waitFor();
    await page.locator('.ProseMirror').click();
    await page.keyboard.type('LOCAL_EDIT');
    const external = '# A\n\nEXTERNAL must survive\n';
    await writeFile(join(dir, 'chapters', '001.md'), external);
    await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).waitFor({ timeout: 15_000 });
    const ms = await timed(() => closeWindow(app, { closeMs: 3_000 }));
    assert.ok(ms < 12_000, `한도 안에 끝난다: ${ms}ms`);
    assert.equal(alive(pid), false, '이 테스트의 앱 프로세스가 끝났다');
    const failures = takeCleanupFailures();
    assert.equal(failures.length, 1, '정리 한도 초과가 기록된다 (삼키지 않는다)');
    assert.match(failures[0]!, new RegExp(`pid=${pid}`));
    assert.match(failures[0]!, /종료 확인=예/);
    assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), external, '충돌을 남긴 채 닫아도 바깥 변경은 그대로');
    await closeWindow(app); // 이미 닫힌 앱: 무동작
    await killApp(app);
    assert.deepEqual(takeCleanupFailures(), []);
  } finally {
    // 도중 실패해도 소유 앱은 정리한다 (이미 끝났으면 무동작). 이 정리의 한도 초과는 파일 끝에서 실패로 보고된다
    await closeWindow(app, { closeMs: 3_000 });
  }
});

test('정상 닫기는 저장한 뒤 닫히고 정리 실패로 기록되지 않는다', { timeout: 60_000 }, async () => {
  const { dir, app, page } = await open('cleanup-normal');
  try {
    takeCleanupFailures();
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.locator('.ProseMirror').waitFor();
    await page.locator('.ProseMirror').click();
    await page.keyboard.type('SAVED_ON_CLOSE');
    await closeWindow(app);
    assert.deepEqual(takeCleanupFailures(), []);
    assert.match(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), /SAVED_ON_CLOSE/, '정상 닫기는 저장을 마친 뒤 닫힌다');
    await closeWindow(app); // 중복 정리
    assert.deepEqual(takeCleanupFailures(), []);
  } finally {
    await closeWindow(app);
  }
});
