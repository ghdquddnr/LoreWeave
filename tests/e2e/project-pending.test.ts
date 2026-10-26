// 프로젝트를 바꾸기 전에 시작한 원고 조작(새 화, id 재발급)의 늦은 응답이 새 프로젝트 화면을 덮지 않는다.
// 실제 앱(Electron + Playwright). main 처리기는 끝까지 실행하고(원래 프로젝트에 반영) 응답만 붙잡는다. 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
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
const header = (page: Page) => page.locator('.sidebar header strong');
const list = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const saved = (page: Page) => page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 5000 });

/** channel 처리기를 끝까지 실행한 뒤(fail이면 그 뒤 오류로) 응답만 붙잡는다 */
async function holdResponse(app: ElectronApplication, channel: string, fail = false) {
  await app.evaluate(
    ({ ipcMain }, { channel, fail }) => {
      const g = globalThis as unknown as { held?: boolean; release?: () => void };
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get(channel)!;
      handlers.set(channel, async (...args: unknown[]) => {
        const result = await original(...args);
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        handlers.set(channel, original);
        if (fail) throw new Error('늦게 실패한 원래 프로젝트 조작');
        return result;
      });
    },
    { channel, fail },
  );
}
const held = (app: ElectronApplication) => app.evaluate(() => !!(globalThis as unknown as { held?: boolean }).held);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { release?: () => void }).release?.());

async function open(app: ElectronApplication, page: Page, dir: string, first = false) {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: first ? '원고 폴더 열기' : '열기', exact: true }).click();
}

for (const fail of [false, true]) {
  test(`새 화 (${fail ? '늦은 실패' : '늦은 성공'}): A에서 시작한 새 화 응답이 B를 연 뒤에 와도 B 화면·목록·선택·편집이 그대로이고, ${fail ? '오류도 B에 보이지 않으며' : 'A에 만든 화는 A로 돌아가면 보이며'}, B 파일은 바뀌지 않는다`, { timeout: 60_000 }, async () => {
    const A = await project('pending-A', { '001.md': '# A\n\nalpha\n' });
    const B = await project('pending-B', { '001.md': '# B\n\nbeta\n' });
    const { app, page } = await launch(await tempDir('pending-userdata'));
    try {
      await open(app, page, A, true);
      await editor(page).getByText('alpha').waitFor();
      await holdResponse(app, 'chapter:create', fail);
      await page.getByRole('button', { name: '+ 새 화', exact: true }).click();
      for (let n = 0; n < 200 && !(await held(app)); n++) await page.waitForTimeout(10);
      assert.equal(await held(app), true);
      await open(app, page, B);
      await editor(page).getByText('beta').waitFor();
      await release(app);
      await page.waitForTimeout(500);
      // B 화면이 그대로다
      assert.equal(await header(page).innerText(), basename(B));
      assert.match(await page.locator('.editor-pane').innerText(), /beta/);
      assert.deepEqual(await list(page).getByRole('button').allTextContents(), ['B']);
      if (fail) assert.equal(await page.getByRole('status').getByText('늦게 실패한').count(), 0);
      assert.equal(await page.getByRole('status').getByText('원고 폴더가 바뀌어').count(), 0);
      // B에서 편집·저장된다
      await editor(page).getByText('beta').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' edited');
      await page.keyboard.press('Control+S');
      await saved(page);
      assert.equal(await readFile(join(B, 'chapters', '001.md'), 'utf8'), '# B\n\nbeta edited\n');
      assert.deepEqual(await readdir(join(B, 'chapters')), ['001.md']);
      // A에는 새 화가 만들어져 있고, A로 돌아가면 보인다
      const aFiles = await readdir(join(A, 'chapters'));
      assert.deepEqual(aFiles, ['001.md', '002.md']);
      await open(app, page, A);
      await editor(page).getByText('alpha').waitFor();
      assert.equal(await list(page).getByRole('button').count(), 2);
      assert.equal(await readFile(join(A, 'chapters', '001.md'), 'utf8'), '# A\n\nalpha\n');
    } finally {
      await release(app).catch(() => {});
      await closeWindow(app);
    }
  });
}

test('id 재발급: A에서 시작한 재발급 응답이 B를 연 뒤에 와도 B 화면·목록이 그대로이고, A의 새 id는 A에 남는다', { timeout: 60_000 }, async () => {
  const dup = (title: string) => `---\nid: same-id\ntitle: ${title}\n---\n${title} 본문\n`;
  const A = await project('reissue-A', { '001.md': dup('첫째'), '002.md': dup('둘째') });
  const B = await project('reissue-B', { '001.md': '# B\n\nbeta\n' });
  const { app, page } = await launch(await tempDir('reissue-userdata'));
  try {
    await open(app, page, A, true);
    await page.getByRole('alert').getByText(/같은 id를 쓰는 화가 있습니다/).waitFor();
    await holdResponse(app, 'chapter:reissue-id');
    await page.getByRole('button', { name: '새 id 발급' }).click();
    for (let n = 0; n < 200 && !(await held(app)); n++) await page.waitForTimeout(10);
    assert.equal(await held(app), true);
    await open(app, page, B);
    await editor(page).getByText('beta').waitFor();
    await release(app);
    await page.waitForTimeout(500);
    assert.equal(await header(page).innerText(), basename(B));
    assert.deepEqual(await list(page).getByRole('button').allTextContents(), ['B']);
    assert.equal(await page.getByText(/같은 id를 쓰는 화가 있습니다/).count(), 0);
    assert.equal(await readFile(join(B, 'chapters', '001.md'), 'utf8'), '# B\n\nbeta\n');
    // A에서 재발급은 이미 반영됐다 (두 화의 id가 달라졌다)
    const ids = await Promise.all(['001.md', '002.md'].map(async (f) => /id: (.+)/.exec(await readFile(join(A, 'chapters', f), 'utf8'))![1]));
    assert.notEqual(ids[0], ids[1]);
    await open(app, page, A);
    await list(page).getByRole('button', { name: '첫째' }).waitFor();
    assert.equal(await page.getByText(/같은 id를 쓰는 화가 있습니다/).count(), 0);
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});
