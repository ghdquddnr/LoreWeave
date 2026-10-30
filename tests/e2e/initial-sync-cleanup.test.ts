// 폴더를 열 때의 초기 색인 맞춤(syncIndex)은 시작할 때 색인 목록(index.chapters())과 폴더 목록을 잡아 두었다가 끝에서 "색인에는 있고 폴더에는 없던" 화를 색인에서 뺀다.
// 그 사이 같은 화 파일이 새 내용으로 다시 만들어져 watcher가 최신 본문을 색인했다면, 끝의 정리가 그 최신 색인을 지우지 않는지 본다.
// (initial-sync-order는 읽기 중인 화, initial-sync-lifetime은 프로젝트 전환이다. 여기는 사라진 화의 정리 단계다.)
// 준비: 앱 1에서 001·002를 열어 색인한 뒤 닫고, 바깥에서 002를 지우고, 앱 2(새 userdata)에서 다시 연다. 색인 DB는 폴더의 .loreweave에 남아 있어 002가 색인에만 있다.
// 장벽: 초기 맞춤이 001의 stat(변경 비교)이 값을 얻은 직후 반환을 붙잡는다 (002는 목록에 없어 정리 단계로 가기 전에 멈춘다).
// 풀기 전에는 검색하지 않는다 (검색은 indexReady를 기다린다). 풀기 전 완료 관측: 새 002의 watcher 색인은 그 readFile·stat이 반환됐음을 보는 카운터와 main 이벤트 루프 한 번.
// 풀고 나면 초기 맞춤 전체가 끝난 뒤(검색이 열린 뒤)의 최종 검색을 본다.
// 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const doc = (id: string, title: string, text: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n${text}\r\n`;
const ONE = doc('one', 'One', 'Alpha oneword');
const TWO_OLD = doc('two', 'Two', 'Beta oldtwoword');
const TWO_NEW = doc('two', 'Two', 'Beta newtwoword');

const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const search = (page: Page, q: string) => page.evaluate(`window.loreweave.chapters.search(${JSON.stringify(q)}).then((r) => r.total)`) as Promise<number>;

type G = { armed: boolean; held: boolean; returned: number; reads: number; stats: number; release?: () => void };
async function install(app: ElectronApplication, path001: string, path002: string) {
  await app.evaluate((_e, [path001, path002]) => {
    const g = globalThis as unknown as G & { p1: string; p2: string };
    Object.assign(g, { armed: false, held: false, returned: 0, reads: 0, stats: 0, p1: path001, p2: path002 });
    const fsp = process.getBuiltinModule('fs/promises');
    const readFile = fsp.readFile;
    fsp.readFile = (async (path: unknown, ...args: unknown[]) => {
      const bytes = await (readFile as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (String(path) === g.p2) g.reads++;
      return bytes;
    }) as typeof fsp.readFile;
    const stat = fsp.stat;
    fsp.stat = (async (path: unknown, ...args: unknown[]) => {
      const hold = String(path) === g.p1 && g.armed;
      if (hold) g.armed = false; // 001의 stat 하나만 붙잡는다
      const info = await (stat as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (hold) {
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        g.held = false;
        g.returned++;
      } else if (String(path) === g.p2) g.stats++;
      return info;
    }) as typeof fsp.stat;
  }, [path001, path002]);
}
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).armed = true));
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());
const state = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; return { held: g.held, returned: g.returned, reads: g.reads, stats: g.stats }; });
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>, app?: ElectronApplication) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, app ? `${what} ${JSON.stringify(await state(app))}` : what);
}
const turn = (app: ElectronApplication) => app.evaluate(() => new Promise<void>((r) => setImmediate(r)));

/** 앱 1에서 001·002를 색인하고 닫은 뒤 002를 지우고, 앱 2를 열어 초기 맞춤이 001의 stat에서 붙잡힌 상태까지 */
async function start() {
  const dir = await tempDir('sync-cleanup');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO_OLD);
  const first = await launch(await tempDir('sync-cleanup-userdata-1'));
  try {
    await stubFolderDialog(first.app, dir);
    await first.page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await chapter(first.page, 'One').waitFor(); // 폴더가 열린 뒤에야 검색할 수 있다
    await waitUntil(first.page, '앱 1에서 002가 색인되지 않았다', async () => (await search(first.page, 'oldtwoword')) === 1);
    assert.equal(await search(first.page, 'oneword'), 1);
  } finally {
    await closeWindow(first.app);
  }
  const path001 = join(dir, 'chapters', '001.md');
  const path002 = join(dir, 'chapters', '002.md');
  await rm(path002); // 앱이 꺼진 사이 바깥에서 지워졌다 (색인에만 남아 있다)
  const { app, page } = await launch(await tempDir('sync-cleanup-userdata-2'));
  await install(app, path001, path002);
  await arm(app);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await waitUntil(page, '초기 맞춤을 정리 단계 앞에서 붙잡지 못했다', async () => (await state(app)).held, app);
  await chapter(page, 'One').waitFor();
  assert.equal(await chapter(page, 'Two').count(), 0, '초기 목록에는 002가 없다');
  return { app, page, dir, path002 };
}
const cleanup = async (app: ElectronApplication, page: Page) => {
  await release(app).catch(() => {});
  // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};

test('초기 맞춤 정리 단계 앞에서 멈춘 사이 002가 새 내용으로 다시 만들어지면, 정리가 watcher의 최신 색인을 지우지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, path002 } = await start();
  try {
    // 002를 새 내용으로 다시 만든다: 실제 watcher가 그 색인(readFile+stat, 붙잡히지 않는다)을 끝낼 때까지 기다린 뒤 이벤트 루프를 한 번 돈다
    const before = await state(app);
    await writeFile(path002, TWO_NEW);
    await waitUntil(page, '새 002의 watcher 색인 읽기(readFile+stat)가 끝나지 않았다', async () => {
      const s = await state(app);
      return s.reads >= before.reads + 2 && s.stats > before.stats; // chapterHash 읽기 + 색인 읽기
    }, app);
    await turn(app);
    assert.equal((await state(app)).held, true, '초기 맞춤은 아직 정리 단계 앞에서 붙잡혀 있다');
    // 초기 맞춤을 풀면 전체가 끝나 검색이 열린다
    await release(app);
    await waitUntil(page, '초기 맞춤이 끝나 검색이 열리지 않았다', async () => (await search(page, 'oneword')) === 1);
    assert.equal(await search(page, 'newtwoword'), 1, '정리가 다시 만들어진 002의 최신 색인을 지웠다');
    assert.equal(await search(page, 'oldtwoword'), 0);
    assert.equal(await readFile(path002, 'utf8'), TWO_NEW, '원고 바이트는 그대로다');
    assert.equal(await page.getByRole('alert').count(), 0, '충돌 안내가 없어야 한다');
  } finally {
    await cleanup(app, page);
  }
});

test('대조: 002가 다시 만들어지지 않으면 초기 맞춤이 사라진 화를 색인에서 정상적으로 뺀다', { timeout: 120_000 }, async () => {
  const { app, page } = await start();
  try {
    await release(app);
    await waitUntil(page, '초기 맞춤이 끝나 검색이 열리지 않았다', async () => (await search(page, 'oneword')) === 1);
    assert.equal(await search(page, 'oldtwoword'), 0, '사라진 화가 색인에서 빠지지 않았다');
  } finally {
    await cleanup(app, page);
  }
});

test('초기 맞춤이 끝난 뒤의 수락한 입력은 그대로 저장되고 색인된다', { timeout: 120_000 }, async () => {
  const { app, page, path002 } = await start();
  try {
    await release(app);
    await waitUntil(page, '초기 맞춤이 끝나 검색이 열리지 않았다', async () => (await search(page, 'oneword')) === 1);
    await chapter(page, 'One').click();
    await editor(page).getByText('oneword').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' mine');
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    await waitUntil(page, '저장한 글자가 색인에 반영되지 않았다', async () => (await search(page, 'mine')) === 1);
    assert.equal(await readFile(join(path002, '..', '001.md'), 'utf8'), doc('one', 'One', 'Alpha oneword mine'));
  } finally {
    await cleanup(app, page);
  }
});
