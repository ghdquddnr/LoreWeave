// 폴더 감시를 만드는 fs.watch 자체가 동기 예외(EACCES 등)로 실패하면 watch.ts는 모두 "chapters 폴더가 아직 없다"로 보고 조용히 삼킨다.
// 그러면 감시 없이 열린 채로 이후 바깥 수정을 놓치는데 검색은 오래된 색인을 정상으로 답하는지 본다.
// (watcher-error-close는 실행 중 error 이벤트. 여기는 생성 실패이며, chapters 폴더가 아예 없는 정상 초기 상태(ENOENT)와 구분한다.)
// 합성 예외: 프로젝트를 열기 전에 설치한 fs.watch 감싸기가 chapters 폴더 감시 생성 한 번에만 EACCES를 던진다 (OS가 자연발생시킨 오류가 아니다).
// 관측: 예외를 던진 횟수와 실제로 만들어진 watcher 수. 검색은 indexReady(초기 색인의 성공/실패 처리)를 기다리므로, 응답이 오면 초기 색인이 실제로 끝난 뒤다
//   (openProject의 startWatching→openIndex 순서가 감시 생성 실패 표시를 지우지 않는지도 이 시점의 검색으로 본다).
// 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const doc = (id: string, title: string, text: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n${text}\r\n`;
const ONE = doc('one', 'One', 'Alpha originalword');
const EXTERNAL = doc('one', 'One', 'Alpha externalword');

const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const searchApi = (page: Page, q: string) =>
  page.evaluate(`window.loreweave.chapters.search(${JSON.stringify(q)}).then((r) => ({ ok: true, total: r.total }), (e) => ({ ok: false, message: e.message }))`) as Promise<
    { ok: true; total: number } | { ok: false; message: string }
  >;

type G = { fail: number; thrown: number; created: number };
/** 프로젝트를 열기 전에 설치한다. fail이 0보다 크면 다음 fs.watch(감시 생성) 호출을 EACCES로 던진다. 실제로 만들어진 watcher 수를 센다 */
async function install(app: ElectronApplication) {
  await app.evaluate(() => {
    const g = globalThis as unknown as G;
    Object.assign(g, { fail: 0, thrown: 0, created: 0 });
    const fs = process.getBuiltinModule('fs');
    const watch = fs.watch;
    fs.watch = ((path: string, ...args: unknown[]) => {
      if (g.fail > 0) {
        g.fail--;
        g.thrown++;
        throw Object.assign(new Error('EACCES: permission denied, watch'), { code: 'EACCES' });
      }
      const w = (watch as (...a: unknown[]) => unknown)(path, ...args); // 실제 생성이 던지면(ENOENT) 만들어진 것으로 세지 않는다
      g.created++;
      return w;
    }) as typeof fs.watch;
  });
}
const failNextWatch = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).fail = 1));
const state = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; return { thrown: g.thrown, created: g.created }; });
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, what);
}
const cleanup = async (app: ElectronApplication, page: Page) => {
  // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};

test('감시 생성이 EACCES로 실패하면 감시 없이 열려도 오래된 색인을 정상 검색으로 답하지 않고, 편집·저장·충돌 보호는 유지되며, 오류를 없애고 다시 열면 복구된다', { timeout: 150_000 }, async () => {
  const dir = await tempDir('watcher-create-fail');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir('watcher-create-fail-userdata'));
  try {
    await install(app);
    await failNextWatch(app);
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await chapter(page, 'One').click();
    await editor(page).getByText('originalword').waitFor(); // 읽기는 성공한다
    // 감시 생성이 실제로 1회 실패했고 watcher가 하나도 없다. 검색 응답은 초기 색인이 끝난 뒤에 온다
    const api = await searchApi(page, 'originalword');
    assert.deepEqual(await state(app), { thrown: 1, created: 0 }, '감시 생성만 1회 실패했고 watcher가 만들어지지 않았다');
    assert.equal(api.ok, false, '감시 생성이 실패했는데(이후 바깥 수정을 놓칠 수 있는데) 검색이 정상 결과로 답했다');
    assert.match(api.ok ? '' : api.message, /색인/);
    // 편집·저장은 영향이 없다 (수락한 입력, 정확 바이트)
    await editor(page).getByText('originalword').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' mine');
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(path, 'utf8'), doc('one', 'One', 'Alpha originalword mine'));
    // 감시가 없는 동안의 바깥 수정은 알림이 없지만 저장의 해시 확인(expectedHash)이 지킨다: 덮어쓰지 않고 충돌로 알린다
    await writeFile(path, EXTERNAL);
    await page.keyboard.type(' more');
    await page.keyboard.press('Control+S');
    await page.getByRole('alert').getByText(/다른 프로그램에서 바뀌었습니다/).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(path, 'utf8'), EXTERNAL, '바깥 바이트는 덮어쓰이지 않는다');
    assert.equal(await editor(page).getByText('Alpha originalword mine more', { exact: true }).count(), 1, '수락한 입력이 화면에 남아야 한다');
    // 오류를 없애고(주입 없음) 같은 폴더를 다시 열면 감시가 만들어지고 색인이 맞춰져 검색이 복구된다
    await stubFolderDialog(app, dir);
    page.once('dialog', (d) => void d.accept()); // 충돌 중인 미저장 입력을 버리고 다시 연다 (합성 원고)
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await chapter(page, 'One').waitFor();
    await waitUntil(page, '다시 연 뒤 검색이 복구되지 않았다', async () => {
      const r = await searchApi(page, 'externalword');
      return r.ok && r.total === 1;
    });
    assert.deepEqual(await state(app), { thrown: 1, created: 1 }, '다시 열 때 watcher가 만들어졌다');
  } finally {
    await cleanup(app, page);
  }
});

test('감시 생성 실패의 오류는 다른 프로젝트로 퍼지지 않는다', { timeout: 150_000 }, async () => {
  const dir = await tempDir('watcher-create-fail');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  const { app, page } = await launch(await tempDir('watcher-create-fail-userdata'));
  try {
    await install(app);
    await failNextWatch(app);
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await chapter(page, 'One').waitFor();
    assert.equal((await searchApi(page, 'originalword')).ok, false, '실패한 프로젝트는 검색 오류를 낸다');
    const other = await tempDir('watcher-create-fail-other');
    await mkdir(join(other, 'chapters'));
    await writeFile(join(other, 'chapters', '001.md'), doc('x1', 'Other One', 'Delta otherword'));
    await stubFolderDialog(app, other);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await chapter(page, 'Other One').waitFor();
    await waitUntil(page, '다른 프로젝트의 검색이 열리지 않았다', async () => {
      const r = await searchApi(page, 'otherword');
      return r.ok && r.total === 1;
    });
    assert.deepEqual(await state(app), { thrown: 1, created: 1 }, '다른 프로젝트의 감시는 정상 생성됐다');
  } finally {
    await cleanup(app, page);
  }
});

test('새 화 생성으로 감시를 다시 만들 때의 생성 실패도 검색을 정상으로 답하지 않게 하고, 새 화 입력·저장은 유지된다', { timeout: 150_000 }, async () => {
  const dir = await tempDir('watcher-create-fail');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  const { app, page } = await launch(await tempDir('watcher-create-fail-userdata'));
  try {
    await install(app);
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await chapter(page, 'One').waitFor();
    await waitUntil(page, '처음 색인이 준비되지 않았다', async () => {
      const r = await searchApi(page, 'originalword');
      return r.ok && r.total === 1;
    });
    assert.deepEqual(await state(app), { thrown: 0, created: 1 });
    await failNextWatch(app); // 새 화 생성이 시작하는 감시 재생성 한 번이 실패한다
    await page.getByRole('button', { name: '+ 새 화', exact: true }).click();
    await editor(page).waitFor();
    await waitUntil(page, '감시 재생성의 실패가 일어나지 않았다', async () => (await state(app)).thrown === 1);
    assert.equal((await state(app)).created, 1, '교체 감시는 만들어지지 않았다');
    const api = await searchApi(page, 'originalword');
    assert.equal(api.ok, false, '감시 재생성이 실패했는데 검색이 정상 결과로 답했다');
    await editor(page).click();
    await page.keyboard.type('freshword');
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
  } finally {
    await cleanup(app, page);
  }
});

test('대조: chapters 폴더가 아예 없는 정상 초기 상태(ENOENT)는 감시 생성 실패로 보지 않고, 새 화 뒤 검색이 정상이다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('watcher-create-empty'); // chapters 폴더 없음
  const { app, page } = await launch(await tempDir('watcher-create-empty-userdata'));
  try {
    await install(app);
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.getByRole('button', { name: '+ 새 화', exact: true }).waitFor();
    // 실제 fs.watch가 ENOENT로 실패했다 (주입 없음): 그 뒤에도 검색은 거절되지 않는다
    assert.deepEqual(await searchApi(page, 'anything'), { ok: true, total: 0 });
    await page.getByRole('button', { name: '+ 새 화', exact: true }).click();
    await editor(page).click();
    await page.keyboard.type('freshword');
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    await waitUntil(page, '새 화의 글자가 색인에 반영되지 않았다', async () => {
      const r = await searchApi(page, 'freshword');
      return r.ok && r.total === 1;
    });
    assert.equal((await state(app)).created, 1, '새 화를 만든 뒤 감시가 만들어졌다');
  } finally {
    await cleanup(app, page);
  }
});

test('대조: 정상 감시 생성이면 검색이 정상이다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('watcher-create-fail');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  const { app, page } = await launch(await tempDir('watcher-create-fail-userdata'));
  try {
    await install(app);
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await chapter(page, 'One').waitFor();
    await waitUntil(page, '검색이 열리지 않았다', async () => {
      const r = await searchApi(page, 'originalword');
      return r.ok && r.total === 1;
    });
    assert.deepEqual(await state(app), { thrown: 0, created: 1 });
  } finally {
    await cleanup(app, page);
  }
});
