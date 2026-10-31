// 검색 전 저장(flush)이 실패하면 저장하지 못한 본문을 디스크만 찾은 "없음/찾음" 결과로 보이지 않는다.
// 합성 원고·격리 userData. main의 chapter:write를 실패/장벽 대역으로 감싸고, chapters:search 호출을 센다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const ONE = `${envelope('one', 'ONE')}알파 하나\r\n\r\n베타 하나\r\n`;

interface Hooks {
  searches: string[];
  writes: number;
  /** fail: 쓰기 거절 / hold: 쓰기를 붙잡았다가 release 때 거절 / ok: 정상 */
  writeMode: 'ok' | 'fail' | 'hold';
  releaseWrite?: () => void;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const g = globalThis as unknown as { hooks: Hooks };
    g.hooks = { searches: [], writes: 0, writeMode: 'ok' };
    const search = map.get('chapters:search')!;
    ipcMain.removeHandler('chapters:search');
    ipcMain.handle('chapters:search', (...args: unknown[]) => {
      g.hooks.searches.push(args[1] as string);
      return search(...args);
    });
    const write = map.get('chapter:write')!;
    ipcMain.removeHandler('chapter:write');
    ipcMain.handle('chapter:write', async (...args: unknown[]) => {
      const h = g.hooks;
      h.writes += 1;
      if (h.writeMode === 'hold') {
        await new Promise<void>((resolve) => (h.releaseWrite = resolve));
        throw new Error('EACCES: permission denied (synthetic)');
      }
      if (h.writeMode === 'fail') throw new Error('EACCES: permission denied (synthetic)');
      return write(...args);
    });
  });
const mode = (app: ElectronApplication, m: Hooks['writeMode']) => app.evaluate((_e, m) => void ((globalThis as unknown as { hooks: Hooks }).hooks.writeMode = m), m);
const hooks = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks);
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const box = (page: Page) => page.getByRole('searchbox', { name: '원고 검색' });
const results = (page: Page) => page.getByRole('list', { name: '검색 결과' });
const list = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const submit = async (page: Page, q: string) => {
  await box(page).fill(q);
  await box(page).press('Enter');
};

async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.locator('.ProseMirror').waitFor();
  await list(page).getByRole('button', { name: 'ONE' }).waitFor();
  // 색인 준비: 정상 검색 한 번
  await submit(page, '알파');
  await results(page).waitFor();
  await page.getByRole('button', { name: '목록으로' }).click();
  await hook(app);
  return { app, page, dir };
}
async function typeUnsaved(page: Page, text: string) {
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(text);
}

test('저장하지 못한 채 검색하면 검색 요청과 거짓 "없음" 없이 저장 문제 안내를 보이고, 입력·원고 바이트를 보존하며, 해결 뒤 정상 검색된다', { timeout: 90_000 }, async () => {
  const { app, page, dir } = await start('sff-basic');
  try {
    await mode(app, 'fail');
    await typeUnsaved(page, 'UNSAVEDWORD');
    await submit(page, 'UNSAVEDWORD');
    const note = page.locator('.search .error');
    await note.waitFor({ timeout: 15_000 });
    assert.match(await note.innerText(), /저장하지 못해 검색하지 않았습니다/);
    assert.match(await note.innerText(), /다시 검색/);
    assert.deepEqual((await hooks(app)).searches, [], '새 검색 IPC 0');
    assert.equal(await page.locator('.search-summary').filter({ hasText: /없음|찾음/ }).count(), 0, '거짓 완료 결과(없음/찾음) 0');
    assert.equal(await results(page).count(), 0);
    assert.equal(await list(page).isVisible(), true, '화 목록으로 돌아간다');
    assert.match(await page.locator('.ProseMirror').innerText(), /UNSAVEDWORD/, '저장하지 못한 입력은 그대로');
    assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), ONE, '디스크 원고 바이트 보존 (강제 저장·덮어쓰기 없음)');

    // 저장 문제를 해결한 뒤 같은 검색: 정상 결과
    await mode(app, 'ok');
    await submit(page, 'UNSAVEDWORD');
    await results(page).waitFor();
    assert.match(await page.locator('.search-summary').first().innerText(), /찾음/);
    assert.deepEqual((await hooks(app)).searches, ['UNSAVEDWORD']);
    assert.equal(await page.locator('.search .error').count(), 0, '성공하면 안내가 사라진다');
    assert.match(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), /UNSAVEDWORD/, '해결 뒤 저장됨');
  } finally {
    await mode(app, 'ok').catch(() => undefined);
    await closeWindow(app);
  }
});

test('이전 완료 검색 결과가 있을 때 저장 실패 검색은 이전 결과를 새 결과처럼 보이지 않는다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('sff-previous');
  try {
    await submit(page, '베타');
    await results(page).waitFor();
    await mode(app, 'fail');
    await typeUnsaved(page, 'NEWTEXT');
    await submit(page, 'NEWTEXT');
    await page.locator('.search .error').waitFor({ timeout: 15_000 });
    assert.equal(await results(page).count(), 0, '이전(베타) 결과가 새 검색의 결과처럼 남지 않는다');
    assert.equal(await list(page).isVisible(), true);
    assert.equal((await hooks(app)).searches.includes('NEWTEXT'), false);
  } finally {
    await mode(app, 'ok').catch(() => undefined);
    await closeWindow(app);
  }
});

test('저장 대기 중 Esc로 취소하면 뒤늦은 저장 실패 안내를 띄우지 않고 검색도 보내지 않는다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('sff-cancel');
  try {
    await mode(app, 'hold');
    await typeUnsaved(page, 'HELDWORD');
    await submit(page, 'HELDWORD');
    const deadline = Date.now() + 15_000;
    while ((await hooks(app)).writes < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.ok((await hooks(app)).writes >= 1, '저장 요청이 도착했다');
    await box(page).press('Escape');
    await app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks.releaseWrite?.());
    await mode(app, 'ok');
    await settled(page);
    await settled(page);
    assert.equal(await page.locator('.search .error').count(), 0, '취소된 요청의 늦은 실패 안내가 없다');
    assert.deepEqual((await hooks(app)).searches, []);
    assert.equal(await list(page).isVisible(), true);
  } finally {
    await mode(app, 'ok').catch(() => undefined);
    await closeWindow(app);
  }
});
