// 실행 중인 폴더 감시(FSWatcher)에 오류가 나면 watch.ts는 감시를 닫기만 한다. 그 뒤의 바깥 수정은 알림도 색인도 되지 않는데 검색은 오래된 색인을 정상으로 답하는지 본다.
// (watcher-hash-failure는 해시 읽기 실패, 여기는 감시 자체의 중단이다.)
// 오류는 합성이다: main이 실제로 등록한 FSWatcher 객체를 fs.watch 반환값에서 잡아 두었다가 그 객체에 error를 emit한다 (OS가 자연발생시킨 오류가 아니다).
//   watcher의 close를 감싸 호출 횟수를 센다 → emit이 돌아온 시점에 error 처리기와 close가 실행됐음을 본다. 감시가 닫히면 이후 콜백은 없다(Node의 close 의미).
//   main이 창으로 보내는 chapter:changed-outside 메시지도 센다 (바깥 수정 알림이 없음을 확인).
// 정상 초기 상태(chapters 폴더가 아직 없어 watch 생성이 실패하는 경우)와 섞지 않는다: 그 경우는 별도 대조 테스트다.
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

type G = { watchers: Array<{ path: string; w: { emit: (event: string, ...a: unknown[]) => boolean } }>; closes: number[]; sent: number };
/** 프로젝트를 열기 전에 설치한다 (fs.watch는 열 때 만들어진다). 만들어진 watcher를 순서대로 잡고, 각 close 호출 수를 센다 */
async function install(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as G;
    g.watchers = [];
    g.closes = [];
    g.sent = 0;
    const fs = process.getBuiltinModule('fs');
    const watch = fs.watch;
    fs.watch = ((path: string, ...args: unknown[]) => {
      const w = (watch as (...a: unknown[]) => { close: () => void; emit: (event: string, ...a: unknown[]) => boolean })(path, ...args);
      const index = g.watchers.length;
      // 이 함수는 앱 안에서 실행된다: 객체 속성에 화살표 함수를 두지 않는다 (테스트 변환기의 이름 도우미가 앱에 없어, 있으면 감싼 fs.watch가 던져 감시가 관리되지 않는 채 남는다)
      g.watchers.push({ path: String(path), w });
      g.closes.push(0);
      const close = w.close.bind(w);
      w.close = () => {
        g.closes[index] = (g.closes[index] ?? 0) + 1;
        close();
      };
      return w;
    }) as typeof fs.watch;
    const wc = BrowserWindow.getAllWindows()[0]!.webContents;
    const send = wc.send.bind(wc);
    wc.send = ((channel: string, ...args: unknown[]) => {
      if (channel === 'chapter:changed-outside') g.sent++;
      return send(channel, ...args);
    }) as typeof wc.send;
  });
}
const state = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; return { watchers: g.watchers.length, closes: [...g.closes], sent: g.sent }; });
/** index번째 watcher에 error를 emit한다. emit이 돌아오면 등록된 error 처리기는 모두 실행된 뒤다 (처리기가 던지면 여기서 던져진다) */
const emitError = (app: ElectronApplication, index: number) =>
  app.evaluate((_e, index) => {
    const g = globalThis as unknown as G;
    return g.watchers[index]!.w.emit('error', Object.assign(new Error('EPERM: synthetic watcher error'), { code: 'EPERM' }));
  }, index);
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, what);
}
const cleanup = async (app: ElectronApplication, page: Page) => {
  // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};

async function start() {
  const dir = await tempDir('watcher-error');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir('watcher-error-userdata'));
  await install(app);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await chapter(page, 'One').click();
  await editor(page).getByText('originalword').waitFor();
  await waitUntil(page, '초기 색인이 준비되지 않았다', async () => {
    const r = await searchApi(page, 'originalword');
    return r.ok && r.total === 1;
  });
  return { app, page, dir, path };
}

test('실행 중 감시 오류로 감시가 닫히면, 이후 바깥 수정을 알리지 못한 채 오래된 색인을 정상 검색으로 답하지 않고, 입력·바이트는 보존되며, 다시 열면 복구된다', { timeout: 150_000 }, async () => {
  const { app, page, dir, path } = await start();
  try {
    const before = await state(app);
    assert.equal(before.watchers, 1, '프로젝트의 watcher가 하나 등록됐다');
    assert.deepEqual(before.closes, [0]);
    // 1) 합성 오류를 emit한다: error 처리기가 실행되어 감시를 닫았다 (close 호출 1회)
    assert.equal(await emitError(app, 0), true, 'error 처리기가 등록돼 있다');
    assert.deepEqual((await state(app)).closes, [1], '감시 오류로 close가 호출됐다');
    // 2) 감시가 닫힌 뒤의 바깥 수정: 알림(메시지)도 색인도 없다. 검색이 그 사실을 알려야 한다
    await writeFile(path, EXTERNAL);
    const api = await searchApi(page, 'externalword');
    assert.equal((await state(app)).sent, 0, '닫힌 감시는 바깥 수정을 알리지 못한다');
    assert.equal(api.ok, false, `감시가 중단됐는데 검색이 오래된 색인을 정상 결과로 답했다 (total=${api.ok ? api.total : '-'})`);
    assert.match(api.ok ? '' : api.message, /색인/);
    // 3) 수락한 입력은 저장의 해시 확인(expectedHash)이 지킨다: 덮어쓰지 않고 충돌로 알린다. 바깥 바이트는 그대로
    await editor(page).getByText('originalword').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' mine');
    await page.keyboard.press('Control+S');
    await page.getByRole('alert').getByText(/다른 프로그램에서 바뀌었습니다/).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(path, 'utf8'), EXTERNAL, '바깥 바이트는 덮어쓰이지 않는다');
    assert.equal(await editor(page).getByText('Alpha originalword mine', { exact: true }).count(), 1, '수락한 입력이 화면에 남아야 한다');
    // 4) 같은 폴더를 다시 열면 새 watcher가 만들어지고 색인이 다시 맞춰져 검색이 복구된다
    await stubFolderDialog(app, dir);
    page.once('dialog', (d) => void d.accept()); // 충돌 중인 미저장 입력을 버리고 다시 연다 (합성 원고)
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await chapter(page, 'One').waitFor();
    await waitUntil(page, '다시 연 뒤 검색이 복구되지 않았다', async () => {
      const r = await searchApi(page, 'externalword');
      return r.ok && r.total === 1;
    });
    assert.equal((await state(app)).watchers, 2, '다시 열 때 새 watcher가 만들어졌다');
    assert.equal(await readFile(path, 'utf8'), EXTERNAL);
  } finally {
    await cleanup(app, page);
  }
});

test('이전 프로젝트 watcher의 늦은 오류는 새 프로젝트로 퍼지지 않는다', { timeout: 150_000 }, async () => {
  const { app, page } = await start();
  try {
    const other = await tempDir('watcher-error-other');
    await mkdir(join(other, 'chapters'));
    await writeFile(join(other, 'chapters', '001.md'), doc('x1', 'Other One', 'Delta otherword'));
    await stubFolderDialog(app, other);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await chapter(page, 'Other One').waitFor();
    await waitUntil(page, '다른 프로젝트의 검색이 열리지 않았다', async () => {
      const r = await searchApi(page, 'otherword');
      return r.ok && r.total === 1;
    });
    assert.equal((await state(app)).watchers, 2);
    assert.deepEqual((await state(app)).closes, [1, 0], '이전 프로젝트의 감시는 열 때 이미 닫혔다');
    // 이미 닫힌 이전 프로젝트의 watcher에 늦은 오류가 온다
    await emitError(app, 0);
    assert.deepEqual((await searchApi(page, 'otherword')), { ok: true, total: 1 }, '이전 프로젝트의 늦은 오류가 새 프로젝트의 검색을 막았다');
    assert.deepEqual((await state(app)).closes, [2, 0], '새 프로젝트의 감시는 영향받지 않는다');
  } finally {
    await cleanup(app, page);
  }
});

test('대조: 정상 감시는 바깥 수정을 알리고 색인한다', { timeout: 120_000 }, async () => {
  const { app, page, path } = await start();
  try {
    await writeFile(path, EXTERNAL);
    await editor(page).getByText('externalword').waitFor({ timeout: 10_000 });
    await waitUntil(page, '바깥 수정이 색인에 반영되지 않았다', async () => {
      const r = await searchApi(page, 'externalword');
      return r.ok && r.total === 1;
    });
    assert.ok((await state(app)).sent >= 1);
  } finally {
    await cleanup(app, page);
  }
});

test('대조: chapters 폴더가 아직 없는 정상 초기 상태에서는 watch 생성 실패가 오류가 아니고, 새 화를 만들면 감시가 시작되며 검색이 정상이다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('watcher-error-empty'); // chapters 폴더 없음
  const { app, page } = await launch(await tempDir('watcher-error-empty-userdata'));
  try {
    await install(app);
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.getByRole('button', { name: '+ 새 화', exact: true }).waitFor();
    assert.equal((await state(app)).watchers, 0, 'chapters 폴더가 없어 watch가 만들어지지 않았다');
    await page.getByRole('button', { name: '+ 새 화', exact: true }).click();
    await editor(page).waitFor();
    await waitUntil(page, '새 화를 만든 뒤 감시가 시작되지 않았다', async () => (await state(app)).watchers === 1);
    await editor(page).click();
    await page.keyboard.type('freshword');
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    await waitUntil(page, '새 화의 글자가 색인에 반영되지 않았다', async () => {
      const r = await searchApi(page, 'freshword');
      return r.ok && r.total === 1;
    });
  } finally {
    await cleanup(app, page);
  }
});
