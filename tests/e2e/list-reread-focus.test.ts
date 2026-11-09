// 새 화 생성 뒤 목록 조회 실패 안내의 [목록 다시 읽기]를 실제 키보드(Shift+Tab 도달 → Enter/Space)로 실행할 때, 진행 중(busy disabled)·재실패·성공(버튼 제거)에서 포커스가 BODY로 사라지지 않는다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. chapter:create는 그대로 실행하되 횟수를 세고, 생성 직후의 chapters:list만 한 번 거절한다(이후 목록 재조회는 붙잡거나 거절/성공). chapter:write·ai:analyze 진입을 센다.
// 시작점(기술 상세 DOM focus)과 실제 키보드 경로(실제 Shift+Tab·Enter/Space·Escape)를 구분한다. 합성 Electron이며 수동 GUI·실제 OS IME 확인이 아니다. 실원고·실키·AI·유료·외부 호출 0.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const A = `${envelope('a', 'A_CH')}A 본문\r\n`;

interface H { creates: number; lists: number; writes: number; analyzes: number; armed: boolean; failFirst: boolean; hold: boolean; holdFails: boolean; entered: number; release?: () => void }
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const g = globalThis as unknown as { h: H };
    g.h = { creates: 0, lists: 0, writes: 0, analyzes: 0, armed: false, failFirst: true, hold: false, holdFails: false, entered: 0 };
    for (const [channel, key] of [['chapter:create', 'creates'], ['chapter:write', 'writes'], ['ai:analyze', 'analyzes']] as const) {
      const original = map.get(channel)!;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (...args: unknown[]) => {
        g.h[key] += 1;
        return original(...args);
      });
    }
    const list = map.get('chapters:list')!;
    ipcMain.removeHandler('chapters:list');
    ipcMain.handle('chapters:list', async (...args: unknown[]) => {
      const h = g.h;
      if (!h.armed) return list(...args);
      h.lists += 1;
      if (h.failFirst) {
        h.failFirst = false;
        throw new Error('EACCES: permission denied (synthetic list)');
      }
      if (h.hold) {
        h.entered += 1;
        await new Promise<void>((resolve) => (h.release = resolve));
        if (h.holdFails) throw new Error('EACCES: permission denied (synthetic, late list)');
      }
      return list(...args);
    });
  });
const patch = (app: ElectronApplication, p: Partial<H>) => app.evaluate((_e, p) => void Object.assign((globalThis as unknown as { h: H }).h, p), p);
const h = (app: ElectronApplication) => app.evaluate(() => { const x = (globalThis as unknown as { h: H }).h; return { creates: x.creates, lists: x.lists, writes: x.writes, analyzes: x.analyzes, entered: x.entered }; });
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { h: H }).h.release?.());
async function until(cond: () => Promise<boolean>, what: string) {
  const start = Date.now();
  while (!(await cond())) {
    assert.ok(Date.now() - start < 10_000, what);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
const retry = (page: Page) => page.locator('footer').getByRole('button', { name: '목록 다시 읽기' });
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { body: !el || el === document.body, connected: !!el?.isConnected, label: el?.textContent?.slice(0, 12) ?? '', inFooter: !!el?.closest('footer'), inEditor: !!el?.closest('.ProseMirror'), tag: el?.tagName ?? '' };
  });

async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  const a = join(dir, 'chapters', '001.md');
  await writeFile(a, A);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.locator('.ProseMirror').getByText('A 본문', { exact: true }).waitFor();
  await hook(app);
  await patch(app, { armed: true });
  await page.getByRole('button', { name: '+ 새 화', exact: true }).click(); // 생성은 마우스로 시작(시작점), 생성 직후 목록 조회가 거절된다
  await retry(page).waitFor();
  await page.evaluate(`(() => { window.__f = []; document.addEventListener('focusin', (e) => window.__f.push('in ' + e.target.tagName + '{' + (e.target.textContent || '').slice(0, 6) + '}'), true); document.addEventListener('keydown', (e) => window.__f.push('keydown ' + e.key + ' on ' + e.target.tagName), true); })()`);
  // 시작점만 DOM focus(기술 상세), [목록 다시 읽기]로의 이동은 실제 Shift+Tab
  await page.locator('footer').getByRole('button', { name: '기술 상세', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal((await active(page)).label, '목록 다시 읽기', '실제 Shift+Tab으로 [목록 다시 읽기]에 도달했다');
  return { app, page, dir, a };
}

for (const [name, press, holdFails] of [['성공', 'Enter', false], ['재실패', 'Space', true]] as const) {
  test(`[목록 다시 읽기]를 실제 ${press}로 실행하면 대기 중·${name} 뒤에도 포커스가 BODY로 사라지지 않는다 (생성 재실행 0)`, { timeout: 90_000 }, async () => {
    const { app, page, dir, a } = await start(`list-reread-focus-${name}`);
    try {
      await patch(app, { hold: true, holdFails });
      const base = await h(app);
      await page.keyboard.press(press);
      await until(async () => (await h(app)).entered === 1, '목록 재조회가 붙잡혔다');
      await frames(page);
      const waiting = await active(page);
      console.log(`계측 ${name} 대기 중 active=${JSON.stringify(waiting)} log=${JSON.stringify(await page.evaluate('window.__f'))}`);
      assert.equal(waiting.body, false, `대기 중 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(waiting)}`);
      // 대기 중 같은 버튼을 다시 눌러도(aria-disabled) 새 목록 조회가 나가지 않는다 (처리기에서 중복 차단)
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      await frames(page);
      assert.equal((await h(app)).entered, 1, '대기 중 중복 목록 재조회 0');
      await release(app);
      if (holdFails) await retry(page).waitFor(); // 재실패: 안내와 [목록 다시 읽기]가 남는다
      else await retry(page).waitFor({ state: 'detached' }); // 성공: 안내(버튼)가 사라진다
      await frames(page);
      const after = await active(page);
      assert.equal(after.body, false, `${name} 뒤에도 포커스가 BODY가 아니다: ${JSON.stringify(after)}`);
      const end = await h(app);
      assert.equal(end.creates, base.creates, '복구 중 chapter:create 0 (중복 화 0)');
      assert.equal(end.analyzes, 0, 'AI 실행 진입 0');
      assert.deepEqual(await readdir(join(dir, 'chapters')), ['001.md', '002.md'], '화는 하나만 만들어졌다');
      assert.ok((await readFile(a, 'utf8')) === A, '기존 합성 원고 바이트 보존');
      if (!holdFails) {
        // 키보드로 계속 사용: 포커스가 있는 곳에서 목록 탐색(Tab)이 가능하다
        await page.keyboard.press('Tab');
        assert.equal((await active(page)).body, false, '성공 뒤 실제 Tab이 BODY로 가지 않았다');
      }
    } finally {
      await closeWindow(app);
    }
  });
}
