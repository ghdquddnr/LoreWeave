// 폴더를 열 때 시작하는 초기 색인 맞춤(syncIndex)의 읽기가 늦게 끝나도, 그 사이에 일어난 저장(저장 처리의 색인)이나 바깥 수정(watcher 색인)이
// 색인에 반영한 더 최신 본문을 옛 바이트로 되돌리지 않는지 본다. (index-reindex-order/save-index-order/watcher-index-vs-save는 열린 뒤의 색인 작업끼리의 순서다.)
// 장벽: 초기 색인 맞춤의 reindexChapter는 readFile과 stat을 같은 틱에서 호출한다 (Promise.all). 그 짝을 같은 틱의 인접 호출로 알아보고
//   (화 목록을 읽는 readFile이나 화면의 readFile은 stat이 뒤따르지 않는다) readFile이 바이트를 얻은 직후와 stat이 값을 얻은 직후 반환을 각각 붙잡는다.
// 검색은 indexReady(초기 맞춤)를 기다리므로 풀기 전에는 검색하지 않는다. 풀기 전의 완료 관측은 대상 처리 자체의 신호를 쓴다:
//   저장은 chapter:write 처리기(쓰기+색인)가 끝나기 직전의 카운터(writeDone), watcher 색인은 그 readFile·stat이 반환됐음을 보는 카운터(plainReads, statPlain)와 main 이벤트 루프 한 번.
// 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const body = (text: string) => `﻿---\r\nid: one\r\ntitle: One\r\n---\r\n${text}\r\n`;
const ONE = body('Alpha originalword');
const X2 = body('Alpha secondword');

async function project(): Promise<string> {
  const dir = await tempDir('initial-sync');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  return dir;
}
const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const search = (page: Page, q: string) => page.evaluate(`window.loreweave.chapters.search(${JSON.stringify(q)}).then((r) => r.total)`) as Promise<number>;

type G = {
  initArm: boolean;
  tickCall: number;
  readCalls: number;
  holdCall: number;
  held: boolean;
  statHeld: boolean;
  readReturned: number;
  statReturned: number;
  plainReads: number;
  statPlain: number;
  writeDone: number;
  release?: () => void;
  statRelease?: () => void;
};
async function install(app: ElectronApplication, target: string) {
  await app.evaluate(({ ipcMain }, target) => {
    const g = globalThis as unknown as G;
    Object.assign(g, { initArm: false, tickCall: 0, readCalls: 0, holdCall: 0, held: false, statHeld: false, readReturned: 0, statReturned: 0, plainReads: 0, statPlain: 0, writeDone: 0 });
    const fsp = process.getBuiltinModule('fs/promises');
    const readFile = fsp.readFile;
    fsp.readFile = (async (path: unknown, ...args: unknown[]) => {
      const mine = String(path) === target;
      let call = 0;
      if (mine) {
        call = ++g.readCalls;
        g.tickCall = call; // 같은 틱에서 stat이 뒤따르는지 알아보기 위한 표지
        queueMicrotask(() => {
          if (g.tickCall === call) g.tickCall = 0;
        });
      }
      const bytes = await (readFile as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (mine && g.holdCall === call) {
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        g.held = false;
        g.readReturned++;
      } else if (mine) g.plainReads++;
      return bytes;
    }) as typeof fsp.readFile;
    const stat = fsp.stat;
    fsp.stat = (async (path: unknown, ...args: unknown[]) => {
      const mine = String(path) === target;
      // readFile과 같은 틱에 호출된 stat이면 reindexChapter의 짝이다: 그 readFile과 이 stat을 한 번만 붙잡는다
      const hold = mine && g.initArm && g.tickCall !== 0;
      if (hold) {
        g.initArm = false;
        g.holdCall = g.tickCall;
      }
      const info = await (stat as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (hold) {
        g.statHeld = true;
        await new Promise<void>((resolve) => (g.statRelease = resolve));
        g.statHeld = false;
        g.statReturned++;
      } else if (mine) g.statPlain++;
      return info;
    }) as typeof fsp.stat;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('chapter:write')!;
    handlers.set('chapter:write', async (...args: unknown[]) => {
      try {
        return await original(...args);
      } finally {
        g.writeDone++; // 쓰기와 색인 갱신까지 끝나 응답을 돌려주기 직전
      }
    });
  }, target);
}
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).initArm = true));
const releaseInitial = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; g.release?.(); g.statRelease?.(); });
const state = (app: ElectronApplication) =>
  app.evaluate(() => { const g = globalThis as unknown as G; return { held: g.held, statHeld: g.statHeld, readReturned: g.readReturned, statReturned: g.statReturned, plainReads: g.plainReads, statPlain: g.statPlain, writeDone: g.writeDone }; });
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>, app?: ElectronApplication) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, app ? `${what} ${JSON.stringify(await state(app))}` : what);
}
const turn = (app: ElectronApplication) => app.evaluate(() => new Promise<void>((r) => setImmediate(r)));

/** 초기 색인 맞춤의 읽기를 붙잡은 채로 폴더가 열리고 화면이 뜬 상태까지 */
async function start() {
  const dir = await project();
  const path = join(dir, 'chapters', '001.md');
  const { app, page } = await launch(await tempDir('initial-sync-userdata'));
  await install(app, path);
  await arm(app);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await waitUntil(page, '초기 색인 맞춤의 읽기(readFile+stat)를 붙잡지 못했다', async () => {
    const s = await state(app);
    return s.held && s.statHeld;
  }, app);
  await chapter(page, 'One').click(); // 초기 맞춤이 끝나지 않았어도 폴더는 열리고 화를 열 수 있다
  await editor(page).getByText('originalword').waitFor();
  return { app, page, path };
}
const cleanup = async (app: ElectronApplication, page: Page) => {
  await releaseInitial(app).catch(() => {});
  // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};
const releaseAndWait = async (app: ElectronApplication, page: Page) => {
  await releaseInitial(app);
  await waitUntil(page, '초기 읽기(readFile+stat)가 반환되지 않았다', async () => {
    const s = await state(app);
    return s.readReturned === 1 && s.statReturned === 1;
  }, app);
  await turn(app); // 두 호출이 끝난 뒤 남은 동기 처리(색인 쓰기 또는 skip)가 끝난다
};

test('초기 색인 맞춤의 늦은 읽기 vs 그 뒤 저장: 저장 색인(최신 본문)이 옛 초기 읽기로 덮이지 않는다', { timeout: 90_000 }, async () => {
  const { app, page, path } = await start();
  try {
    await editor(page).getByText('originalword').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' mine');
    const done = (await state(app)).writeDone;
    await page.keyboard.press('Control+S');
    await waitUntil(page, '저장 처리(쓰기+색인)가 끝나지 않았다', async () => (await state(app)).writeDone === done + 1, app);
    assert.equal(await readFile(path, 'utf8'), body('Alpha originalword mine'));
    assert.equal((await state(app)).held, true, '초기 읽기는 아직 붙잡혀 있다');
    await releaseAndWait(app, page);
    // 초기 맞춤이 끝났으므로 검색이 열린다. 자기 쓰기 이벤트(debounce)도 처리돼 억제된 뒤의 상태를 본다
    await waitUntil(page, '검색이 열리지 않았다', async () => (await search(page, 'Alpha')) >= 0);
    const reads = (await state(app)).plainReads;
    await waitUntil(page, '자기 쓰기 이벤트의 해시 읽기가 끝나지 않았다', async () => (await state(app)).plainReads > reads, app);
    await turn(app);
    assert.equal(await search(page, 'mine'), 1, '옛 초기 읽기가 저장 색인을 덮었다');
    assert.equal(await readFile(path, 'utf8'), body('Alpha originalword mine'));
    assert.equal(await editor(page).getByText('Alpha originalword mine', { exact: true }).count(), 1, '수락한 입력이 화면에 남아야 한다');
    assert.equal(await page.getByRole('alert').count(), 0, '충돌 안내가 없어야 한다');
  } finally {
    await cleanup(app, page);
  }
});

test('초기 색인 맞춤의 늦은 읽기 vs 그 뒤 바깥 수정: watcher 색인(최신 본문)이 옛 초기 읽기로 덮이지 않는다', { timeout: 90_000 }, async () => {
  const { app, page, path } = await start();
  try {
    // 바깥 수정 X2: watcher 색인의 readFile·stat(붙잡히지 않는다)이 반환될 때까지 기다린 뒤 이벤트 루프를 한 번 돈다
    const before = await state(app);
    await writeFile(path, X2);
    await waitUntil(page, 'watcher 색인 읽기(readFile+stat)가 끝나지 않았다', async () => {
      const s = await state(app);
      return s.plainReads >= before.plainReads + 2 && s.statPlain > before.statPlain; // chapterHash 읽기 + 색인 읽기
    }, app);
    await turn(app);
    assert.equal((await state(app)).held, true, '초기 읽기는 아직 붙잡혀 있다');
    await releaseAndWait(app, page);
    await waitUntil(page, '검색이 열리지 않았다', async () => (await search(page, 'Alpha')) >= 0);
    assert.equal(await search(page, 'secondword'), 1, '옛 초기 읽기가 바깥 수정 색인을 덮었다');
    assert.equal(await search(page, 'originalword'), 0);
    assert.equal(await readFile(path, 'utf8'), X2);
    await editor(page).getByText('secondword').waitFor({ timeout: 10_000 }); // 깨끗한 에디터는 바깥 수정을 불러온다
  } finally {
    await cleanup(app, page);
  }
});

test('초기 색인 맞춤은 아무 일도 없었다면 그대로 색인한다', { timeout: 90_000 }, async () => {
  const { app, page } = await start();
  try {
    await releaseAndWait(app, page);
    await waitUntil(page, '초기 색인이 반영되지 않았다', async () => (await search(page, 'originalword')) === 1);
  } finally {
    await cleanup(app, page);
  }
});
