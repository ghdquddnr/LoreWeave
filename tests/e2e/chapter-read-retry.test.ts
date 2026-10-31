// 일시적인 화 읽기 실패에서 같은 화로 복구한다: 읽기 오류 화면에 [다시 시도]가 있고, 같은 화를 다시 읽어 정상 본문으로 돌아온다.
// 실패하는 동안 빈 본문 편집·저장은 없고 원고 바이트는 그대로다. 재시도 중 다른 화로 옮기면 늦은 성공/실패가 새 화면을 오염하지 않는다.
// 합성 원고·격리 userData. main의 chapter:read를 장벽/실패 대역으로 감싼다 (002.md만). 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const A = `${envelope('a', 'A_CH')}A 본문\r\n`;
const B = `${envelope('b', 'B_CH')}B 본문 줄\r\n`;

interface Hooks {
  /** 002.md 읽기 요청 수 */
  reads: number;
  writes: number;
  /** fail: 거절 / ok: 정상 / hold-ok·hold-fail: 붙잡았다가 release 때 정상·거절 */
  mode: 'fail' | 'ok' | 'hold-ok' | 'hold-fail';
  release?: () => void;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const g = globalThis as unknown as { hooks: Hooks };
    g.hooks = { reads: 0, writes: 0, mode: 'fail' };
    const read = map.get('chapter:read')!;
    ipcMain.removeHandler('chapter:read');
    ipcMain.handle('chapter:read', async (...args: unknown[]) => {
      const h = g.hooks;
      if (!String(args[1]).endsWith('002.md')) return read(...args);
      h.reads += 1;
      if (h.mode === 'fail') throw new Error('EACCES: permission denied (synthetic)');
      if (h.mode === 'hold-ok' || h.mode === 'hold-fail') {
        await new Promise<void>((resolve) => (h.release = resolve));
        if (h.mode === 'hold-fail') throw new Error('EACCES: permission denied (synthetic, late)');
      }
      return read(...args);
    });
    const write = map.get('chapter:write')!;
    ipcMain.removeHandler('chapter:write');
    ipcMain.handle('chapter:write', (...args: unknown[]) => {
      g.hooks.writes += 1;
      return write(...args);
    });
  });
const setMode = (app: ElectronApplication, mode: Hooks['mode']) => app.evaluate((_e, m) => void ((globalThis as unknown as { hooks: Hooks }).hooks.mode = m), mode);
const hooks = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks.release?.());
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const until = async (app: ElectronApplication, ok: (h: Hooks) => boolean) => {
  const deadline = Date.now() + 15_000;
  while (!ok(await hooks(app))) {
    if (Date.now() > deadline) throw new Error('장벽 대기 시간 초과');
    await new Promise((r) => setTimeout(r, 25));
  }
};

const list = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const message = (page: Page) => page.locator('.editor-message');
const retry = (page: Page) => page.locator('.editor-pane').getByRole('button', { name: '다시 시도' });

async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), A);
  await writeFile(join(dir, 'chapters', '002.md'), B);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.locator('.ProseMirror').getByText('A 본문', { exact: true }).waitFor();
  await hook(app);
  return { app, page, dir };
}

test('일시적인 읽기 실패 뒤 같은 화를 다시 눌러도, [다시 시도]로도 복구된다: 실패 중 빈 본문 편집·저장 0, 반복 실패 안내 유지, 복구 뒤 정상 본문', { timeout: 90_000 }, async () => {
  const { app, page, dir } = await start('crr-basic');
  try {
    await list(page).getByRole('button', { name: 'B_CH' }).click();
    await message(page).getByText(/이 화를 열 수 없습니다/).waitFor();
    assert.equal(await page.locator('.ProseMirror').count(), 0, '실패 중에는 편집기(빈 본문)가 없다');
    // 대역이 복구돼도, 같은 화를 다시 누르는 것만으로는 복구되지 않던 경계 (다시 시도 조작이 필요)
    await setMode(app, 'ok');
    await list(page).getByRole('button', { name: 'B_CH' }).click();
    await settled(page);
    await settled(page);
    assert.match(await message(page).innerText(), /이 화를 열 수 없습니다/, '같은 화 재선택은 읽기를 다시 하지 않는다 (복구는 [다시 시도]로)');
    assert.equal((await hooks(app)).reads, 1, '같은 화 재선택으로 읽기가 다시 나가지 않았다');
    await retry(page).waitFor();
    // 반복 실패: 안내 유지, 한 번 누르면 읽기 요청 한 번
    await setMode(app, 'fail');
    const before = (await hooks(app)).reads;
    await retry(page).click();
    await message(page).getByText(/이 화를 열 수 없습니다/).waitFor();
    await retry(page).waitFor();
    assert.equal((await hooks(app)).reads, before + 1, '시도 1회 = 읽기 1회');
    assert.equal((await hooks(app)).writes, 0, '실패하는 동안 저장 0');
    // 복구
    await setMode(app, 'ok');
    await retry(page).click();
    await page.locator('.ProseMirror').getByText('B 본문 줄', { exact: true }).waitFor();
    assert.equal(await page.getByText(/이 화를 열 수 없습니다/).count(), 0);
    assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), A, 'A 바이트 보존');
    assert.equal(await readFile(join(dir, 'chapters', '002.md'), 'utf8'), B, 'B 바이트 보존');
  } finally {
    await closeWindow(app);
  }
});

test('재시도 중 연타는 읽기 한 번만 보내고, 재시도 대기 중 다른 화로 옮기면 늦은 성공·실패가 새 화면을 오염하지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, dir } = await start('crr-late');
  try {
    await list(page).getByRole('button', { name: 'B_CH' }).click();
    await retry(page).waitFor();
    // 늦은 성공: 재시도를 붙잡고 연타 → 읽기 1회, 그동안 A로 이동, 풀어도 A 유지
    await setMode(app, 'hold-ok');
    const base = (await hooks(app)).reads;
    await retry(page).dblclick();
    await until(app, (h) => h.reads >= base + 1);
    assert.equal((await hooks(app)).reads, base + 1, '재시도 연타는 읽기 한 번');
    await list(page).getByRole('button', { name: 'A_CH' }).click();
    await page.locator('.ProseMirror').getByText('A 본문', { exact: true }).waitFor();
    await release(app);
    await settled(page);
    await settled(page);
    assert.equal(await page.locator('.ProseMirror').getByText('B 본문 줄').count(), 0, '늦은 성공이 새 화면(A)을 B로 바꾸지 않는다');
    assert.equal(await page.locator('.ProseMirror').getByText('A 본문', { exact: true }).count(), 1);

    // 늦은 실패: 다시 B로 가서 실패 → 재시도를 붙잡고 → A로 이동 → 풀어 실패해도 A 화면에 오류가 보이지 않는다
    await setMode(app, 'fail');
    await list(page).getByRole('button', { name: 'B_CH' }).click();
    await retry(page).waitFor();
    await setMode(app, 'hold-fail');
    const base2 = (await hooks(app)).reads;
    await retry(page).click();
    await until(app, (h) => h.reads >= base2 + 1);
    await list(page).getByRole('button', { name: 'A_CH' }).click();
    await page.locator('.ProseMirror').getByText('A 본문', { exact: true }).waitFor();
    await release(app);
    await settled(page);
    await settled(page);
    assert.equal(await page.getByText(/이 화를 열 수 없습니다/).count(), 0, '늦은 실패 오류가 A 화면에 보이지 않는다');
    assert.equal((await hooks(app)).writes, 0, '저장 0');
    assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), A);
    assert.equal(await readFile(join(dir, 'chapters', '002.md'), 'utf8'), B);
  } finally {
    await closeWindow(app);
  }
});
