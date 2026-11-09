// 저장 실패 상태줄의 [다시 저장]을 실제 키보드로 실행해 성공하면 그 버튼이 사라진다: 포커스가 BODY로 잃어지지 않고 편집기로 돌아온다. 재실패면 버튼과 포커스가 그대로이고, 대기 중 사용자가 옮긴 포커스는 늦은 성공이 빼앗지 않는다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. main의 chapter:write를 호출 수·장벽(hold → release)·실패 대역(mode)으로 감싼다. 이 검사 안에서만 renderer의 1500ms 자동 저장·5000ms 자동 재시도 타이머를 발화하지 않게 해
// 명시 저장(Ctrl+S, [다시 저장])과 자동 저장 경로를 구분한다(제품 상태기계 복제 아님). Tab 이동은 실제 키보드, 시작점만 DOM focus. 합성 Electron이며 수동 GUI·실제 OS IME 확인이 아니다. AI 진입은 계측하지 않는다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';
const withText = (text: string) => ONE.replace('Alpha text', text);

type G = { calls: number; hold: boolean; held: boolean; release?: () => void; mode: 'fail' | 'pass' };
const editor = (page: Page) => page.locator('.ProseMirror');
const bar = (page: Page) => page.locator('footer.statusbar');
const retryButton = (page: Page) => bar(page).getByRole('button', { name: /^(다시 저장|저장하는 중…)$/ });
const calls = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).calls);
const held = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).held);
const arm = (app: ElectronApplication, mode: G['mode']) =>
  app.evaluate((_e, mode) => {
    const g = globalThis as unknown as G;
    g.mode = mode;
    g.hold = true;
  }, mode);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { body: !el || el === document.body, connected: !!el?.isConnected, label: el?.textContent?.slice(0, 14) ?? '', inEditor: !!el?.closest('.ProseMirror'), inBar: !!el?.closest('footer.statusbar') };
  });
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
async function until(label: string, ok: () => Promise<boolean>) {
  for (let i = 0; i < 100; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`시간 안에 ${label} 상태가 되지 않았다`);
}

async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  page.on('dialog', (d) => void d.accept()); // 정리용으로만: 판정에 쓰지 않는다
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as G;
    Object.assign(g, { calls: 0, hold: false, held: false, mode: 'fail' });
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('chapter:write')!;
    handlers.set('chapter:write', async (...args: unknown[]) => {
      g.calls++;
      if (g.hold) {
        g.hold = false;
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        g.held = false;
      }
      if (g.mode === 'fail') throw Object.assign(new Error('EACCES: permission denied (synthetic)'), { code: 'EACCES' });
      return original(...args);
    });
  });
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await editor(page).getByText('Alpha text').waitFor();
  // 자동 저장(1500ms)·자동 재시도(5000ms) 타이머는 이 검사 안에서 발화하지 않게 해 명시 저장만 본다
  await page.evaluate(`(() => {
    const real = window.setTimeout.bind(window);
    window.setTimeout = (fn, delay, ...rest) => (delay === 1500 || delay === 5000 ? 0 : real(fn, delay, ...rest));
    window.__f = [];
    document.addEventListener('focusin', (e) => window.__f.push('in ' + e.target.tagName + '{' + (e.target.textContent || '').slice(0, 8) + '}'), true);
    document.addEventListener('keydown', (e) => window.__f.push('keydown ' + e.key + ' on ' + e.target.tagName), true);
  })()`);
  // 입력 → 명시 저장(Ctrl+S) 실패 → 안내줄에 [다시 저장]
  await editor(page).getByText('Alpha text').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' A');
  await page.keyboard.press('Control+S');
  await retryButton(page).waitFor();
  // 시작점만 DOM focus(본문 복사), [다시 저장]으로의 이동은 실제 Shift+Tab
  await bar(page).getByRole('button', { name: '본문 복사' }).focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal((await active(page)).label, '다시 저장', '실제 Shift+Tab으로 다시 저장 버튼에 도달했다');
  return { app, page, path, log: () => page.evaluate('window.__f') };
}

test('[다시 저장]을 실제 Enter로 실행해 성공하면 버튼이 사라져도 포커스가 BODY로 잃어지지 않고 편집기로 돌아온다', { timeout: 120_000 }, async () => {
  const { app, page, path, log } = await start('srsf-ok');
  try {
    const base = await calls(app);
    assert.equal(base, 1, '명시 저장 실패 한 건');
    await arm(app, 'pass');
    await page.keyboard.press('Enter');
    await until('붙잡은 재시도 저장', async () => (await held(app)) === true);
    const inFlight = await active(page);
    assert.equal(inFlight.label, '저장하는 중…', '진행 중에도 같은 버튼에 포커스가 있다 (aria-disabled)');
    await release(app);
    await bar(page).getByText('저장됨').waitFor({ timeout: 10_000 });
    await retryButton(page).waitFor({ state: 'detached' });
    await frames(page);
    const after = await active(page);
    assert.equal(after.body, false, `성공 뒤 버튼이 사라져도 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(after)} / ${JSON.stringify(await log())}`);
    assert.equal(after.inEditor, true, '편집기로 돌아온다');
    assert.equal(await calls(app), base + 1, '명시 저장 외 추가 쓰기 0 (재시도 한 건)');
    assert.ok((await readFile(path, 'utf8')) === withText('Alpha text A'), '성공한 본문만 디스크에 반영되고 BOM·CRLF·frontmatter가 보존된다');
  } finally {
    await closeWindow(app);
  }
});

test('[다시 저장]이 다시 실패하면 버튼과 포커스가 그대로이고, 대기 중 사용자가 옮긴 포커스는 늦은 성공이 빼앗지 않는다', { timeout: 120_000 }, async () => {
  const started = await start('srsf-fail');
  try {
    const { app, page, path } = started;
    // 재실패: 버튼과 포커스 유지
    await arm(app, 'fail');
    await page.keyboard.press('Space');
    await until('붙잡은 재시도 저장', async () => (await held(app)) === true);
    await release(app);
    await until('재실패 처리', async () => (await calls(app)) === 2 && (await active(page)).label === '다시 저장');
    await frames(page);
    assert.equal((await active(page)).label, '다시 저장', '재실패 뒤 버튼에 포커스가 그대로다');
    assert.ok((await readFile(path, 'utf8')) === ONE, '실패한 저장은 디스크를 바꾸지 않는다');

    // 대기 중 사용자가 실제 Shift+Tab으로 옮긴 포커스는 늦은 성공이 빼앗지 않는다
    await arm(app, 'pass');
    await page.keyboard.press('Enter');
    await until('두 번째 붙잡은 재시도 저장', async () => (await held(app)) === true);
    await page.keyboard.press('Shift+Tab'); // 사용자가 앞 컨트롤로 실제 키보드로 옮긴다
    const moved = await active(page);
    assert.equal(moved.body, false);
    assert.notEqual(moved.label, '저장하는 중…');
    await release(app);
    await bar(page).getByText('저장됨').waitFor({ timeout: 10_000 });
    await frames(page);
    assert.deepEqual(await active(page), moved, '늦은 성공이 사용자가 옮긴 포커스를 빼앗지 않았다');
    assert.ok((await readFile(path, 'utf8')) === withText('Alpha text A'), '성공한 본문만 디스크에 반영된다');
  } finally {
    await closeWindow(started.app);
  }
});
