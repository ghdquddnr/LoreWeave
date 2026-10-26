// 새 화·id 재발급을 기다리는 동안 열린 화가 입력을 받았다가, 화 이동·다시 읽기로 저장 없이 사라지지 않는다 (에디터 잠금).
// 실제 앱(Electron + Playwright). main 처리기는 끝까지 실행하고 응답만 붙잡는다. 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

async function project(prefix: string, files: Record<string, string>): Promise<string> {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  for (const [f, text] of Object.entries(files)) await writeFile(join(dir, 'chapters', f), text);
  return dir;
}
const editor = (page: Page) => page.locator('.ProseMirror');
const saved = (page: Page) => page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 5000 });
const read = (dir: string, f = '001.md') => readFile(join(dir, 'chapters', f), 'utf8');

/** channel 처리기를 끝까지 실행한 뒤(fail이면 그 뒤 오류로) 응답만 붙잡는다 */
async function holdResponse(app: ElectronApplication, channel: string, fail = false) {
  await app.evaluate(
    ({ ipcMain }, { channel, fail }) => {
      const g = globalThis as unknown as { held?: boolean; release?: () => void };
      g.held = false;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get(channel)!;
      handlers.set(channel, async (...args: unknown[]) => {
        const result = await original(...args);
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        handlers.set(channel, original);
        if (fail) throw new Error('늦게 실패한 조작');
        return result;
      });
    },
    { channel, fail },
  );
}
const held = (app: ElectronApplication) => app.evaluate(() => !!(globalThis as unknown as { held?: boolean }).held);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { release?: () => void }).release?.());
async function waitHeld(app: ElectronApplication, page: Page) {
  for (let n = 0; n < 200 && !(await held(app)); n++) await page.waitForTimeout(10);
  assert.equal(await held(app), true);
}
async function editable(page: Page) {
  for (let n = 0; n < 100 && (await editor(page).getAttribute('contenteditable')) !== 'true'; n++) await page.waitForTimeout(20);
  return (await editor(page).getAttribute('contenteditable')) === 'true';
}
async function openFolder(app: ElectronApplication, page: Page, dir: string) {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
}

test('새 화 (감독 재현): 생성 응답을 기다리는 동안 열린 화는 입력을 받지 않고, 새 화로 옮긴 뒤에도 원래 화는 그대로이며, 새 화는 편집된다', { timeout: 60_000 }, async () => {
  const A = await project('create-lock', { '001.md': '# A\n\nalpha\n' });
  const { app, page } = await launch(await tempDir('create-lock-userdata'));
  try {
    await openFolder(app, page, A);
    await editor(page).getByText('alpha').waitFor();
    await holdResponse(app, 'chapter:create');
    await page.getByRole('button', { name: '+ 새 화', exact: true }).click();
    await waitHeld(app, page);
    assert.equal(await editor(page).getAttribute('contenteditable'), 'false');
    await editor(page).getByText('alpha').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' ACCEPTED');
    await page.keyboard.insertText(' PASTED');
    const text = await editor(page).innerText();
    assert.ok(!text.includes('ACCEPTED') && !text.includes('PASTED'), '잠긴 에디터가 입력을 받았다');
    // 중복 조작도 막힌다
    assert.equal(await page.getByRole('button', { name: '+ 새 화', exact: true }).isDisabled(), true);
    await release(app);
    await page.waitForTimeout(2200);
    assert.equal(await read(A), '# A\n\nalpha\n');
    assert.deepEqual(await readdir(join(A, 'chapters')), ['001.md', '002.md']);
    // 새 화(002)가 열렸고 편집할 수 있다
    assert.equal(await editable(page), true);
    await editor(page).click();
    await page.keyboard.type('새 화 본문');
    await page.keyboard.press('Control+S');
    await saved(page);
    assert.match(await read(A, '002.md'), /새 화 본문/);
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});

test('새 화: 누르기 직전에 친 입력은 마지막 저장으로 원래 화에 남는다', { timeout: 60_000 }, async () => {
  const A = await project('create-before', { '001.md': '# A\n\nalpha\n' });
  const { app, page } = await launch(await tempDir('create-before-userdata'));
  try {
    await openFolder(app, page, A);
    await editor(page).getByText('alpha').click();
    await holdResponse(app, 'chapter:create');
    await page.keyboard.press('End');
    await page.keyboard.type(' before');
    await page.getByRole('button', { name: '+ 새 화', exact: true }).click();
    await waitHeld(app, page);
    assert.equal(await read(A), '# A\n\nalpha before\n');
    await release(app);
    await page.waitForTimeout(500);
    assert.equal(await read(A), '# A\n\nalpha before\n');
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});

test('새 화 실패: 잠금이 풀려 원래 화를 계속 편집·저장할 수 있다', { timeout: 60_000 }, async () => {
  const A = await project('create-fail', { '001.md': '# A\n\nalpha\n' });
  const { app, page } = await launch(await tempDir('create-fail-userdata'));
  try {
    await openFolder(app, page, A);
    await editor(page).getByText('alpha').waitFor();
    await holdResponse(app, 'chapter:create', true);
    await page.getByRole('button', { name: '+ 새 화', exact: true }).click();
    await waitHeld(app, page);
    await release(app);
    await page.getByRole('status').getByText('늦게 실패한 조작', { exact: false }).waitFor({ timeout: 5000 });
    assert.equal(await editable(page), true);
    assert.equal(await page.getByRole('button', { name: '+ 새 화', exact: true }).isDisabled(), false);
    await editor(page).getByText('alpha').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' after-fail');
    await page.keyboard.press('Control+S');
    await saved(page);
    assert.equal(await read(A), '# A\n\nalpha after-fail\n');
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});

test('id 재발급 (열린 화): 응답을 기다리는 동안 입력을 받지 않고, 다시 읽은 뒤 새 id와 원래 본문이 남으며 편집할 수 있다', { timeout: 60_000 }, async () => {
  const dup = (title: string) => `---\nid: same-id\ntitle: ${title}\n---\n${title} 본문\n`;
  const A = await project('reissue-lock', { '001.md': dup('첫째'), '002.md': dup('둘째') });
  const { app, page } = await launch(await tempDir('reissue-lock-userdata'));
  try {
    await openFolder(app, page, A);
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: '둘째' }).click();
    await editor(page).getByText('둘째 본문').waitFor();
    await holdResponse(app, 'chapter:reissue-id');
    await page.getByRole('button', { name: '새 id 발급' }).click();
    await waitHeld(app, page);
    assert.equal(await editor(page).getAttribute('contenteditable'), 'false');
    await editor(page).getByText('둘째 본문').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' LOST?');
    assert.ok(!(await editor(page).innerText()).includes('LOST?'));
    await release(app);
    await page.waitForTimeout(500);
    const after = await read(A, '002.md');
    assert.doesNotMatch(after, /id: same-id/);
    assert.match(after, /둘째 본문\n$/);
    assert.equal(await editable(page), true);
    await editor(page).getByText('둘째 본문').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' kept');
    await page.keyboard.press('Control+S');
    await saved(page);
    assert.match(await read(A, '002.md'), /둘째 본문 kept\n$/);
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});
