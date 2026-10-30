// 초기 색인 맞춤(syncIndex)이 ENOENT가 아닌 오류(EACCES 등)로 중간에 실패하면, 뒤의 화가 빠진 불완전한 색인이 정상 검색 결과(특히 "없음")로 보이는지 본다.
// (initial-sync-stat-enoent는 ENOENT 건너뛰기다. 여기는 ENOENT가 아닌 오류를 숨기지 않는 쪽이다.)
// 준비: 앱 1에서 001·002·003을 색인하고 닫은 뒤 003을 바깥에서 새 내용으로 바꾼다 (색인은 옛 003). 앱 2(새 userdata)의 초기 맞춤에서 002.md의 첫 stat 하나에만 EACCES를 던진다.
//   화 목록(readFile)이나 다른 화·다른 호출은 건드리지 않는다. 검색은 indexReady(맞춤의 성공/실패 처리)를 기다리므로, 검색 응답이 오면 거절 처리가 끝난 뒤다.
// 관측은 실제 UI(원고 검색 입력)와 IPC 검색으로 한다. 편집·저장은 영향이 없어야 한다. 오류를 없앤 뒤 같은 폴더를 다시 열면 최신 검색이 복구된다.
// 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
const searchApi = (page: Page, q: string) =>
  page.evaluate(`window.loreweave.chapters.search(${JSON.stringify(q)}).then((r) => ({ ok: true, total: r.total }), (e) => ({ ok: false, message: e.message }))`) as Promise<
    { ok: true; total: number } | { ok: false; message: string }
  >;
/** 화면의 원고 검색 입력으로 검색하고, 화면에 보이는 결과(건수 요약 또는 오류 문구)를 돌려준다 */
async function searchUi(page: Page, q: string): Promise<{ error: string | null; hits: number }> {
  const box = page.getByRole('search').getByRole('searchbox', { name: '원고 검색' });
  await box.fill(q);
  await box.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.search-summary')?.textContent?.includes('찾는 중'));
  const error = await page.locator('.search p.error').first().textContent({ timeout: 1000 }).catch(() => null);
  const hits = await page.locator('.search ul li, .search [role="listitem"]').count();
  await box.press('Escape'); // 다음 검색을 위해 비운다
  return { error, hits };
}

type G = { armed: boolean; thrown: number; target: string };
/** armed일 때 target(002.md)의 첫 stat 하나에만 EACCES를 던진다 */
async function install(app: ElectronApplication, target: string) {
  await app.evaluate((_e, target) => {
    const g = globalThis as unknown as G;
    Object.assign(g, { armed: false, thrown: 0, target });
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
  }, target);
}
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).armed = true));
const thrown = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).thrown);
async function waitUntil(what: string, ok: () => Promise<boolean>, page: Page) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, what);
}

/** 앱 1에서 세 화를 색인하고 닫은 뒤 003을 바꾼다. 앱 2를 열고 (inject이면 002의 stat 하나가 EACCES로 실패한 상태로) 폴더가 열린 상태까지 */
async function start(inject: boolean) {
  const dir = await tempDir('sync-eacces');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  await writeFile(join(dir, 'chapters', '003.md'), THREE_OLD);
  const first = await launch(await tempDir('sync-eacces-userdata-1'));
  try {
    await stubFolderDialog(first.app, dir);
    await first.page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await chapter(first.page, 'One').waitFor(); // 폴더가 열린 뒤에야 검색할 수 있다
    await waitUntil('앱 1에서 세 화가 색인되지 않았다', async () => {
      const r = await searchApi(first.page, 'oldthreeword');
      return r.ok && r.total === 1;
    }, first.page);
  } finally {
    await closeWindow(first.app);
  }
  await writeFile(join(dir, 'chapters', '003.md'), THREE_NEW); // 앱이 꺼진 사이 고쳤다 (색인은 옛 본문)
  const { app, page } = await launch(await tempDir('sync-eacces-userdata-2'));
  await install(app, join(dir, 'chapters', '002.md'));
  if (inject) await arm(app);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await chapter(page, 'Three').waitFor();
  return { app, page, dir, userData: undefined as string | undefined };
}
const cleanup = async (app: ElectronApplication, page: Page) => {
  // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};

test('초기 맞춤이 EACCES로 실패하면 불완전한 색인을 "없음"으로 보이지 않고 오류를 알리며, 편집·저장은 유지되고, 오류를 없앤 뒤 다시 열면 최신 검색이 복구된다', { timeout: 150_000 }, async () => {
  const { app, page, dir } = await start(true);
  try {
    // 1) 맞춤의 거절 처리가 끝난 뒤(검색은 indexReady를 기다린다)의 화면 검색: 빠진 003의 새 본문을 정상 "없음"으로 보이면 안 된다
    const api = await searchApi(page, 'newthreeword');
    assert.equal(await thrown(app), 1, 'EACCES가 맞춤의 002 stat 하나에 주입됐다');
    assert.equal(api.ok, false, '불완전한 색인이 정상 검색 결과("없음")로 반환되었다');
    assert.match(api.ok ? '' : api.message, /색인/);
    const ui = await searchUi(page, 'newthreeword');
    assert.ok(ui.error && /색인/.test(ui.error), `화면에 검색 오류가 보여야 한다: ${JSON.stringify(ui)}`);
    // 2) 편집·저장은 영향이 없다 (수락한 입력, 정확 바이트)
    await chapter(page, 'One').click();
    await editor(page).getByText('oneword').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' mine');
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), doc('one', 'One', 'Alpha oneword mine'));
    assert.equal(await readFile(join(dir, 'chapters', '003.md'), 'utf8'), THREE_NEW, '다른 화 원고는 바뀌지 않는다');
    assert.equal(await page.getByRole('alert').count(), 0, '충돌 안내가 없어야 한다');
    // 3) 같은 폴더를 다시 열면 (이번엔 오류 없이) 맞춤이 끝까지 되어 오류가 풀리고 최신 검색이 복구된다
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await chapter(page, 'Three').waitFor();
    await waitUntil('다시 연 뒤 검색이 복구되지 않았다', async () => {
      const r = await searchApi(page, 'newthreeword');
      return r.ok && r.total === 1;
    }, page);
    const back = await searchApi(page, 'mine');
    assert.deepEqual(back, { ok: true, total: 1 }, '저장한 글자도 색인되어 있다');
  } finally {
    await cleanup(app, page);
  }
});

test('초기 맞춤이 EACCES로 실패해도 옛 오류가 다른 프로젝트로 퍼지지 않는다', { timeout: 150_000 }, async () => {
  const { app, page } = await start(true);
  try {
    assert.equal((await searchApi(page, 'newthreeword')).ok, false, '실패한 프로젝트는 검색 오류를 낸다');
    const other = await tempDir('sync-eacces-other');
    await mkdir(join(other, 'chapters'));
    await writeFile(join(other, 'chapters', '001.md'), doc('x1', 'Other One', 'Delta otherword'));
    await stubFolderDialog(app, other);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await chapter(page, 'Other One').waitFor();
    await waitUntil('다른 프로젝트의 검색이 열리지 않았다', async () => {
      const r = await searchApi(page, 'otherword');
      return r.ok && r.total === 1;
    }, page);
  } finally {
    await cleanup(app, page);
  }
});

test('대조: 오류가 없으면 맞춤이 끝까지 되어 최신 검색이 정상이다', { timeout: 120_000 }, async () => {
  const { app, page } = await start(false);
  try {
    await waitUntil('검색이 열리지 않았다', async () => {
      const r = await searchApi(page, 'newthreeword');
      return r.ok && r.total === 1;
    }, page);
    assert.deepEqual(await searchApi(page, 'oldthreeword'), { ok: true, total: 0 });
  } finally {
    await cleanup(app, page);
  }
});
