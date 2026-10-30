// watcher 알림 뒤 별도로 실행되는 검색 색인 갱신(reindexChapter) 두 개가 서로 다른 순서로 끝나도, 더 최신 바깥 변경(수정/삭제)이 색인에 반영된 뒤
// 먼저 시작한 옛 읽기가 색인을 옛 본문으로 되돌리지 않는지 본다. (watcher-read-order는 그 앞의 chapterHash 읽기 역전이다.)
// 장벽: reindexChapter는 Promise.all([readFile, stat])을 기다린다. 첫 이벤트의 색인 읽기에서 두 호출을 모두 통제한다.
//   한 이벤트에서 main은 chapterHash의 readFile → (같은 틱에서) 색인의 readFile과 stat 순으로 호출하므로, skip=1로 chapterHash를 지나보내면 다음 readFile+stat이 색인 읽기다.
// 완료 관측: 해제 뒤에는 readFile과 stat이 모두 호출자에게 반환됐음을 반환 직전의 카운터로 확인한 다음 main의 이벤트 루프를 한 번 돈다.
//   reindexChapter는 두 호출이 끝난 뒤 마이크로태스크(동기 처리)만 남으므로, 그때는 setImmediate 전에 그 갱신(쓰기 또는 skip)이 끝나 있다.
//   (readFile만 반환된 상태에서는 stat이 안 끝났을 수 있어 이 보장이 없다.) ENOENT 경로는 readFile의 거절로 Promise.all이 곧바로 끝난다.
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

type G = {
  mode: 'off' | 'after-read' | 'enoent';
  skip: number;
  statPending: boolean;
  held: boolean;
  statHeld: boolean;
  readReturned: number;
  statReturned: number;
  release?: () => void;
  statRelease?: () => void;
};
/**
 * after-read: 색인 읽기의 readFile이 바이트를 얻은 직후, 그 stat이 끝난 직후, 각각 반환을 붙잡는다 (옛 바이트를 얻은 채 둘 다 늦게 끝난다)
 * enoent: 색인 읽기의 readFile을 읽기 전에 붙잡았다가, 풀 때 ENOENT로 실패시킨다 (옛 읽기가 파일이 없다고 본다)
 * readReturned/statReturned는 그 호출이 호출자에게 반환되기 직전에 오른다.
 */
async function install(app: ElectronApplication, target: string) {
  await app.evaluate((_e, target) => {
    const g = globalThis as unknown as G;
    Object.assign(g, { mode: 'off', skip: 0, statPending: false, held: false, statHeld: false, readReturned: 0, statReturned: 0 });
    const fsp = process.getBuiltinModule('fs/promises');
    const readFile = fsp.readFile;
    fsp.readFile = (async (path: unknown, ...args: unknown[]) => {
      // 붙잡을 읽기인지는 호출 때 동기적으로 정한다 (같은 화의 다른 읽기와 섞이지 않게)
      let hold = false;
      const mode = g.mode;
      if (String(path) === target && g.mode !== 'off') {
        if (g.skip > 0) g.skip--;
        else {
          hold = true;
          g.statPending = mode === 'after-read'; // 바로 뒤이어 호출되는 같은 reindexChapter의 stat을 붙잡는다
          g.mode = 'off'; // 이 읽기 하나만 붙잡는다 (뒤이은 이벤트의 읽기는 지나간다)
        }
      }
      if (hold && mode === 'enoent') {
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        g.held = false;
        throw Object.assign(new Error('ENOENT: no such file or directory, open'), { code: 'ENOENT' });
      }
      const bytes = await (readFile as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (hold) {
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        g.held = false;
        g.readReturned++;
      }
      return bytes;
    }) as typeof fsp.readFile;
    const stat = fsp.stat;
    fsp.stat = (async (path: unknown, ...args: unknown[]) => {
      const hold = String(path) === target && g.statPending;
      if (hold) g.statPending = false;
      const info = await (stat as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (hold) {
        g.statHeld = true;
        await new Promise<void>((resolve) => (g.statRelease = resolve));
        g.statHeld = false;
        g.statReturned++;
      }
      return info;
    }) as typeof fsp.stat;
  }, target);
}
/** 다음 이벤트의 첫 readFile(chapterHash)은 지나가고, 그 다음 색인 읽기(와 stat)를 붙잡는다 */
const arm = (app: ElectronApplication, mode: 'after-read' | 'enoent') => app.evaluate((_e, mode) => void Object.assign(globalThis as unknown as G, { mode, skip: 1 }), mode);
const releaseAll = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; g.release?.(); g.statRelease?.(); });
const state = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; return { held: g.held, statHeld: g.statHeld, readReturned: g.readReturned, statReturned: g.statReturned }; });
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
  await releaseAll(app).catch(() => {});
  // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};

for (const kind of ['modify', 'delete'] as const) {
  test(`색인 읽기 역전 (${kind === 'modify' ? '수정' : '삭제'}): 더 최신 ${kind === 'modify' ? '수정 X2' : '삭제'}가 색인에 반영된 뒤 옛 색인 읽기(X1)가 늦게 끝나도 색인이 옛 본문으로 되돌아가지 않는다`, { timeout: 90_000 }, async () => {
    const { app, page, path } = await start();
    try {
      // 1) 첫 이벤트(X1): chapterHash는 지나가고, 색인의 readFile(X1 바이트를 얻은 뒤)과 stat이 모두 붙잡힌다
      await arm(app, 'after-read');
      await writeFile(path, X1);
      await waitUntil(page, '첫 색인 읽기(readFile+stat)를 붙잡지 못했다', async () => {
        const s = await state(app);
        return s.held && s.statHeld;
      });
      // 2) 더 최신 변경 (두 번째 이벤트의 색인 갱신은 붙잡히지 않는다): 검색 결과로 색인 반영을 확인한다
      if (kind === 'modify') {
        await writeFile(path, X2);
        await waitUntil(page, 'X2가 색인에 반영되지 않았다', async () => (await search(page, 'secondword')) === 1);
      } else {
        await rm(path);
        await waitUntil(page, '삭제가 색인에 반영되지 않았다', async () => (await search(page, 'originalword')) === 0);
      }
      assert.equal(await search(page, 'firstword'), 0, '옛 읽기는 아직 붙잡혀 있어 X1은 색인에 없다');
      // 3) 두 호출을 모두 풀고, 둘 다 호출자에게 반환된 것을 확인한 뒤 main의 이벤트 루프를 한 번 돈다
      await releaseAll(app);
      await waitUntil(page, 'readFile과 stat이 모두 반환되지 않았다', async () => {
        const s = await state(app);
        return s.readReturned === 1 && s.statReturned === 1;
      });
      await turn(app);
      assert.equal(await search(page, 'firstword'), 0, '옛 읽기(X1)가 색인을 옛 본문으로 되돌렸다');
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

test('색인 읽기 역전 (ENOENT): 옛 색인 읽기가 파일이 없다고 실패해도, 더 최신 X2 색인을 지우지 않는다', { timeout: 90_000 }, async () => {
  const { app, page, path } = await start();
  try {
    // 첫 이벤트(X1)의 색인 readFile은 읽기 전에 붙잡힌다 (풀 때 ENOENT로 실패한다)
    await arm(app, 'enoent');
    await writeFile(path, X1);
    await waitUntil(page, '첫 색인 읽기를 붙잡지 못했다', async () => (await state(app)).held);
    await writeFile(path, X2);
    await waitUntil(page, 'X2가 색인에 반영되지 않았다', async () => (await search(page, 'secondword')) === 1);
    // 풀면 readFile이 거절되고 Promise.all이 곧바로 끝나 catch가 실행된다. 이벤트 루프를 한 번 돈 뒤에는 그 처리가 끝나 있다
    await releaseAll(app);
    await waitUntil(page, '옛 읽기가 풀리지 않았다', async () => !(await state(app)).held);
    await turn(app);
    assert.equal(await search(page, 'secondword'), 1, '옛 읽기의 ENOENT가 더 최신 색인을 지웠다');
    assert.equal(await readFile(path, 'utf8'), X2);
  } finally {
    await cleanup(app, page);
  }
});

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
