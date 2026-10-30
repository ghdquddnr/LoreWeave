// 저장(chapter:write)이 성공한 뒤 저장 처리의 색인 갱신(stat → indexChapterText)이 끝나기 전에, 더 최신 바깥 수정/삭제가 watcher 경로로 먼저 색인에 반영되면
// 늦게 끝난 옛 저장의 색인 갱신이 저장 당시 본문으로 색인을 되돌리지 않는지 본다. (index-reindex-order는 watcher 색인끼리의 역전이다.)
// 장벽: 저장의 색인 stat이 값을 얻은 직후 반환만 붙잡는다 (writeChapter는 stat을 쓰지 않으므로 무장 뒤 그 화의 첫 stat이 저장의 색인 stat이다).
// 완료 관측: chapter:write 처리기(쓰기 + 색인 갱신까지 한 처리기다)가 끝나 값을 돌려주기 직전의 카운터(writeDone)를 쓴다. 호출 전 카운터만으로는 미완료일 수 있다.
// 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const body = (text: string) => `﻿---\r\nid: one\r\ntitle: One\r\n---\r\n${text}\r\n`;
const ONE = body('Alpha originalword');
const X2 = body('Alpha secondword');

async function project(): Promise<string> {
  const dir = await tempDir('save-index-order');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  return dir;
}
const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const alert = (page: Page) => page.getByRole('alert');
const search = (page: Page, q: string) => page.evaluate(`window.loreweave.chapters.search(${JSON.stringify(q)}).then((r) => r.total)`) as Promise<number>;

type G = { armed: boolean; statHeld: boolean; statReturned: number; writeCalls: number; writeDone: number; release?: () => void };
async function install(app: ElectronApplication, target: string) {
  await app.evaluate(({ ipcMain }, target) => {
    const g = globalThis as unknown as G;
    Object.assign(g, { armed: false, statHeld: false, statReturned: 0, writeCalls: 0, writeDone: 0 });
    const fsp = process.getBuiltinModule('fs/promises');
    const stat = fsp.stat;
    fsp.stat = (async (path: unknown, ...args: unknown[]) => {
      const hold = String(path) === target && g.armed;
      if (hold) g.armed = false; // 이 stat 하나만 붙잡는다
      const info = await (stat as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (hold) {
        g.statHeld = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        g.statHeld = false;
        g.statReturned++;
      }
      return info;
    }) as typeof fsp.stat;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('chapter:write')!;
    handlers.set('chapter:write', async (...args: unknown[]) => {
      g.writeCalls++;
      try {
        return await original(...args);
      } finally {
        g.writeDone++; // 쓰기와 색인 갱신까지 끝나 응답을 돌려주기 직전
      }
    });
  }, target);
}
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).armed = true));
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());
const state = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; return { statHeld: g.statHeld, statReturned: g.statReturned, writeCalls: g.writeCalls, writeDone: g.writeDone }; });
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, what);
}

async function start() {
  const dir = await project();
  const path = join(dir, 'chapters', '001.md');
  const { app, page } = await launch(await tempDir('save-index-order-userdata'));
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
  test(`저장 색인 역전 (${kind === 'modify' ? '수정' : '삭제'}): 저장 색인 stat이 늦는 동안 더 최신 바깥 ${kind === 'modify' ? '수정 X2' : '삭제'}가 색인되면, 옛 저장의 색인이 그 뒤 저장 본문으로 되돌리지 않는다`, { timeout: 90_000 }, async () => {
    const { app, page, path } = await start();
    try {
      // 1) 입력 A를 받아들이고 저장한다: 쓰기(rename)는 성공했고 색인 stat의 반환이 붙잡힌다
      await editor(page).getByText('originalword').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' mine');
      await arm(app);
      await page.keyboard.press('Control+S');
      await waitUntil(page, '저장의 색인 stat을 붙잡지 못했다', async () => (await state(app)).statHeld);
      assert.equal(await readFile(path, 'utf8'), body('Alpha originalword mine'), '저장은 이미 디스크에 성공했다');
      assert.equal((await state(app)).writeDone, 0, '저장 처리기는 아직 끝나지 않았다');
      // 2) 더 최신 바깥 변경: 실제 watcher 경로로 색인에 반영된다 (검색 결과로 확인)
      if (kind === 'modify') {
        await writeFile(path, X2);
        await waitUntil(page, 'X2가 색인에 반영되지 않았다', async () => (await search(page, 'secondword')) === 1);
      } else {
        await rm(path);
        await waitUntil(page, '삭제가 색인에 반영되지 않았다', async () => (await search(page, 'originalword')) === 0);
      }
      assert.equal(await search(page, 'mine'), 0, '옛 저장의 색인은 아직 붙잡혀 있다');
      await alert(page).waitFor({ timeout: 10_000 }); // 저장 중 도착한 바깥 변경 충돌 안내
      // 3) 옛 저장의 stat을 푼다. 저장 처리기(쓰기 + 색인 갱신)가 끝나 응답을 돌려줄 때까지 기다린다
      await release(app);
      await waitUntil(page, '저장 처리기가 끝나지 않았다', async () => {
        const s = await state(app);
        return s.statReturned === 1 && s.writeDone === 1;
      });
      assert.equal(await search(page, 'mine'), 0, '옛 저장이 저장 당시 본문으로 색인을 되돌렸다');
      if (kind === 'modify') {
        assert.equal(await search(page, 'secondword'), 1);
        assert.equal(await readFile(path, 'utf8'), X2);
      } else {
        assert.equal(await search(page, 'originalword'), 0);
        await assert.rejects(readFile(path), /ENOENT/);
      }
      // 수락한 입력과 충돌 안내가 남는다
      assert.equal(await alert(page).count(), 1, '충돌 안내가 사라졌다');
      assert.equal(await editor(page).getByText('Alpha originalword mine', { exact: true }).count(), 1, '수락한 입력이 화면에 남아야 한다');
    } finally {
      await cleanup(app, page);
    }
  });
}

test('정상 저장과 이후 외부 변경은 색인에 그대로 반영된다', { timeout: 90_000 }, async () => {
  const { app, page, path } = await start();
  try {
    await editor(page).getByText('originalword').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' mine');
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    await waitUntil(page, '저장한 글자가 색인에 반영되지 않았다', async () => (await search(page, 'mine')) === 1);
    assert.equal(await readFile(path, 'utf8'), body('Alpha originalword mine'));
    await writeFile(path, X2);
    await waitUntil(page, '이후 외부 변경이 색인에 반영되지 않았다', async () => (await search(page, 'secondword')) === 1 && (await search(page, 'mine')) === 0);
  } finally {
    await cleanup(app, page);
  }
});
