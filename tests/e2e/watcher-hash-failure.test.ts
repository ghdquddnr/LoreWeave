// 바깥 변경을 감지한 watcher가 화 파일의 해시를 읽다가 ENOENT가 아닌 오류(EACCES 등)로 실패하면, 충돌/불러오기 안내도 색인 갱신도 일어나지 않는다.
// 이때 처리되지 않은 rejection이 남는지, 검색이 오래된 색인을 정상 결과로 답하는지, 수락한 입력과 바깥 바이트·저장의 해시 안전장치가 유지되는지 본다.
// (PR104는 저장 처리의 색인 갱신 실패다. 여기는 그 앞, 알림을 만드는 해시 읽기가 실패하는 경로다.)
// 준비: 초기 맞춤이 정상 완료된 합성 폴더. 바깥에서 001 바이트를 바꾸고, 그 watcher의 해시 읽기(readFile) 정확히 1회만 EACCES로 실패시킨다.
//   list/read/저장/다른 호출은 건드리지 않는다 (무장 뒤 001의 첫 readFile이 그 해시 읽기다). 관측: 주입 횟수, process의 unhandledRejection 수,
//   실패한 읽기의 반환 처리(마이크로태스크)가 끝난 뒤의 main 이벤트 루프 한 번. 최종 검색·화면 안내·디스크 바이트는 UI/IPC로 본다.
// 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

type G = { armed: boolean; thrown: number; target: string; unhandled: number };
async function install(app: ElectronApplication, target: string) {
  await app.evaluate((_e, target) => {
    const g = globalThis as unknown as G;
    Object.assign(g, { armed: false, thrown: 0, unhandled: 0, target });
    process.on('unhandledRejection', () => {
      g.unhandled++;
    });
    const fsp = process.getBuiltinModule('fs/promises');
    const readFile = fsp.readFile;
    fsp.readFile = (async (path: unknown, ...args: unknown[]) => {
      if (String(path) === g.target && g.armed) {
        g.armed = false; // 이 읽기 하나만 실패시킨다
        g.thrown++;
        throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' });
      }
      return (readFile as (...a: unknown[]) => Promise<unknown>)(path, ...args);
    }) as typeof fsp.readFile;
  }, target);
}
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).armed = true));
const state = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; return { thrown: g.thrown, unhandled: g.unhandled }; });
const turn = (app: ElectronApplication) => app.evaluate(() => new Promise<void>((r) => setImmediate(r)));
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, what);
}

async function start() {
  const dir = await tempDir('watcher-hash-fail');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  const path = join(dir, 'chapters', '001.md');
  const { app, page } = await launch(await tempDir('watcher-hash-fail-userdata'));
  await install(app, path);
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
const cleanup = async (app: ElectronApplication, page: Page) => {
  // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};

test('watcher 해시 읽기가 EACCES로 실패하면 처리되지 않은 rejection 없이, 오래된 색인을 정상 검색으로 답하지 않으며, 수락한 입력과 바깥 바이트는 저장의 해시 확인으로 지켜지고, 다시 열면 복구된다', { timeout: 150_000 }, async () => {
  const { app, page, dir, path } = await start();
  try {
    await arm(app);
    await writeFile(path, EXTERNAL);
    await waitUntil(page, 'watcher의 해시 읽기에 EACCES가 주입되지 않았다', async () => (await state(app)).thrown === 1);
    await turn(app); // 실패한 읽기의 반환 처리(마이크로태스크)와 unhandledRejection 통지가 끝난 뒤
    const s = await state(app);
    // 두 문제는 한 번에 모아 보고한다 (하나가 실패해도 다른 하나의 관측이 가려지지 않게)
    const problems: string[] = [];
    if (s.unhandled !== 0) problems.push(`해시 읽기의 실패가 처리되지 않은 rejection으로 남았다 (unhandled=${s.unhandled})`);
    // 검색: 바깥 변경이 색인되지 않았는데 오래된 색인을 정상 결과로 답하면 안 된다
    const api = await searchApi(page, 'externalword');
    if (api.ok) problems.push(`해시 읽기 실패로 바깥 변경이 색인되지 않았는데 검색이 정상 결과로 답했다 (total=${api.total})`);
    else assert.match(api.message, /색인/);
    assert.deepEqual(problems, []);
    // 화면은 바깥 변경을 모르고(알림 없음) 옛 본문이 그대로다. 수락한 입력은 저장의 해시 확인이 지킨다: 자동으로 덮어쓰지 않고 충돌로 알린다
    assert.equal(await editor(page).getByText('Alpha originalword', { exact: true }).count(), 1);
    await editor(page).getByText('originalword').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' mine');
    await page.keyboard.press('Control+S');
    await page.getByRole('alert').getByText(/다른 프로그램에서 바뀌었습니다/).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(path, 'utf8'), EXTERNAL, '바깥 바이트는 덮어쓰이지 않는다');
    assert.equal(await editor(page).getByText('Alpha originalword mine', { exact: true }).count(), 1, '수락한 입력이 화면에 남아야 한다');
    // 같은 폴더를 다시 열면 (주입 없이) 최신 바깥 본문이 색인되고 검색이 복구된다
    await stubFolderDialog(app, dir);
    page.once('dialog', (d) => void d.accept()); // 충돌 중인 미저장 입력을 버리고 다시 연다 (합성 원고)
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await chapter(page, 'One').waitFor();
    await waitUntil(page, '다시 연 뒤 검색이 복구되지 않았다', async () => {
      const r = await searchApi(page, 'externalword');
      return r.ok && r.total === 1;
    });
    assert.equal(await readFile(path, 'utf8'), EXTERNAL);
  } finally {
    await cleanup(app, page);
  }
});

test('watcher 해시 읽기 실패의 오류는 다른 프로젝트로 퍼지지 않는다', { timeout: 150_000 }, async () => {
  const { app, page, path } = await start();
  try {
    await arm(app);
    await writeFile(path, EXTERNAL);
    await waitUntil(page, 'watcher의 해시 읽기에 EACCES가 주입되지 않았다', async () => (await state(app)).thrown === 1);
    await turn(app);
    const other = await tempDir('watcher-hash-fail-other');
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

test('대조: 정상 외부 수정은 깨끗한 에디터가 불러오고 검색에 반영된다', { timeout: 120_000 }, async () => {
  const { app, page, path } = await start();
  try {
    await writeFile(path, EXTERNAL);
    await editor(page).getByText('externalword').waitFor({ timeout: 10_000 });
    await waitUntil(page, '바깥 수정이 색인에 반영되지 않았다', async () => {
      const r = await searchApi(page, 'externalword');
      return r.ok && r.total === 1;
    });
    assert.equal((await state(app)).thrown, 0);
  } finally {
    await cleanup(app, page);
  }
});

test('대조: 바깥 삭제(ENOENT)는 삭제 안내를 띄우고 색인에서 빠진다', { timeout: 120_000 }, async () => {
  const { app, page, path } = await start();
  try {
    await rm(path);
    await page.getByRole('alert').getByText(/지워졌거나 이름이 바뀌었습니다/).waitFor({ timeout: 10_000 });
    await waitUntil(page, '삭제가 색인에 반영되지 않았다', async () => {
      const r = await searchApi(page, 'originalword');
      return r.ok && r.total === 0;
    });
  } finally {
    await cleanup(app, page);
  }
});
