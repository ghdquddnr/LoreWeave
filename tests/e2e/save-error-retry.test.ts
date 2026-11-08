// 저장 실패 안내의 [다시 저장]: 기존 flush() 경로로 누른 시점의 최신 본문을 다시 저장한다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. main의 chapter:write 처리기를 무료 대역으로 감싼다: 호출 수를 세고, 장벽(hold)이 걸려 있으면 release까지 붙잡고, mode에 따라 실패(EACCES 대역)시키거나 원래 처리기로 넘긴다.
// 관측 범위: 5초 자동 재시도·1.5초 자동 저장 타이머는 막지 않는다. 명시 요청은 "누르기 직전 호출 수 + 1"이 장벽에 붙잡힌 것으로, 중복 클릭 뒤에도 그 수가 유지되는 것까지만 확인한다 (그 이후의 영구 부재는 주장하지 않는다).
// 버튼 키보드 실행은 버튼에 포커스를 준 뒤 Enter로 본다 (Tab 이동 순서는 보지 않는다). 합성 Electron 검사이며 수동 GUI·실제 IME 확인이 아니다. 유료·외부 호출 없음. 본문은 출력하지 않고 동등 여부(boolean)만 판정한다.

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
const roundTrip = (page: Page) => page.evaluate(() => window.loreweave.chapters.list(1));
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 600 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, what);
}

test('저장 실패의 [다시 저장]은 기존 저장 경로로 최신 본문을 다시 저장하고, 중복 클릭은 새 요청을 만들지 않으며, 재실패해도 입력·디스크는 그대로다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('save-error-retry');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir('save-error-retry-ud'));
  page.on('dialog', (d) => void d.accept()); // 정리용으로만: 판정에 쓰지 않는다
  try {
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
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
    await editor(page).getByText('Alpha text').waitFor();
    const original = await readFile(path);

    // 1) 최초 저장 실패 → 추가 입력. 실패 중에는 안내에 [다시 저장]이 있다
    assert.equal(await retryButton(page).count(), 0, '실패 전에는 버튼이 없다');
    await editor(page).getByText('Alpha text').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' A');
    await page.keyboard.press('Control+S');
    await bar(page).getByText('저장 실패', { exact: false }).waitFor({ timeout: 30_000 });
    await retryButton(page).waitFor();
    await page.keyboard.type(' B');
    // 입력하면 상태가 '저장 안 됨'으로 바뀌고, 1.5초 자동 저장이 다시 실패해야 실패 안내가 돌아온다 (기존 상태 규칙)
    await bar(page).getByText('저장 실패', { exact: false }).waitFor({ timeout: 30_000 });
    await retryButton(page).waitFor();
    assert.ok(Buffer.compare(await readFile(path), original) === 0, '실패 중 디스크 원본 바이트 그대로');

    // 2) 마우스로 재시도: 장벽에 붙잡힌 동안 진행 상태가 보이고, 중복 클릭·Enter는 새 요청을 만들지 않는다
    await arm(app, 'fail');
    const before = await calls(app);
    await retryButton(page).click();
    await waitUntil(page, '재시도 요청이 장벽에 붙잡히지 않았다', () => held(app));
    assert.equal(await calls(app), before + 1, '명시 요청 한 건');
    await bar(page).getByRole('button', { name: '저장하는 중…' }).waitFor();
    const pending = await bar(page).innerText();
    assert.ok(/저장 중/.test(pending) && !/저장됨/.test(pending), '응답 전에는 저장됨이 아니라 저장 중');
    await bar(page).getByRole('button', { name: '저장하는 중…' }).click({ force: true }); // aria-disabled라 force: 실제 클릭을 보내되 중복 요청이 생기지 않아야 한다
    await bar(page).getByRole('button', { name: '저장하는 중…' }).focus();
    await page.keyboard.press('Enter');
    await roundTrip(page);
    assert.equal(await calls(app), before + 1, '붙잡힌 동안 중복 클릭·Enter가 새 요청을 만들지 않았다 (관측 범위 안)');
    // 저장 도중의 추가 입력은 미저장으로 남는다
    await editor(page).getByText('Alpha text A B', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' C');
    await release(app); // 재실패
    await bar(page).getByText('저장 실패', { exact: false }).waitFor({ timeout: 30_000 });
    await bar(page).getByRole('button', { name: '다시 저장' }).waitFor();
    assert.equal(await editor(page).getByText('Alpha text A B C', { exact: true }).count(), 1, '재실패 뒤에도 입력 보존');
    assert.ok(Buffer.compare(await readFile(path), original) === 0, '재실패 뒤 디스크 원본 바이트 그대로');
    assert.ok(!/저장됨/.test(await bar(page).innerText()), '재실패는 저장됨으로 보이지 않는다');

    // 3) 키보드로 재시도(버튼 포커스 + Enter): 이번에는 원래 처리기로 넘어가 저장된다
    await arm(app, 'pass');
    const before2 = await calls(app);
    await retryButton(page).focus();
    await page.keyboard.press('Enter');
    await waitUntil(page, '키보드 재시도 요청이 장벽에 붙잡히지 않았다', () => held(app));
    assert.equal(await calls(app), before2 + 1, '키보드 명시 요청 한 건');
    assert.ok(!/저장됨/.test(await bar(page).innerText()), '응답 전에는 저장됨이 아니다');
    assert.ok(Buffer.compare(await readFile(path), original) === 0, '응답 전 디스크는 그대로');
    await release(app);
    await bar(page).getByText('저장됨', { exact: true }).waitFor({ timeout: 30_000 });
    assert.ok((await readFile(path, 'utf8')) === withText('Alpha text A B C'), '최신 본문이 BOM·CRLF·frontmatter와 함께 원래 처리기로 저장됐다');
    assert.equal(await retryButton(page).count(), 0, '저장되면 버튼이 사라진다');
  } finally {
    await closeWindow(app);
  }
});
