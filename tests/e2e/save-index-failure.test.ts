// 저장이 성공한 뒤 저장 처리의 색인 갱신(stat → indexChapterText)만 실패하면, 색인에는 옛 본문이 남고 새로 저장한 글자가 빠진다. 이때 검색이 그 오래된 색인을
// 정상 결과로 답하는지(오류도 없이) 본다. (initial-sync-eacces는 초기 맞춤의 실패, save-index-order는 갱신의 순서다.)
// 준비: 초기 맞춤이 정상 완료된 합성 폴더. 저장 직후 색인용 stat 하나에만 EACCES를 던진다 (writeChapter는 stat을 쓰지 않는다. 화 목록·읽기·watcher 해시 읽기는 건드리지 않는다).
// 관측: chapter:write 처리기가 끝나 응답을 돌려주기 직전(= updateIndex의 거절 처리까지 끝난 뒤)의 카운터, 그때까지의 화 파일 readFile 수.
//   자기 쓰기 watcher 이벤트는 해시 읽기(readFile)를 한 번 더 하므로, 그 읽기가 끝나 억제된 뒤에도 색인이 복구되지 않았음을 확인한다 (watcher가 대신 복구했다고 오판하지 않는다).
// 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const doc = (id: string, title: string, text: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n${text}\r\n`;
const ONE = doc('one', 'One', 'Alpha originalword');
const TWO = doc('two', 'Two', 'Beta twoword');

const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const searchApi = (page: Page, q: string) =>
  page.evaluate(`window.loreweave.chapters.search(${JSON.stringify(q)}).then((r) => ({ ok: true, total: r.total }), (e) => ({ ok: false, message: e.message }))`) as Promise<
    { ok: true; total: number } | { ok: false; message: string }
  >;
async function searchUiError(page: Page, q: string): Promise<string | null> {
  const box = page.getByRole('search').getByRole('searchbox', { name: '원고 검색' });
  await box.fill(q);
  await box.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.search-summary')?.textContent?.includes('찾는 중'));
  const error = await page.locator('.search p.error').first().textContent({ timeout: 1000 }).catch(() => null);
  await box.press('Escape');
  return error;
}

type G = { armed: boolean; thrown: number; target: string; reads: number; readsAtDone: number; writeDone: number };
/** armed일 때 target(001.md)의 첫 stat 하나에만 EACCES를 던진다. 화 파일 readFile 수와 chapter:write 종료 시점의 값을 센다 */
async function install(app: ElectronApplication, target: string) {
  await app.evaluate(({ ipcMain }, target) => {
    const g = globalThis as unknown as G;
    Object.assign(g, { armed: false, thrown: 0, target, reads: 0, readsAtDone: 0, writeDone: 0 });
    const fsp = process.getBuiltinModule('fs/promises');
    const stat = fsp.stat;
    fsp.stat = (async (path: unknown, ...args: unknown[]) => {
      if (String(path) === g.target && g.armed) {
        g.armed = false; // 이 stat 하나만 실패시킨다
        g.thrown++;
        throw Object.assign(new Error('EACCES: permission denied, stat'), { code: 'EACCES' });
      }
      return (stat as (...a: unknown[]) => Promise<unknown>)(path, ...args);
    }) as typeof fsp.stat;
    const readFile = fsp.readFile;
    fsp.readFile = (async (path: unknown, ...args: unknown[]) => {
      const bytes = await (readFile as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (String(path) === g.target) g.reads++;
      return bytes;
    }) as typeof fsp.readFile;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('chapter:write')!;
    handlers.set('chapter:write', async (...args: unknown[]) => {
      try {
        return await original(...args);
      } finally {
        g.readsAtDone = g.reads; // 쓰기와 색인 갱신(거절 처리 포함)이 끝나 응답을 돌려주기 직전
        g.writeDone++;
      }
    });
  }, target);
}
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).armed = true));
const state = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; return { thrown: g.thrown, reads: g.reads, readsAtDone: g.readsAtDone, writeDone: g.writeDone }; });
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>, app?: ElectronApplication) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, app ? `${what} ${JSON.stringify(await state(app))}` : what);
}
const turn = (app: ElectronApplication) => app.evaluate(() => new Promise<void>((r) => setImmediate(r)));

async function start() {
  const dir = await tempDir('save-index-fail');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const { app, page } = await launch(await tempDir('save-index-fail-userdata'));
  await install(app, join(dir, 'chapters', '001.md'));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await chapter(page, 'One').click();
  await editor(page).getByText('originalword').waitFor();
  await waitUntil(page, '초기 색인이 준비되지 않았다', async () => {
    const r = await searchApi(page, 'originalword');
    return r.ok && r.total === 1;
  });
  return { app, page, dir };
}
const cleanup = async (app: ElectronApplication, page: Page) => {
  // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};
/** 1화 끝에 ' newword'를 넣고 저장한다. inject이면 저장 직후 색인 stat 하나를 EACCES로 실패시킨다. 저장 처리와 자기 쓰기 이벤트의 억제까지 끝난 뒤를 돌려준다 */
async function saveNewword(app: ElectronApplication, page: Page, inject: boolean) {
  await editor(page).getByText('originalword').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' newword');
  if (inject) await arm(app);
  const done = (await state(app)).writeDone;
  await page.keyboard.press('Control+S');
  await waitUntil(page, '저장 처리(쓰기+색인 갱신)가 끝나지 않았다', async () => (await state(app)).writeDone === done + 1, app);
  // 자기 쓰기 이벤트: 해시 읽기가 끝나 억제될 때까지 (저장 처리가 끝난 시점의 readFile 수보다 늘어난 뒤)
  await waitUntil(page, '자기 쓰기 이벤트의 해시 읽기가 끝나지 않았다', async () => {
    const s = await state(app);
    return s.reads > s.readsAtDone;
  }, app);
  await turn(app);
}

test('저장 성공 뒤 색인 갱신만 실패하면, 오래된 색인을 정상 검색 결과로 답하지 않고 오류를 알리며, 저장은 성공으로 남고, 다시 열면 최신 검색이 복구된다', { timeout: 150_000 }, async () => {
  const { app, page, dir } = await start();
  try {
    await saveNewword(app, page, true);
    assert.equal((await state(app)).thrown, 1, '색인 stat 하나에 EACCES가 주입됐다');
    // 저장은 성공이다: 상태 줄은 "저장됨", 디스크는 정확 바이트, 편집 가능
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), doc('one', 'One', 'Alpha originalword newword'));
    assert.equal(await editor(page).getByText('Alpha originalword newword', { exact: true }).count(), 1, '수락한 입력이 화면에 남아야 한다');
    assert.equal(await page.getByRole('alert').count(), 0, '충돌 안내가 없어야 한다');
    // 검색은 오래된 색인(옛 단어 1건, 새 단어 0건)을 정상 결과로 답하면 안 된다
    const api = await searchApi(page, 'newword');
    assert.equal(api.ok, false, '색인 갱신이 실패했는데 검색이 오래된 색인을 정상 결과로 답했다');
    assert.match(api.ok ? '' : api.message, /색인/);
    const uiError = await searchUiError(page, 'originalword');
    assert.ok(uiError && /색인/.test(uiError), `화면에 검색 오류가 보여야 한다: ${uiError}`);
    // 문제 화와 관계없는 다른 화의 성공한 저장은 오류를 지우지 않는다 (폴더를 다시 열 때까지 보수적으로 유지)
    await chapter(page, 'Two').click();
    await editor(page).getByText('twoword').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' second');
    const done = (await state(app)).writeDone;
    await page.keyboard.press('Control+S');
    await waitUntil(page, '2화 저장이 끝나지 않았다', async () => (await state(app)).writeDone === done + 1, app);
    assert.equal((await searchApi(page, 'second')).ok, false, '다른 화의 성공한 갱신이 문제 화의 누락을 복구된 것처럼 지웠다');
    // 같은 폴더를 다시 열면 (주입 없이) 색인이 다시 맞춰져 최신 검색이 복구된다
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await chapter(page, 'One').waitFor();
    await waitUntil(page, '다시 연 뒤 검색이 복구되지 않았다', async () => {
      const r = await searchApi(page, 'newword');
      return r.ok && r.total === 1;
    });
    assert.deepEqual(await searchApi(page, 'originalword'), { ok: true, total: 1 }, '저장 본문(옛 단어 포함)이 최신으로 색인됐다');
    assert.deepEqual(await searchApi(page, 'second'), { ok: true, total: 1 });
  } finally {
    await cleanup(app, page);
  }
});

test('저장 뒤 색인 갱신 실패의 오류는 다른 프로젝트로 퍼지지 않는다', { timeout: 150_000 }, async () => {
  const { app, page } = await start();
  try {
    await saveNewword(app, page, true);
    assert.equal((await searchApi(page, 'newword')).ok, false, '실패한 프로젝트는 검색 오류를 낸다');
    const other = await tempDir('save-index-fail-other');
    await mkdir(join(other, 'chapters'));
    await writeFile(join(other, 'chapters', '001.md'), doc('x1', 'Other One', 'Delta otherword'));
    await stubFolderDialog(app, other);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await chapter(page, 'Other One').waitFor();
    await waitUntil(page, '다른 프로젝트의 검색이 열리지 않았다', async () => {
      const r = await searchApi(page, 'otherword');
      return r.ok && r.total === 1;
    });
  } finally {
    await cleanup(app, page);
  }
});

test('대조: 색인 갱신이 실패하지 않으면 저장한 글자가 바로 검색되고 옛 단어 잔존 없이 정상이다', { timeout: 120_000 }, async () => {
  const { app, page } = await start();
  try {
    await saveNewword(app, page, false);
    assert.deepEqual(await searchApi(page, 'newword'), { ok: true, total: 1 });
    assert.deepEqual(await searchApi(page, 'originalword'), { ok: true, total: 1 }, '옛 단어는 저장 본문에도 있다');
  } finally {
    await cleanup(app, page);
  }
});
