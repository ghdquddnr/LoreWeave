// 초기 색인 맞춤(syncIndex)이 폴더 목록을 얻은 뒤 개별 화의 stat(변경 비교)을 부르기 직전에 그 화가 바깥에서 지워지면(ENOENT),
// 맞춤 전체가 거절되어 뒤에 오는 정상 화들의 색인이 빠지는지 본다. (initial-sync-cleanup은 목록에 없던 화의 정리, initial-sync-order/lifetime은 읽는 중인 화/프로젝트 전환이다.)
// 준비: 앱 1에서 001·002·003을 색인하고 닫은 뒤, 003을 바깥에서 새 내용으로 바꿔 색인이 옛것이 되게 한다. 앱 2(새 userdata)의 초기 맞춤은 목록(001·002·003)을 얻은 뒤
//   002의 stat을 부르기 직전(호출 전)에 붙잡힌다. 화 목록을 읽는 readFile이나 001의 stat과 구별하려고 정확히 002의 첫 stat만 붙잡는다.
// 붙잡은 동안 002를 지운 뒤 푼다. 풀기 전에는 검색하지 않는다 (검색은 indexReady를 기다린다). 풀고 나면 맞춤이 (성공으로든 실패로든) 끝나야 검색이 열린다.
// 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const doc = (id: string, title: string, text: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n${text}\r\n`;
const ONE = doc('one', 'One', 'Alpha oneword');
const TWO = doc('two', 'Two', 'Beta twoword');
const THREE_OLD = doc('three', 'Three', 'Gamma oldthreeword');
const THREE_NEW = doc('three', 'Three', 'Gamma newthreeword');

const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const search = (page: Page, q: string) => page.evaluate(`window.loreweave.chapters.search(${JSON.stringify(q)}).then((r) => r.total)`) as Promise<number>;

type G = { armed: boolean; held: boolean; returned: number; target: string; release?: () => void };
/** armed일 때 target(002.md)의 첫 stat을 부르기 전에 붙잡는다 */
async function install(app: ElectronApplication, target: string) {
  await app.evaluate((_e, target) => {
    const g = globalThis as unknown as G;
    Object.assign(g, { armed: false, held: false, returned: 0, target });
    const fsp = process.getBuiltinModule('fs/promises');
    const stat = fsp.stat;
    fsp.stat = (async (path: unknown, ...args: unknown[]) => {
      if (String(path) === g.target && g.armed) {
        g.armed = false; // 이 stat 하나만 붙잡는다
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        g.held = false;
        g.returned++;
      }
      return (stat as (...a: unknown[]) => Promise<unknown>)(path, ...args);
    }) as typeof fsp.stat;
  }, target);
}
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).armed = true));
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());
const state = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; return { held: g.held, returned: g.returned }; });
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>, app?: ElectronApplication) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, app ? `${what} ${JSON.stringify(await state(app))}` : what);
}

/** 앱 1에서 세 화를 색인하고 닫은 뒤 003을 새 내용으로 바꾼다 (색인은 옛 003). 앱 2를 열고, hold이면 002의 stat 직전에 붙잡힌 상태까지 */
async function start(hold: boolean) {
  const dir = await tempDir('sync-enoent');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  await writeFile(join(dir, 'chapters', '003.md'), THREE_OLD);
  const first = await launch(await tempDir('sync-enoent-userdata-1'));
  try {
    await stubFolderDialog(first.app, dir);
    await first.page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await chapter(first.page, 'One').waitFor(); // 폴더가 열린 뒤에야 검색할 수 있다
    await waitUntil(first.page, '앱 1에서 세 화가 색인되지 않았다', async () => (await search(first.page, 'oldthreeword')) === 1 && (await search(first.page, 'twoword')) === 1);
  } finally {
    await closeWindow(first.app);
  }
  await writeFile(join(dir, 'chapters', '003.md'), THREE_NEW); // 앱이 꺼진 사이 바깥에서 고쳤다 (색인은 옛 본문)
  const path002 = join(dir, 'chapters', '002.md');
  if (!hold) await rm(path002); // 대조: 앱이 꺼진 사이 지워졌다 (목록에 없다)
  const { app, page } = await launch(await tempDir('sync-enoent-userdata-2'));
  await install(app, path002);
  if (hold) await arm(app);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  if (hold) {
    await waitUntil(page, '초기 맞춤을 002의 stat 직전에 붙잡지 못했다', async () => (await state(app)).held, app);
    await chapter(page, 'Two').waitFor(); // 화 목록(별도 읽기)에는 002가 있다: 목록을 얻은 뒤의 지연이다
    assert.equal(await readFile(path002, 'utf8'), TWO);
  }
  return { app, page, dir, path002 };
}
const cleanup = async (app: ElectronApplication, page: Page) => {
  await release(app).catch(() => {});
  // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};

test('초기 맞춤이 002의 stat 직전에 멈춘 사이 002가 지워져도, 뒤의 정상 화(003) 색인이 맞춰지고 사라진 화는 제거된다', { timeout: 120_000 }, async () => {
  const { app, page, dir, path002 } = await start(true);
  try {
    await rm(path002); // 목록을 얻은 뒤 stat 전에 바깥에서 지워진다
    await release(app);
    // 맞춤이 (성공으로든 실패로든) 끝나야 검색이 열린다. 풀기 전에는 검색하지 않았다
    await waitUntil(page, '초기 맞춤이 끝나 검색이 열리지 않았다', async () => (await search(page, 'oneword')) === 1);
    assert.equal((await state(app)).returned, 1, '붙잡은 stat이 반환됐다');
    assert.equal(await search(page, 'newthreeword'), 1, '002의 ENOENT가 뒤의 정상 화(003)의 색인 맞춤을 막았다');
    assert.equal(await search(page, 'oldthreeword'), 0);
    assert.equal(await search(page, 'twoword'), 0, '사라진 화(002)가 색인에서 제거되지 않았다');
    assert.equal(await readFile(join(dir, 'chapters', '003.md'), 'utf8'), THREE_NEW, '원고 바이트는 그대로다');
  } finally {
    await cleanup(app, page);
  }
});

test('대조: 002가 앱이 꺼진 사이 지워졌다면(목록에 없음) 003이 맞춰지고 002가 제거된다', { timeout: 120_000 }, async () => {
  const { app, page } = await start(false);
  try {
    await waitUntil(page, '초기 맞춤이 끝나 검색이 열리지 않았다', async () => (await search(page, 'oneword')) === 1);
    assert.equal(await search(page, 'newthreeword'), 1);
    assert.equal(await search(page, 'twoword'), 0);
  } finally {
    await cleanup(app, page);
  }
});

test('초기 맞춤 뒤 수락한 입력은 그대로 저장되고 색인된다 (ENOENT 상황 뒤)', { timeout: 120_000 }, async () => {
  const { app, page, dir, path002 } = await start(true);
  try {
    await rm(path002);
    await release(app);
    await waitUntil(page, '초기 맞춤이 끝나 검색이 열리지 않았다', async () => (await search(page, 'oneword')) === 1);
    await chapter(page, 'One').click();
    await editor(page).getByText('oneword').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' mine');
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    await waitUntil(page, '저장한 글자가 색인에 반영되지 않았다', async () => (await search(page, 'mine')) === 1);
    assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), doc('one', 'One', 'Alpha oneword mine'));
  } finally {
    await cleanup(app, page);
  }
});
