// 화 읽기 실패의 [다시 시도]를 실제 키보드로 실행할 때 진행 중·재실패·성공에서 포커스가 BODY로 잃어지지 않는다. (원래 주석: 일시적인 화 읽기 실패에서 같은 화로 복구한다: 읽기 오류 화면에 [다시 시도]가 있고, 같은 화를 다시 읽어 정상 본문으로 돌아온다.
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
  mode: 'fail' | 'fail-path' | 'ok' | 'hold-ok' | 'hold-fail';
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
      if (h.mode === 'fail-path') throw new Error("EACCES: permission denied, open 'C:/Users/synthetic/chapters/002.md'");
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
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { body: !el || el === document.body, connected: !!el?.isConnected, label: el?.getAttribute('aria-label') ?? el?.textContent?.slice(0, 12) ?? '', inEditor: !!el?.closest('.ProseMirror'), inMessage: !!el?.closest('.editor-message') };
  });

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
  await page.evaluate(`(() => { window.__f = []; const nm = (e) => e.tagName + (e.getAttribute && e.getAttribute('aria-label') ? '[' + e.getAttribute('aria-label') + ']' : '') + (e.tagName === 'BUTTON' && e.textContent ? '{' + e.textContent.slice(0, 8) + '}' : '') + (e.className ? '.' + String(e.className).slice(0, 14) : ''); document.addEventListener('focusin', (e) => window.__f.push('in ' + nm(e.target)), true); document.addEventListener('keydown', (e) => window.__f.push('keydown ' + e.key + ' on ' + nm(e.target)), true); })()`);
  // 첫 읽기 실패: 002.md를 연다
  await setMode(app, 'fail');
  await list(page).getByRole('button', { name: 'B_CH' }).click();
  await page.getByRole('button', { name: '다시 시도', exact: true }).waitFor();
  // 시작점만 DOM focus(기술 상세), 다시 시도로의 이동은 실제 Shift+Tab
  await page.getByRole('button', { name: '기술 상세', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal((await active(page)).label, '다시 시도', '실제 Shift+Tab으로 다시 시도 버튼에 도달했다');
  return { app, page, dir, log: () => page.evaluate('window.__f') };
}
const bytes = async (dir: string) => `${await readFile(join(dir, 'chapters', '001.md'), 'utf8')}|${await readFile(join(dir, 'chapters', '002.md'), 'utf8')}`;

test('읽기 [다시 시도]를 실제 Enter로 실행해도 진행 중·재실패에서 포커스가 BODY로 잃어지지 않고 재실패 뒤 새 다시 시도 버튼으로 돌아온다', { timeout: 120_000 }, async () => {
  const { app, page, dir, log } = await start('crf-fail');
  try {
    const base = await hooks(app);
    await setMode(app, 'hold-fail');
    await page.keyboard.press('Enter');
    await until(app, (h) => h.reads === base.reads + 1);
    const inFlight = await active(page);
    assert.equal(inFlight.body, false, `진행 중 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(inFlight)} / ${JSON.stringify(await log())}`);
    assert.equal(inFlight.connected, true);
    await release(app);
    await page.getByRole('button', { name: '다시 시도', exact: true }).waitFor();
    await settled(page);
    const failed = await active(page);
    assert.equal(failed.body, false, `재실패 뒤에도 포커스가 BODY가 아니다: ${JSON.stringify(failed)}`);
    assert.equal(failed.label, '다시 시도', '새 다시 시도 버튼으로 돌아온다');
    assert.equal(await page.locator('.editor-message .tech-detail').count(), 0, '새 오류의 기술 상세는 접힌 채 시작한다');
    const end = await hooks(app);
    assert.equal(end.writes, base.writes, '포커스·읽기만의 경로에 저장 진입 0');
    assert.equal(await bytes(dir), `${A}|${B}`, '두 파일 바이트(BOM·CRLF·frontmatter) 불변');
  } finally {
    await closeWindow(app);
  }
});

test('읽기 [다시 시도]를 Space로 실행해 성공하면 정상 편집 시작 포커스가 유지된다', { timeout: 120_000 }, async () => {
  const { app, page, dir } = await start('crf-ok');
  try {
    const base = await hooks(app);
    await setMode(app, 'hold-ok');
    await page.keyboard.press('Space');
    await until(app, (h) => h.reads === base.reads + 1);
    assert.equal((await active(page)).body, false, '진행 중 포커스가 BODY가 아니다');
    await release(app);
    await page.locator('.ProseMirror').getByText('B 본문 줄', { exact: true }).waitFor();
    for (let i = 0; i < 50 && !(await active(page)).inEditor; i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await active(page)).inEditor, true, '성공하면 편집기가 시작 포커스를 받는다');
    assert.equal((await hooks(app)).writes, base.writes, '저장 진입 0');
    assert.equal(await bytes(dir), `${A}|${B}`);
  } finally {
    await closeWindow(app);
  }
});

for (const outcome of ['fail', 'ok'] as const) {
  test(`읽기 응답을 기다리는 사이 사용자가 실제 키보드로 옮긴 포커스는 늦은 ${outcome === 'ok' ? '성공' : '실패'} 응답이 빼앗지 않는다`, { timeout: 120_000 }, async () => {
    const { app, page, dir, log } = await start(`crf-moved-${outcome}`);
    try {
      const base = await hooks(app);
      await setMode(app, outcome === 'ok' ? 'hold-ok' : 'hold-fail');
      await page.keyboard.press('Enter');
      await until(app, (h) => h.reads === base.reads + 1);
      await page.keyboard.press('Shift+Tab'); // 사용자가 실제 키보드로 앞 컨트롤로 옮긴다
      const moved = await active(page);
      assert.equal(moved.body, false);
      assert.equal(moved.inMessage, false, '읽기 안내 밖의 컨트롤로 옮겼다');
      await release(app);
      if (outcome === 'ok') await page.locator('.ProseMirror').getByText('B 본문 줄', { exact: true }).waitFor();
      else await page.getByRole('button', { name: '다시 시도', exact: true }).waitFor();
      // 새 편집기 onCreate가 예약한 한 프레임 시작 포커스까지 지난 뒤에도 확인한다
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
      assert.deepEqual(await active(page), moved, `늦은 ${outcome === 'ok' ? '성공' : '실패'} 응답이 사용자가 옮긴 포커스를 빼앗지 않았다 / ${JSON.stringify(await log())}`);
      assert.equal((await hooks(app)).writes, base.writes, '저장 진입 0');
      assert.equal(await bytes(dir), `${A}|${B}`, '두 파일 바이트(BOM·CRLF·frontmatter) 불변');
    } finally {
      await closeWindow(app);
    }
  });
}
