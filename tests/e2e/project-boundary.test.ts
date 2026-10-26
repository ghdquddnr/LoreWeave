// 프로젝트를 바꾸는 경계에서 이전 프로젝트 화면의 저장이 새 프로젝트 파일에 쓰이지 않는다 (main이 프로젝트 token으로 거절).
// 실제 앱(Electron + Playwright). 실제 API는 쓰지 않는다. 원고는 임시 폴더의 합성 원고다.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { STALE_PROJECT } from '../../src/preload/api.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

async function project(prefix: string, text: string): Promise<string> {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), text);
  return dir;
}
const read = (dir: string) => readFile(join(dir, 'chapters', '001.md'), 'utf8');
const editor = (page: Page) => page.locator('.ProseMirror');
const saved = (page: Page) => page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 5000 });

async function openFirst(app: ElectronApplication, page: Page, dir: string) {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
}

/** project:choose 처리기가 끝난 뒤(main의 root는 새 폴더) 응답만 붙잡아, renderer가 아직 이전 프로젝트를 보이게 한다 */
async function holdChooseResponse(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { switched?: boolean; release?: () => void };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('project:choose')!;
    handlers.set('project:choose', async (...args: unknown[]) => {
      const result = await original(...args);
      g.switched = true;
      await new Promise<void>((resolve) => (g.release = resolve));
      handlers.set('project:choose', original);
      return result;
    });
  });
}
const switched = (app: ElectronApplication) => app.evaluate(() => !!(globalThis as unknown as { switched?: boolean }).switched);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { release?: () => void }).release?.());

for (const [name, aText, bText] of [
  ['같은 바이트 (감독 재현)', '# Same\n\nidentical manuscript\n', '# Same\n\nidentical manuscript\n'],
  ['다른 바이트', '# Project A\n\nidentical manuscript\n', '# Project B\n\nBeta manuscript\n'],
] as const) {
  test(`경계 (${name}): main은 이미 B인데 화면이 아직 A인 동안 A 에디터는 입력·붙여넣기를 받지 않고 원고 조작도 막히며, A·B 모두 바뀌지 않고, 그 뒤 B에서는 정상 저장된다`, { timeout: 60_000 }, async () => {
    const A = await project('boundary-A', aText);
    const B = await project('boundary-B', bText);
    const { app, page } = await launch(await tempDir('boundary-userdata'));
    try {
      await openFirst(app, page, A);
      await editor(page).getByText('identical manuscript').waitFor();
      await holdChooseResponse(app);
      await stubFolderDialog(app, B);
      await page.getByRole('button', { name: '열기', exact: true }).click();
      for (let n = 0; n < 200 && !(await switched(app)); n++) await page.waitForTimeout(10);
      assert.equal(await switched(app), true);
      // 화면은 아직 A지만 에디터는 잠겨 있다
      assert.equal(await editor(page).getAttribute('contenteditable'), 'false');
      await editor(page).getByText('identical manuscript').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' OLD EDITOR');
      await page.keyboard.insertText(' PASTED');
      await page.keyboard.press('Control+S');
      assert.ok(!(await editor(page).innerText()).includes('OLD EDITOR'), '잠긴 에디터가 입력을 받았다');
      assert.ok(!(await editor(page).innerText()).includes('PASTED'), '잠긴 에디터가 붙여넣기를 받았다');
      // 원고 조작도 막힌다
      assert.equal(await page.getByRole('button', { name: '+ 새 화' }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: '열기', exact: true }).isDisabled(), true);
      await page.waitForTimeout(2000);
      assert.equal(await read(A), aText);
      assert.equal(await read(B), bText);
      assert.deepEqual(await readdir(join(B, 'chapters')), ['001.md']);
      await release(app);
      await editor(page).waitFor();
      for (let n = 0; n < 100 && (await editor(page).getAttribute('contenteditable')) !== 'true'; n++) await page.waitForTimeout(20);
      assert.equal(await editor(page).getAttribute('contenteditable'), 'true');
      // B에서는 정상 저장된다
      await editor(page).getByText(bText.includes('Beta') ? 'Beta manuscript' : 'identical manuscript').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' in B');
      await page.keyboard.press('Control+S');
      await saved(page);
      assert.match(await read(B), / in B\n$/);
      assert.equal(await read(A), aText);
    } finally {
      await release(app).catch(() => {});
      await closeWindow(app);
    }
    assert.equal(await read(A), aText);
    assert.ok(!(await read(B)).includes('OLD EDITOR'));
  });
}

test('잠그기 직전에 친 입력은 마지막 저장으로 A에 남고 B에는 쓰이지 않는다', { timeout: 60_000 }, async () => {
  const A = await project('last-A', '# A\n\nalpha\n');
  const B = await project('last-B', '# A\n\nalpha\n');
  const { app, page } = await launch(await tempDir('last-userdata'));
  try {
    await openFirst(app, page, A);
    await editor(page).getByText('alpha').click();
    await holdChooseResponse(app);
    await stubFolderDialog(app, B);
    // 자동 저장(1.5초) 전에 입력하고 곧바로 열기를 누른다
    await page.keyboard.press('End');
    await page.keyboard.type(' last moment');
    await page.getByRole('button', { name: '열기', exact: true }).click();
    for (let n = 0; n < 200 && !(await switched(app)); n++) await page.waitForTimeout(10);
    assert.equal(await read(A), '# A\n\nalpha last moment\n');
    assert.equal(await read(B), '# A\n\nalpha\n');
    await release(app);
    await editor(page).getByText('alpha').waitFor();
    assert.ok(!(await editor(page).innerText()).includes('last moment'));
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
  assert.equal(await read(A), '# A\n\nalpha last moment\n');
  assert.equal(await read(B), '# A\n\nalpha\n');
});

test('이전 token으로 직접 보낸 읽기·쓰기·새 화·id 재발급은 main이 거절하고, 새 프로젝트에 아무것도 쓰지 않는다', { timeout: 60_000 }, async () => {
  const A = await project('token-A', '# A\n\nalpha\n');
  const B = await project('token-B', '# B\n\nbeta\n');
  const { app, page } = await launch(await tempDir('token-userdata'));
  try {
    await openFirst(app, page, A);
    await editor(page).getByText('alpha').waitFor();
    await stubFolderDialog(app, B);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await editor(page).getByText('beta').waitFor();
    // 새 사용자 데이터에서 처음 연 A가 token 1, B가 token 2다
    // 페이지에서 그대로 실행하도록 문자열로 넘긴다 (테스트 변환기가 붙이는 도우미 이름이 페이지에는 없다)
    const results = (await page.evaluate(`(async () => {
      const c = window.loreweave.chapters;
      const tryIt = (p) => p.then(() => 'ok', (e) => e.message);
      const { hash } = await c.read('001.md', 2);
      return {
        read: await tryIt(c.read('001.md', 1)),
        write: await tryIt(c.write('001.md', 'stale', hash, 1)),
        create: await tryIt(c.create(1)),
        reissue: await tryIt(c.reissueId('001.md', 1)),
        current: await tryIt(c.read('001.md', 2)),
      };
    })()`)) as Record<'read' | 'write' | 'create' | 'reissue' | 'current', string>;
    for (const k of ['read', 'write', 'create', 'reissue'] as const) assert.match(results[k], new RegExp(STALE_PROJECT), k);
    assert.equal(results.current, 'ok');
    assert.equal(await read(B), '# B\n\nbeta\n');
    assert.deepEqual(await readdir(join(B, 'chapters')), ['001.md']);
  } finally {
    await closeWindow(app);
  }
  assert.equal(await read(A), '# A\n\nalpha\n');
});

test('전환 취소·실패 뒤에는 A를 계속 편집·저장할 수 있고, 같은 폴더를 다시 열어도 정상 저장된다', { timeout: 60_000 }, async () => {
  const A = await project('keep-A', '# A\n\nalpha\n');
  // chapters가 폴더가 아니라 파일이면 화 목록을 읽지 못해 열기가 실패한다
  const broken = await tempDir('keep-broken');
  await writeFile(join(broken, 'chapters'), 'not a folder');
  const { app, page } = await launch(await tempDir('keep-userdata'));
  try {
    await openFirst(app, page, A);
    await editor(page).getByText('alpha').waitFor();
    // 취소
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
    });
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await page.waitForTimeout(300);
    await editor(page).getByText('alpha').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' after-cancel');
    await page.keyboard.press('Control+S');
    await saved(page);
    assert.equal(await read(A), '# A\n\nalpha after-cancel\n');
    // 실패 (화 목록을 읽을 수 없는 폴더)
    await stubFolderDialog(app, broken);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await page.waitForTimeout(500);
    await editor(page).getByText('alpha after-cancel').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' after-fail');
    await page.keyboard.press('Control+S');
    await saved(page);
    assert.equal(await read(A), '# A\n\nalpha after-cancel after-fail\n');
    // 같은 폴더 다시 열기 (새 token)
    await stubFolderDialog(app, A);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await editor(page).getByText('alpha after-cancel after-fail').waitFor({ timeout: 5000 });
    await editor(page).getByText('alpha after-cancel after-fail').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' reopened');
    await page.keyboard.press('Control+S');
    await saved(page);
    assert.equal(await read(A), '# A\n\nalpha after-cancel after-fail reopened\n');
  } finally {
    await closeWindow(app);
  }
});
