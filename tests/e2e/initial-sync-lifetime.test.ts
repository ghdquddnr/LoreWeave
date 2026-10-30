// 프로젝트 A의 초기 색인 맞춤(syncIndex)이 다음 화를 처리하기 직전에 멈춘 채 프로젝트 B가 열리고 B의 작업이 진행되는 동안, 나중에 풀린 A의 옛 작업이
// B의 색인 작업(같은 파일 이름이면 같은 화별 표)이나 색인 상태에 관여하지 않는지 본다. (stale-watcher는 watcher의 세대, initial-sync-order는 같은 프로젝트의 색인 작업 순서다.)
// 장벽: A의 초기 맞춤이 2번째 화(002.md)의 stat(변경 비교)이 값을 얻은 직후 반환을 붙잡고, B에서는 저장의 색인 stat 반환을 붙잡는다.
// 같은 파일 이름(002.md)에 서로 다른 내용을 쓴다. 검색은 indexReady를 기다리므로 A를 붙잡은 채로는 B가 열린 뒤에만 쓴다 (B의 색인은 새로 만들어진다).
// 완료 관측: A의 풀린 작업은 002.md의 readFile·stat(색인 읽기)이 반환되고 main 이벤트 루프를 한 번 돈 뒤(쓰기/skip/실패 처리가 끝난 뒤), B의 저장은 chapter:write 처리기 종료 직전 카운터(writeDone)로 본다.
// 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const doc = (id: string, title: string, text: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n${text}\r\n`;

async function project(prefix: string, files: Record<string, string>): Promise<string> {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  for (const [f, text] of Object.entries(files)) await writeFile(join(dir, 'chapters', f), text);
  return dir;
}
const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const search = (page: Page, q: string) => page.evaluate(`window.loreweave.chapters.search(${JSON.stringify(q)}).then((r) => r.total)`) as Promise<number>;

type Slot = { armed: boolean; held: boolean; reads: number; stats: number; returned: number; release?: () => void };
type G = { a: Slot; b: Slot; pathA: string; pathB: string; writeDone: number };
async function install(app: ElectronApplication, pathA: string, pathB: string) {
  await app.evaluate(({ ipcMain }, [pathA, pathB]) => {
    const g = globalThis as unknown as G;
    g.a = { armed: false, held: false, reads: 0, stats: 0, returned: 0 };
    g.b = { armed: false, held: false, reads: 0, stats: 0, returned: 0 };
    g.pathA = pathA as string;
    g.pathB = pathB as string;
    g.writeDone = 0;
    const fsp = process.getBuiltinModule('fs/promises');
    const readFile = fsp.readFile;
    fsp.readFile = (async (path: unknown, ...args: unknown[]) => {
      const slot = String(path) === g.pathA ? g.a : String(path) === g.pathB ? g.b : null;
      const bytes = await (readFile as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (slot) slot.reads++;
      return bytes;
    }) as typeof fsp.readFile;
    const stat = fsp.stat;
    fsp.stat = (async (path: unknown, ...args: unknown[]) => {
      const slot = String(path) === g.pathA ? g.a : String(path) === g.pathB ? g.b : null;
      const hold = !!slot && slot.armed;
      if (hold) slot.armed = false; // 이 stat 하나만 붙잡는다
      const info = await (stat as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (slot) {
        if (hold) {
          slot.held = true;
          await new Promise<void>((resolve) => (slot.release = resolve));
          slot.held = false;
          slot.returned++;
        } else slot.stats++;
      }
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
  }, [pathA, pathB]);
}
const arm = (app: ElectronApplication, which: 'a' | 'b') => app.evaluate((_e, which) => void ((globalThis as unknown as G)[which].armed = true), which);
const release = (app: ElectronApplication, which: 'a' | 'b') => app.evaluate((_e, which) => (globalThis as unknown as G)[which].release?.(), which);
const state = (app: ElectronApplication) =>
  app.evaluate(() => {
    const g = globalThis as unknown as G;
    return { aHeld: g.a.held, aReads: g.a.reads, aStats: g.a.stats, aReturned: g.a.returned, bHeld: g.b.held, bReturned: g.b.returned, writeDone: g.writeDone };
  });
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>, app?: ElectronApplication) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, app ? `${what} ${JSON.stringify(await state(app))}` : what);
}
const turn = (app: ElectronApplication) => app.evaluate(() => new Promise<void>((r) => setImmediate(r)));

test('A의 초기 색인 맞춤이 다음 화 직전에 멈춘 채 B가 열려도, 풀린 A의 옛 작업이 B의 저장 색인과 색인 상태에 관여하지 않는다', { timeout: 120_000 }, async () => {
  const A = await project('sync-life-A', { '001.md': doc('a1', 'A One', 'alpha one'), '002.md': doc('a2', 'A Two', 'alphaword') });
  const B = await project('sync-life-B', { '001.md': doc('b1', 'B One', 'beta one'), '002.md': doc('b2', 'B Two', 'betaword') });
  const pathA = join(A, 'chapters', '002.md');
  const pathB = join(B, 'chapters', '002.md');
  const { app, page } = await launch(await tempDir('sync-life-userdata'));
  try {
    await install(app, pathA, pathB);
    // 1) A를 연다: 초기 맞춤이 1번째 화를 처리하고 002.md의 stat(변경 비교)이 값을 얻은 직후 반환이 붙잡힌다
    await arm(app, 'a');
    await stubFolderDialog(app, A);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await waitUntil(page, 'A의 초기 맞춤을 다음 화 직전에 붙잡지 못했다', async () => (await state(app)).aHeld, app);
    await chapter(page, 'A One').waitFor();
    // 2) B를 연다 (A의 맞춤은 아직 붙잡혀 있다): B의 새 색인이 만들어지고 검색이 열린다
    await stubFolderDialog(app, B);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await chapter(page, 'B Two').waitFor();
    await waitUntil(page, 'B의 초기 색인이 반영되지 않았다', async () => (await search(page, 'betaword')) === 1);
    assert.equal(await search(page, 'alphaword'), 0, 'B의 색인에 A의 본문이 없다');
    // 3) B에서 입력을 받아들이고 저장한다: 쓰기는 성공하고 저장 색인 stat 반환이 붙잡힌다
    await chapter(page, 'B Two').click();
    await editor(page).getByText('betaword').waitFor();
    await editor(page).getByText('betaword').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' mine');
    await arm(app, 'b');
    const done = (await state(app)).writeDone;
    await page.keyboard.press('Control+S');
    await waitUntil(page, 'B 저장의 색인 stat을 붙잡지 못했다', async () => (await state(app)).bHeld, app);
    assert.equal(await readFile(pathB, 'utf8'), doc('b2', 'B Two', 'betaword mine'), 'B의 쓰기는 이미 성공했다');
    // 4) A의 붙잡힌 맞춤을 푼다: A의 002.md 색인 읽기(readFile·stat)가 반환되고 main 이벤트 루프를 한 번 돈 뒤 (쓰기·skip·실패 처리가 끝난 뒤)
    const before = await state(app);
    await release(app, 'a');
    await waitUntil(page, 'A의 풀린 작업(002.md 읽기)이 끝나지 않았다', async () => {
      const s = await state(app);
      return s.aReads > before.aReads && s.aStats > before.aStats;
    }, app);
    await turn(app);
    // 5) B의 저장 색인 stat을 푼다: B 저장 처리(쓰기+색인)가 끝날 때까지 기다린다
    await release(app, 'b');
    await waitUntil(page, 'B 저장 처리가 끝나지 않았다', async () => (await state(app)).writeDone === done + 1, app);
    await turn(app);
    // 6) B의 최종 상태: 검색 오류 없이 최신 저장 본문이 색인에 있고, A의 본문은 없다
    assert.equal(await search(page, 'mine'), 1, 'A의 옛 작업이 B의 저장 색인을 막았다');
    assert.equal(await search(page, 'betaword'), 1);
    assert.equal(await search(page, 'alphaword'), 0, 'B의 색인에 A의 본문이 들어갔다');
    assert.equal(await readFile(pathB, 'utf8'), doc('b2', 'B Two', 'betaword mine'));
    assert.equal(await readFile(pathA, 'utf8'), doc('a2', 'A Two', 'alphaword'), 'A의 원고는 바뀌지 않는다');
    assert.equal(await editor(page).getByText('betaword mine', { exact: true }).count(), 1, '수락한 입력이 화면에 남아야 한다');
    assert.equal(await page.getByRole('alert').count(), 0, '충돌 안내가 없어야 한다');
  } finally {
    await release(app, 'a').catch(() => {});
    await release(app, 'b').catch(() => {});
    // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});
