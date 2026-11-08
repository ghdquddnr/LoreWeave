// 창 닫기에서 저장 응답 대기 안내(10초 timeout)와 미저장 폐기 확인이 한 닫기 시도에 동시에 활성화되지 않는지 본다.
// 폐기 확인은 main이 소유한 native 확인창이다 (renderer는 저장 실패 사실만 알리고 묻지 않는다): 그래서 renderer가 알림 뒤 응답하지 않아도 확인창의 존재·종료·취소·재시도를 main이 안다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. main의 chapter:write를 장벽(hold) + 실패 대역으로 감싸고, 지연 정확히 10000ms인 main setTimeout만 300ms로 앞당겨 발화 수를 센다.
// native 안내(dialog.showMessageBox)는 선택을 테스트가 정하는 대역이다 (동시에 열린 수·거둠 기록). 실제 OS 대화상자 중첩·수동 GUI·실제 IME 확인이 아니다. 유료·외부 호출 없음. 본문은 출력하지 않고 동등 여부(boolean)만 판정한다.
// 관측 범위: "겹치지 않음"은 대역이 센 동시 활성 안내 수(최대)와 실제 창·안내 수·타이머 발화 수로 판정하며, 앞당긴 타이머 주기의 세 배(900ms) 구간에 한한다.
// 무응답 renderer(알림 뒤 응답 없음)·확인창 실패 같은 경계는 tests/core/close-guard.test.ts(fake main)가 맡는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';
const CONFIRM = '저장되지 않은 변경이 있습니다. 그래도 계속할까요? (변경은 사라집니다)';

interface Snapshot {
  armed: number;
  fired: number;
  writes: number;
  held: boolean;
  active: number;
  maxActive: number;
  dialogs: { kind: 'wait' | 'discard'; message: string; aborted: boolean }[];
}
const snap = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { snapshot(): Snapshot }).snapshot());
const arm = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { arm(): void }).arm());
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { releaseWrite(): void }).releaseWrite());
const answer = (app: ElectronApplication, n: number, response: number) => app.evaluate((_e, a) => (globalThis as unknown as { answer(n: number, r: number): void }).answer(a.n, a.response), { n, response });
const requestClose = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
const windows = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
async function until(app: ElectronApplication, what: string, ok: (s: Snapshot) => boolean) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const s = await snap(app);
    if (ok(s)) return s;
    if (Date.now() > deadline) throw new Error(`장벽 대기 시간 초과: ${what} ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// 문자열로 넘긴다: 테스트 변환기가 함수에 붙이는 이름 도우미(__name)가 main 프로세스에는 없다
const INSTALL = `
  const g = globalThis;
  const h = { armed: 0, fired: 0, writes: 0, held: false, hold: false, active: 0, maxActive: 0, dialogs: [], resolvers: [], release: null };
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, delay, ...rest) => {
    if (delay !== 10000) return real(fn, delay, ...rest);
    h.armed++;
    return real(() => { h.fired++; fn(); }, 300);
  };
  dialog.showMessageBox = (_win, opts) =>
    new Promise((resolve, reject) => {
      const kind = opts.buttons && opts.buttons.includes('저장하지 않고 닫기') ? 'discard' : 'wait';
      const entry = { kind, message: opts.message, aborted: false };
      h.dialogs.push(entry);
      h.active++;
      h.maxActive = Math.max(h.maxActive, h.active);
      h.resolvers.push((response) => { if (!entry.aborted) { h.active--; resolve({ response, checkboxChecked: false }); } });
      if (opts.signal) opts.signal.addEventListener('abort', () => { if (!entry.aborted) { entry.aborted = true; h.active--; reject(new Error('aborted')); } });
    });
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
  g.snapshot = () => ({ armed: h.armed, fired: h.fired, writes: h.writes, held: h.held, active: h.active, maxActive: h.maxActive, dialogs: h.dialogs.map((d) => ({ kind: d.kind, message: d.message, aborted: d.aborted })) });
  g.arm = () => { h.hold = true; };
  g.releaseWrite = () => { if (h.release) h.release(); };
  g.answer = (n, response) => h.resolvers[n](response);
`;

async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const original = await readFile(path);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  await app.evaluate(({ ipcMain, dialog }, code) => new Function('ipcMain', 'dialog', code)(ipcMain, dialog), INSTALL);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
  await page.locator('.ProseMirror').getByText('Alpha text').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' A');
  return { app, page, path, original };
}
const textKept = (page: Page) => page.locator('.ProseMirror').getByText('Alpha text A', { exact: true }).count();

test('저장 대기 안내가 먼저 뜬 뒤 저장이 실패하면 대기 안내를 거두고 main의 폐기 확인 하나로 직렬화하며, 확인 중 timeout이 지나도 겹치지 않고, 거절하면 편집기로 돌아오고 명시 승인 때만 닫힌다', { timeout: 120_000 }, async () => {
  const { app, page, path, original } = await start('close-confirm-a');
  try {
    // 1) 저장 응답을 붙잡은 채 닫기: timeout이 지나 대기 안내가 먼저 뜬다
    await arm(app);
    await requestClose(app);
    await until(app, '저장 요청이 붙잡히지 않았다', (s) => s.held);
    const first = await until(app, '대기 안내가 뜨지 않았다', (s) => s.fired >= 1 && s.dialogs.length === 1);
    assert.equal(first.dialogs[0]!.kind, 'wait');
    assert.equal(first.active, 1);

    // 2) 저장이 실패하면 renderer는 묻지 않고 알린다: 대기 안내는 거두어지고 main의 폐기 확인이 하나 뜬다
    await release(app);
    const asked = await until(app, '폐기 확인이 뜨지 않았다', (s) => s.dialogs.length === 2);
    assert.equal(asked.dialogs[0]!.aborted, true, '대기 안내를 거두었다');
    assert.equal(asked.dialogs[1]!.kind, 'discard');
    assert.equal(asked.dialogs[1]!.message, CONFIRM);
    assert.equal(asked.active, 1, '동시에 활성인 안내는 하나다');

    // 3) 확인이 떠 있는 동안에는 대기 타이머를 돌리지 않고(확인창은 main이 소유해 응답 여부를 main이 안다) 안내를 겹쳐 띄우지 않는다. 창·글자·바이트는 그대로다
    await page.waitForTimeout(900); // 앞당긴 타이머 주기(300ms)의 세 배: 이 대기 자체가 근거는 아니고 아래 발화·안내 수로 판정한다
    const later = await snap(app);
    assert.equal(later.fired, asked.fired, '확인 중에는 대기 타이머가 발화하지 않는다 (관측 범위 안)');
    assert.equal(later.dialogs.length, 2, '확인 중에는 새 안내가 없다 (관측 범위 안)');
    assert.equal(later.maxActive, 1, '동시에 활성인 안내는 최대 하나였다');
    assert.equal(await windows(app), 1, '창은 닫히지 않았다');
    assert.equal(await textKept(page), 1, '미저장 글자 보존');
    assert.ok(Buffer.compare(await readFile(path), original) === 0, '원고 원본 바이트 불변');

    // 4) 폐기를 거절([닫지 않기])하면 편집기로 돌아온다. 끝난 시도의 타이머는 더 발화하지 않는다
    await answer(app, 1, 1);
    await settled(page);
    const atRefuse = await snap(app);
    await page.waitForTimeout(900); // 앞당긴 타이머 주기(300ms)의 세 배: 이 대기 자체가 근거는 아니고 아래 발화·안내 수로 판정한다
    const idle = await snap(app);
    assert.equal(idle.fired, atRefuse.fired, '거절로 끝난 시도의 타이머는 더 발화하지 않는다');
    assert.equal(idle.dialogs.length, 2, '끝난 시도는 안내를 다시 띄우지 않는다');
    assert.equal(await windows(app), 1, '거절하면 창이 남는다');
    assert.equal(await textKept(page), 1);
    assert.equal(await page.locator('.ProseMirror').getAttribute('contenteditable'), 'true', '편집기로 돌아왔다');
    assert.ok(Buffer.compare(await readFile(path), original) === 0);

    // 5) 다시 닫기: 새 시도·새 확인. 옛 확인의 늦은 승인은 새 시도를 닫지 못하고, 이번 확인에서 명시 승인해야 닫힌다
    const closed = new Promise<void>((resolve) => app.once('close', () => resolve()));
    await requestClose(app);
    await until(app, '두 번째 폐기 확인이 뜨지 않았다', (s) => s.dialogs.length === 3 && s.dialogs[2]!.kind === 'discard');
    await answer(app, 1, 0).catch(() => undefined); // 이미 답한 옛 확인창에 늦게 승인해도 효과가 없다 (끝난 시도의 늦은 승인 격리는 core가 본다)
    await settled(page);
    assert.equal(await windows(app), 1, '옛 승인으로 새 시도가 닫히지 않는다');
    await answer(app, 2, 0); // 현재 시도의 명시적 폐기 승인
    await closed;
    assert.ok(Buffer.compare(await readFile(path), original) === 0, '명시 폐기 뒤에도 원고 파일은 저장하지 않은 그대로다');
  } finally {
    await release(app).catch(() => undefined);
    await closeWindow(app);
  }
});

test('폐기 확인이 먼저 떠 있으면 timeout이 여러 번 지나도 대기 안내를 띄우지 않고, 거절하면 편집기로 돌아온다', { timeout: 120_000 }, async () => {
  const { app, page, path, original } = await start('close-confirm-b');
  try {
    await requestClose(app); // 저장은 곧바로 실패한다 (장벽 없음)
    const asked = await until(app, '폐기 확인이 뜨지 않았다', (s) => s.dialogs.length === 1);
    assert.equal(asked.dialogs[0]!.kind, 'discard');
    await page.waitForTimeout(900); // 앞당긴 타이머 주기(300ms)의 세 배: 이 대기 자체가 근거는 아니고 아래 발화·안내 수로 판정한다
    const later = await snap(app);
    assert.equal(later.fired, asked.fired, '확인 중에는 대기 타이머가 발화하지 않는다 (관측 범위 안)');
    assert.equal(later.dialogs.length, 1, '확인이 떠 있는 동안 대기 안내가 뜨지 않았다 (관측 범위 안)');
    assert.equal(later.maxActive, 1);
    assert.equal(await windows(app), 1);
    assert.equal(await textKept(page), 1, '미저장 글자 보존');
    await answer(app, 0, 1);
    await settled(page);
    assert.equal(await windows(app), 1, '거절하면 창이 남는다');
    assert.equal(await textKept(page), 1);
    assert.ok(Buffer.compare(await readFile(path), original) === 0, '원고 원본 바이트 불변');
  } finally {
    await closeWindow(app);
  }
});
