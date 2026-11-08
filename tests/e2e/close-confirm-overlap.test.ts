// 창 닫기에서 저장 응답 대기 안내(main, 10초 timeout)와 미저장 폐기 확인(renderer window.confirm)이 한 닫기 시도에 동시에 활성화되지 않는지 본다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. main의 chapter:write를 장벽(hold) + 실패 대역으로 감싸고, 지연 정확히 10000ms인 main setTimeout만 300ms로 앞당겨 발화 수를 센다.
// main의 native 안내(dialog.showMessageBox)는 선택을 정하는 대역(동시에 열린 수·거둠 기록)이고, renderer의 window.confirm은 Playwright dialog 이벤트로 붙잡았다가 테스트가 수락/거절한다.
// 실제 OS 대화상자 중첩·수동 GUI·실제 IME 확인이 아니다. 유료·외부 호출 없음. 본문은 출력하지 않고 동등 여부(boolean)만 판정한다.
// 관측 범위: "겹치지 않음"은 대역이 센 동시 활성 안내 수(최대)와 실제 창·dialog 이벤트 수로 판정하며, 타이머가 확인 중에 여러 번 더 발화하는 것까지 본 구간에 한한다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Dialog } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';
const CONFIRM = '저장되지 않은 변경이 있습니다. 그래도 계속할까요? (변경은 사라집니다)';

interface Hooks {
  armed: number;
  fired: number;
  writes: number;
  held: boolean;
  hold: boolean;
  release?: () => void;
  failWrites: boolean;
  active: number;
  maxActive: number;
  nativeDialogs: { buttons: string[]; aborted: boolean }[];
}
const hooks = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { h: Hooks }).h);
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as { h: Hooks }).h.hold = true));
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { h: Hooks }).h.release?.());
const requestClose = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
const windows = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
async function until(app: ElectronApplication, what: string, ok: (h: Hooks) => boolean) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const h = await hooks(app);
    if (ok(h)) return h;
    if (Date.now() > deadline) throw new Error(`장벽 대기 시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const INSTALL = `
  const h = { armed: 0, fired: 0, writes: 0, held: false, hold: false, failWrites: true, active: 0, maxActive: 0, nativeDialogs: [] };
  globalThis.h = h;
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, delay, ...rest) => {
    if (delay !== 10000) return real(fn, delay, ...rest);
    h.armed++;
    return real(() => { h.fired++; fn(); }, 300);
  };
  // renderer의 window.confirm도 Electron 안에서는 이 함수를 거친다: 그것은 원래 함수에 넘겨 Playwright dialog 이벤트가 맡게 하고 세지 않는다. main의 저장 대기 안내('계속 기다리기')만 센다
  const originalShow = dialog.showMessageBox.bind(dialog);
  dialog.showMessageBox = (win, opts) => {
    if (!opts.buttons || !opts.buttons.includes('계속 기다리기')) return originalShow(win, opts);
    return new Promise((resolve, reject) => {
      const entry = { buttons: opts.buttons, aborted: false };
      h.nativeDialogs.push(entry);
      h.active++;
      h.maxActive = Math.max(h.maxActive, h.active);
      if (opts.signal) opts.signal.addEventListener('abort', () => { entry.aborted = true; h.active--; reject(new Error('aborted')); });
    });
  };
  const handlers = ipcMain._invokeHandlers;
  handlers.set('chapter:write', async () => {
    h.writes++;
    if (h.hold) {
      h.hold = false;
      h.held = true;
      await new Promise((resolve) => (h.release = resolve));
      h.held = false;
    }
    throw new Error('EACCES: permission denied (synthetic)');
  });
`;

async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const original = await readFile(path);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  // Playwright dialog: 붙잡았다가 테스트가 답한다 (정리 단계에서는 수락한다)
  const confirms: Dialog[] = [];
  let cleanup = false;
  page.on('dialog', (d) => {
    if (cleanup) return void d.accept();
    confirms.push(d);
  });
  // 문자열로 넘긴다: 테스트 변환기가 함수에 붙이는 이름 도우미(__name)가 main 프로세스에는 없다
  await app.evaluate(({ ipcMain, dialog }, code) => new Function('ipcMain', 'dialog', code)(ipcMain, dialog), INSTALL);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
  await page.locator('.ProseMirror').getByText('Alpha text').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' A');
  return { app, page, path, original, confirms, startCleanup: () => void (cleanup = true) };
}

async function untilConfirms(page: Page, confirms: Dialog[], n: number) {
  for (let i = 0; i < 600 && confirms.length < n; i++) await page.waitForTimeout(25);
  assert.equal(confirms.length, n, `폐기 확인이 ${n}번째로 뜨지 않았다`);
}

test('저장 대기 안내가 먼저 뜬 뒤 저장이 실패해 폐기 확인이 뜨면 안내는 거두고, 확인이 떠 있는 동안 timeout이 지나도 겹치지 않으며, 거절하면 편집기로 돌아오고 명시 수락 때만 닫힌다', { timeout: 120_000 }, async () => {
  const { app, page, path, original, confirms, startCleanup } = await start('close-confirm-a');
  try {
    // 1) 저장 응답을 붙잡은 채 닫기: timeout이 지나 native 대기 안내가 먼저 뜬다
    await arm(app);
    await requestClose(app);
    await until(app, '저장 요청이 붙잡히지 않았다', (h) => h.held);
    const first = await until(app, '대기 안내가 뜨지 않았다', (h) => h.fired >= 1 && h.nativeDialogs.length === 1);
    assert.equal(first.active, 1);

    // 2) 저장이 실패하면 renderer가 폐기 확인을 묻는다: 대기 안내는 거두어지고 활성 확인은 최대 하나다
    await release(app);
    await untilConfirms(page, confirms, 1);
    assert.equal(confirms[0]!.message(), CONFIRM);
    const afterAsk = await until(app, '대기 안내가 거두어지지 않았다', (h) => h.nativeDialogs[0]!.aborted);
    assert.equal(afterAsk.active, 0, 'native 안내와 폐기 확인이 동시에 활성이지 않다');
    // 3) 확인이 떠 있는 동안 10초 타이머가 더 발화해도 새 대기 안내를 겹쳐 띄우지 않는다
    const firedAt = afterAsk.fired;
    const later = await until(app, '확인 중 타이머가 더 발화하지 않았다', (h) => h.fired >= firedAt + 2);
    assert.equal(later.nativeDialogs.length, 1, '확인 중에는 새 대기 안내가 없다 (관측 범위 안)');
    assert.equal(later.maxActive, 1, '동시에 활성인 native 안내는 최대 하나였다');
    assert.equal(confirms.length, 1, '폐기 확인도 하나뿐이다');
    assert.equal(await windows(app), 1, '창은 닫히지 않았다');
    // (확인이 떠 있는 동안에는 renderer가 멈춰 있어 화면을 읽을 수 없다: 글자 보존은 확인을 닫은 뒤 본다)
    assert.ok(Buffer.compare(await readFile(path), original) === 0, '원고 원본 바이트 불변');

    // 4) 폐기를 거절하면 편집기로 돌아온다. 그 시도의 늦은 응답·옛 타이머가 닫지 않는다
    await confirms[0]!.dismiss();
    await settled(page);
    const firedAtDismiss = (await hooks(app)).fired;
    await page.waitForTimeout(900); // 앞당긴 타이머 주기(300ms)의 세 배: 끝난 시도의 타이머가 더 발화하지 않는지 본다 (이 대기 자체가 성공 근거는 아니고, 아래 발화 수·안내 수로 판정한다)
    const idle = await hooks(app);
    assert.equal(idle.fired, firedAtDismiss, '거절로 끝난 시도의 타이머는 더 발화하지 않는다');
    assert.equal(await windows(app), 1, '거절하면 창이 남는다');
    assert.equal(idle.nativeDialogs.length, 1, '끝난 시도는 안내를 다시 띄우지 않는다');
    assert.equal(await page.locator('.ProseMirror').getByText('Alpha text A', { exact: true }).count(), 1);
    assert.ok(Buffer.compare(await readFile(path), original) === 0);

    // 5) 다시 닫기: 새 시도. 이번에는 명시적으로 폐기를 수락했을 때만 닫힌다
    const closed = new Promise<void>((resolve) => app.once('close', () => resolve()));
    await requestClose(app);
    await untilConfirms(page, confirms, 2);
    assert.equal(await windows(app), 1, '수락 전에는 닫히지 않는다');
    startCleanup();
    await confirms[1]!.accept();
    await closed;
    assert.ok(Buffer.compare(await readFile(path), original) === 0, '명시 폐기 뒤에도 원고 파일은 그대로다 (저장하지 않았다)');
  } finally {
    startCleanup();
    await release(app).catch(() => undefined);
    await closeWindow(app);
  }
});

test('폐기 확인이 먼저 떠 있으면 timeout이 여러 번 지나도 대기 안내를 띄우지 않고, 거절하면 편집기로 돌아온다', { timeout: 120_000 }, async () => {
  const { app, page, path, original, confirms, startCleanup } = await start('close-confirm-b');
  try {
    await requestClose(app); // 저장은 곧바로 실패한다 (장벽 없음)
    await untilConfirms(page, confirms, 1);
    const h0 = await hooks(app);
    const h1 = await until(app, '확인 중 타이머가 발화하지 않았다', (h) => h.fired >= h0.fired + 2);
    assert.equal(h1.nativeDialogs.length, 0, '확인이 떠 있는 동안 대기 안내가 뜨지 않았다 (관측 범위 안)');
    assert.equal(h1.maxActive, 0);
    assert.equal(await windows(app), 1);
    await confirms[0]!.dismiss();
    await settled(page);
    assert.equal(await page.locator('.ProseMirror').getByText('Alpha text A', { exact: true }).count(), 1, '미저장 글자 보존');
    assert.equal(await windows(app), 1, '거절하면 창이 남는다');
    assert.ok(Buffer.compare(await readFile(path), original) === 0, '원고 원본 바이트 불변');
  } finally {
    startCleanup();
    await closeWindow(app);
  }
});
