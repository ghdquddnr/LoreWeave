// 새 화 생성은 성공했는데 바로 뒤 화 목록 조회가 실패하면, 생성 실패로 오인하지 않고 "만들어졌다"고 알리며 목록만 다시 읽어 복구한다.
// 성공한 생성은 다시 실행하지 않는다 (중복 화 0). 합성 원고·격리 userData. main의 chapter:create는 그대로 실행하되 횟수를 세고, 그 직후의 chapters:list 한 번만 거절한다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const A = `${envelope('a', 'A_CH')}A 본문\r\n`;

interface Hooks {
  creates: number;
  lists: number;
  /** 남은 list 거절 횟수 */
  listFailures: number;
  /** create 성공 뒤에만 list 거절을 시작한다 */
  armed: boolean;
  /** list 응답을 붙잡는다 (release로 풀기) */
  holdList: boolean;
  releaseList?: () => void;
  /** 붙잡았다 풀 때 거절할지 */
  holdFails: boolean;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const g = globalThis as unknown as { hooks: Hooks };
    g.hooks = { creates: 0, lists: 0, listFailures: 0, armed: false, holdList: false, holdFails: false };
    const create = map.get('chapter:create')!;
    ipcMain.removeHandler('chapter:create');
    ipcMain.handle('chapter:create', async (...args: unknown[]) => {
      g.hooks.creates += 1;
      return create(...args);
    });
    const list = map.get('chapters:list')!;
    ipcMain.removeHandler('chapters:list');
    ipcMain.handle('chapters:list', async (...args: unknown[]) => {
      const h = g.hooks;
      if (!h.armed) return list(...args);
      h.lists += 1;
      if (h.holdList) {
        await new Promise<void>((resolve) => (h.releaseList = resolve));
        if (h.holdFails) throw new Error('EACCES: permission denied (synthetic, late list)');
        return list(...args);
      }
      if (h.listFailures > 0) {
        h.listFailures -= 1;
        throw new Error('EACCES: permission denied (synthetic list)');
      }
      return list(...args);
    });
  });
const patch = (app: ElectronApplication, p: Partial<Hooks>) => app.evaluate((_e, p) => void Object.assign((globalThis as unknown as { hooks: Hooks }).hooks, p), p);
const hooks = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks);
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const list = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const footerError = (page: Page) => page.locator('footer .error');
const retry = (page: Page) => page.locator('footer').getByRole('button', { name: '목록 다시 읽기' });
const files = async (dir: string) => (await readdir(join(dir, 'chapters'))).sort();

async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), A);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.locator('.ProseMirror').getByText('A 본문', { exact: true }).waitFor();
  await hook(app);
  return { app, page, dir };
}
const newChapter = (page: Page) => page.getByRole('button', { name: '+ 새 화', exact: true });

test('생성 성공 뒤 목록 조회 실패: "만들어졌다"고 알리고, 편집 잠금을 풀며, 생성 재실행 없이 [목록 다시 읽기]로 새 화를 보여 준다 (반복 실패는 안내 유지)', { timeout: 90_000 }, async () => {
  const { app, page, dir } = await start('ncl-basic');
  try {
    await patch(app, { armed: true, listFailures: 2 });
    await newChapter(page).click();
    await footerError(page).waitFor({ timeout: 15_000 });
    const text = await footerError(page).innerText();
    assert.match(text, /만들어졌|만들었/, `생성은 성공했다고 알린다: ${text}`);
    assert.match(text, /002\.md/, '만들어진 파일을 알린다');
    assert.doesNotMatch(text, /새 화를 만들지 못했/);
    assert.deepEqual(await files(dir), ['001.md', '002.md'], '성공한 파일은 그대로 있다 (지우거나 롤백하지 않는다)');
    assert.equal((await hooks(app)).creates, 1);
    // 편집 잠금은 풀렸다: 기존 화에 입력된다
    await page.locator('.ProseMirror').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('추가입력');
    await page.locator('.ProseMirror').getByText('추가입력').waitFor();
    // 복구: 목록만 다시 읽는다. 첫 시도는 다시 실패 → 안내 유지
    await retry(page).click();
    await settled(page);
    await footerError(page).getByText(/002\.md/).waitFor();
    await retry(page).waitFor();
    assert.equal((await hooks(app)).creates, 1, '목록 다시 읽기는 생성을 다시 실행하지 않는다');
    // 다음 시도는 성공: 새 화가 목록에 보이고 열린다
    await retry(page).click();
    await list(page).getByRole('button').nth(1).waitFor();
    assert.equal(await footerError(page).count(), 0, '복구하면 안내가 사라진다');
    assert.equal(await list(page).getByRole('button').count(), 2, '목록에 두 화');
    assert.equal((await hooks(app)).creates, 1, '중복 create 0');
    assert.deepEqual(await files(dir), ['001.md', '002.md'], '중복 화 0');
    // 입력했던 기존 화 내용은 저장됐다
    assert.match(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), /추가입력/);
  } finally {
    await closeWindow(app);
  }
});

for (const lateFails of [true, false]) {
  test(`목록 조회 응답을 기다리는 중 다른 프로젝트를 열면 늦은 ${lateFails ? '실패' : '성공'}가 새 화면을 오염하지 않는다`, { timeout: 120_000 }, async () => {
    const { app, page, dir } = await start(`ncl-switch-${lateFails ? 'fail' : 'ok'}`);
    const other = await tempDir('ncl-switch-b');
    await mkdir(join(other, 'chapters'));
    const B = `${envelope('b', 'B_CH')}B 본문
`;
    await writeFile(join(other, 'chapters', '001.md'), B);
    try {
      await patch(app, { armed: true, holdList: true, holdFails: lateFails });
      await newChapter(page).click();
      const deadline = Date.now() + 15_000;
      while ((await hooks(app)).lists < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      assert.equal((await hooks(app)).lists, 1, '목록 조회가 붙잡혔다');
      // 실제 전환: 예외를 삼키지 않는다. 잠금 중에는 본문이 안 보일 수 있으므로 새 프로젝트 이름이 표시된 것으로 전환을 확인한다
      await stubFolderDialog(app, other);
      await page.getByRole('button', { name: '열기', exact: true }).click();
      await page.locator('.sidebar header strong').filter({ hasText: basename(other) }).waitFor({ timeout: 15_000 });
      await app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks.releaseList?.());
      // 처리 완료 장벽: 붙잡힌 목록 응답이 처리된 뒤 (잠금 해제 후 새 프로젝트 본문이 보인다)
      await page.locator('.ProseMirror').getByText('B 본문', { exact: true }).waitFor({ timeout: 15_000 });
      await settled(page);
      await settled(page);
      assert.equal(await footerError(page).count(), 0, `이전 프로젝트의 늦은 ${lateFails ? '실패' : '성공'}가 새 화면에 오류를 남기지 않는다`);
      assert.equal(await retry(page).count(), 0);
      assert.equal(await list(page).getByRole('button').count(), 1, '새 프로젝트의 목록은 그대로 (A의 새 화가 섞이지 않는다)');
      assert.equal((await hooks(app)).creates, 1);
      assert.equal(await readFile(join(other, 'chapters', '001.md'), 'utf8'), B, '새 프로젝트 원고 바이트 보존');
      assert.deepEqual(await files(other), ['001.md']);
      assert.deepEqual(await files(dir), ['001.md', '002.md'], 'A의 성공한 생성은 그대로');
    } finally {
      await closeWindow(app);
    }
  });
}

test('복구 목록 읽기를 기다리는 동안 다른 조작이 만든 오류와 기술 상세는 복구 성공이 지우지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, dir } = await start('ncl-own-error');
  try {
    await patch(app, { armed: true, listFailures: 1 });
    await newChapter(page).click();
    await footerError(page).getByText(/만들어졌/).waitFor({ timeout: 15_000 });
    // 복구 목록 읽기를 붙잡는다
    await patch(app, { holdList: true, holdFails: false });
    const base = (await hooks(app)).lists;
    await retry(page).click();
    const deadline = Date.now() + 15_000;
    while ((await hooks(app)).lists < base + 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    // 그 사이 다른 조작(폴더 열기)이 실패한다
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => {
        throw new Error('REVIEW_FOLDER_OPEN_FAILURE');
      }) as typeof dialog.showOpenDialog;
    });
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await footerError(page).waitFor();
    await footerError(page).getByRole('button', { name: '기술 상세' }).click();
    const popover = page.locator('.tech-popover');
    await popover.getByText(/REVIEW_FOLDER_OPEN_FAILURE/).waitFor({ timeout: 15_000 });
    // 복구가 성공해도 그 독립 오류와 상세는 남는다
    await app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks.releaseList?.());
    await list(page).getByRole('button').nth(1).waitFor({ timeout: 15_000 });
    await settled(page);
    assert.equal(await list(page).getByRole('button').count(), 2, '복구는 성공해 새 화가 목록에 보인다');
    assert.match(await popover.innerText(), /REVIEW_FOLDER_OPEN_FAILURE/, '다른 조작의 기술 상세가 지워지지 않는다');
    assert.ok((await footerError(page).count()) >= 1, '다른 조작의 오류 안내가 남는다');
    assert.doesNotMatch(await footerError(page).innerText(), /목록을 다시 읽지 못했습니다/, '이 일의 안내는 해소됐다');
    assert.equal((await hooks(app)).creates, 1, '생성 재실행 0');
    assert.deepEqual(await files(dir), ['001.md', '002.md'], '중복 화 0');
  } finally {
    await closeWindow(app);
  }
});

test('생성 자체가 실패하면 기존 의미대로 "만들지 못했다" 안내이며 목록 다시 읽기 조작은 없다', { timeout: 60_000 }, async () => {
  const { app, page, dir } = await start('ncl-create-fails');
  try {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('chapter:create');
      ipcMain.handle('chapter:create', () => {
        throw new Error('EACCES: permission denied (synthetic create)');
      });
    });
    await newChapter(page).click();
    await footerError(page).waitFor({ timeout: 15_000 });
    assert.doesNotMatch(await footerError(page).innerText(), /만들어졌/);
    assert.equal(await retry(page).count(), 0);
    assert.deepEqual(await files(dir), ['001.md']);
  } finally {
    await closeWindow(app);
  }
});
