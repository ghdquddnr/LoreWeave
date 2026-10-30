// watcher 알림 뒤 별도로 실행되는 검색 색인 갱신(reindexChapter) 두 개가 서로 다른 순서로 끝나도, 더 최신 바깥 변경(수정/삭제)이 색인에 반영된 뒤
// 먼저 시작한 옛 읽기가 색인을 옛 본문으로 되돌리지 않는지 본다. (watcher-read-order는 그 앞의 chapterHash 읽기 역전이다.)
// 장벽: 첫 이벤트의 색인 읽기(reindexChapter의 readFile)가 X1 바이트를 얻은 직후 반환만 붙잡는다.
//   한 이벤트에서 main은 chapterHash의 readFile → (같은 틱에서) renderer로 알림 + reindexChapter의 readFile 순으로 읽으므로, 같은 화의 두 번째 readFile이 색인 읽기다.
// 관측: 색인 갱신이 끝났는지는 검색 결과(실제 대상)로 본다. 옛 읽기를 푼 뒤에는 그 readFile 반환 직후 이어지는 색인 갱신(마이크로태스크)이 끝나도록 main에서 이벤트 루프를 한 번 돈다.
// 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const body = (text: string) => `﻿---\r\nid: one\r\ntitle: One\r\n---\r\n${text}\r\n`;
const ONE = body('Alpha originalword');
const X1 = body('Alpha firstword');
const X2 = body('Alpha secondword');

async function project(): Promise<string> {
  const dir = await tempDir('index-order');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  return dir;
}
const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const search = (page: Page, q: string) => page.evaluate(`window.loreweave.chapters.search(${JSON.stringify(q)}).then((r) => r.total)`) as Promise<number>;

type G = { skip: number; armed: boolean; held: boolean; holds: number; reads: number; release?: () => void };
/** armed이고 skip이 0이 된 같은 화의 readFile에서, 바이트를 얻은 직후 반환을 붙잡는다 (skip: 먼저 지나갈 읽기 수) */
async function install(app: ElectronApplication, target: string) {
  await app.evaluate((_e, target) => {
    const g = globalThis as unknown as G;
    g.skip = 0;
    g.armed = false;
    g.held = false;
    g.holds = 0;
    g.reads = 0;
    const fsp = process.getBuiltinModule('fs/promises');
    const readFile = fsp.readFile;
    fsp.readFile = (async (path: unknown, ...args: unknown[]) => {
      const mine = String(path) === target;
      if (mine) g.reads++;
      const bytes = await (readFile as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (mine && g.armed) {
        if (g.skip > 0) g.skip--;
        else {
          g.armed = false;
          g.holds++;
          g.held = true;
          await new Promise<void>((resolve) => (g.release = resolve));
          g.held = false;
        }
      }
      return bytes;
    }) as typeof fsp.readFile;
  }, target);
}
/** 다음 이벤트의 첫 읽기(chapterHash)는 지나가고 두 번째 읽기(색인)를 붙잡는다 */
const armIndexRead = (app: ElectronApplication) => app.evaluate(() => void Object.assign(globalThis as unknown as G, { armed: true, skip: 1 }));
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());
const state = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; return { held: g.held, holds: g.holds, reads: g.reads }; });
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, what);
}
const turn = (app: ElectronApplication) => app.evaluate(() => new Promise<void>((r) => setImmediate(r)));

async function start() {
  const dir = await project();
  const path = join(dir, 'chapters', '001.md');
  const { app, page } = await launch(await tempDir('index-order-userdata'));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await chapter(page, 'One').click();
  await editor(page).getByText('originalword').waitFor();
  await waitUntil(page, '처음 색인이 준비되지 않았다', async () => (await search(page, 'originalword')) === 1);
  await install(app, path);
  return { app, page, path };
}
const cleanup = async (app: ElectronApplication, page: Page) => {
  await release(app).catch(() => {});
  // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};

for (const kind of ['modify', 'delete'] as const) {
  test(`색인 읽기 역전 (${kind === 'modify' ? '수정' : '삭제'}): 더 최신 ${kind === 'modify' ? '수정 X2' : '삭제'}가 색인에 반영된 뒤 옛 색인 읽기(X1)가 늦게 끝나도 색인이 옛 본문으로 되돌아가지 않는다`, { timeout: 90_000 }, async () => {
    const { app, page, path } = await start();
    try {
      // 1) 첫 이벤트(X1): chapterHash는 지나가고 색인 읽기가 X1 바이트를 얻은 직후 반환이 붙잡힌다
      await armIndexRead(app);
      await writeFile(path, X1);
      await waitUntil(page, '첫 색인 읽기를 붙잡지 못했다', async () => (await state(app)).held);
      assert.equal((await state(app)).holds, 1);
      // 2) 더 최신 변경 (두 번째 이벤트의 색인 갱신은 붙잡히지 않는다): 검색 결과로 색인 반영을 확인한다
      if (kind === 'modify') {
        await writeFile(path, X2);
        await waitUntil(page, 'X2가 색인에 반영되지 않았다', async () => (await search(page, 'secondword')) === 1);
      } else {
        await rm(path);
        await waitUntil(page, '삭제가 색인에 반영되지 않았다', async () => (await search(page, 'originalword')) === 0);
      }
      assert.equal(await search(page, 'firstword'), 0, '옛 읽기는 아직 붙잡혀 있어 X1은 색인에 없다');
      assert.equal((await state(app)).held, true, '색인 읽기는 계속 붙잡혀 있다');
      // 3) 옛 읽기를 푼다: 반환 직후의 색인 갱신이 끝나도록 main의 이벤트 루프를 한 번 돈다
      await release(app);
      await waitUntil(page, '첫 색인 읽기가 반환되지 않았다', async () => !(await state(app)).held);
      await turn(app);
      const stale = await search(page, 'firstword');
      assert.equal(stale, 0, '옛 읽기(X1)가 색인을 옛 본문으로 되돌렸다');
      if (kind === 'modify') {
        assert.equal(await search(page, 'secondword'), 1);
        assert.equal(await readFile(path, 'utf8'), X2);
      } else {
        assert.equal(await search(page, 'originalword'), 0);
        await assert.rejects(readFile(path), /ENOENT/);
      }
    } finally {
      await cleanup(app, page);
    }
  });
}

test('색인 읽기 역전 뒤에도 정상 외부 변경과 저장 뒤 검색은 그대로 동작한다', { timeout: 90_000 }, async () => {
  const { app, page, path } = await start();
  try {
    await writeFile(path, X1); // 붙잡지 않은 정상 외부 변경
    await waitUntil(page, 'X1이 색인에 반영되지 않았다', async () => (await search(page, 'firstword')) === 1);
    await editor(page).getByText('firstword').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' mine');
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    await waitUntil(page, '저장한 글자가 색인에 반영되지 않았다', async () => (await search(page, 'mine')) === 1);
    assert.equal(await readFile(path, 'utf8'), body('Alpha firstword mine'));
  } finally {
    await cleanup(app, page);
  }
});
