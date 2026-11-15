// 검색 IPC(chapters:search)의 프로젝트 소유권: A의 초기 색인을 기다리는 검색이 B(또는 같은 A를 다시 연 새 프로젝트)의 색인을 검색하거나 새 프로젝트의 오류를 받지 않는지 본다.
// 장벽: 프로젝트의 002.md 초기 색인 맞춤 stat 반환을 붙잡아(initial-sync-lifetime과 같은 방식) 검색 요청이 indexReady를 기다리게 한다. 검색은 실제 등록된 main handler가 처리한다 (handler 대역 없음, 도착만 센다).
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. 같은 파일 이름에 서로 다른 단어를 써서 어느 색인이 검색됐는지 구분한다. 실제 API·실원고는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, currentTokenFn, launch, searchExpr, stubFolderDialog, tempDir } from './launch.ts';

const STALE = /원고 폴더가 바뀌어/;
const doc = (id: string, title: string, text: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n${text}\r\n`;
async function project(prefix: string, files: Record<string, string>): Promise<string> {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  for (const [f, text] of Object.entries(files)) await writeFile(join(dir, 'chapters', f), text);
  return dir;
}
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });

type G = { path: string; armed: boolean; held: boolean; release?: () => void; entered: number };
async function install(app: ElectronApplication, holdPath: string) {
  await app.evaluate(({ ipcMain }, holdPath) => {
    const g = globalThis as unknown as G;
    g.path = holdPath as string;
    g.armed = false;
    g.held = false;
    g.entered = 0;
    const fsp = process.getBuiltinModule('fs/promises');
    const stat = fsp.stat;
    fsp.stat = (async (path: unknown, ...args: unknown[]) => {
      const hold = g.armed && String(path) === g.path;
      if (hold) g.armed = false; // 이 stat 하나만 붙잡는다
      const info = await (stat as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (hold) {
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        g.held = false;
      }
      return info;
    }) as typeof fsp.stat;
    // 실제 handler를 그대로 부르고 도착만 센다
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('chapters:search')!;
    handlers.set('chapters:search', async (...args: unknown[]) => {
      g.entered++;
      return original(...args);
    });
  }, holdPath);
}
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).armed = true));
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());
const st = (app: ElectronApplication) => app.evaluate(() => ({ held: (globalThis as unknown as G).held, entered: (globalThis as unknown as G).entered }));
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, what);
}

type Outcome = { ok: true; total: number } | { ok: false; message: string };
/** 검색을 시작해 두고(기다리지 않는다) 나중에 결과를 읽는다. token을 생략하면 지금 열린 프로젝트의 token을 쓴다 */
const startSearch = (page: Page, q: string, slot: string, token?: number) =>
  page.evaluate(
    `(async () => { const t = ${token ?? 'await (' + currentTokenFn + ')()'}; window.${slot} = null;
       window.loreweave.chapters.search(${JSON.stringify(q)}, t).then((r) => (window.${slot} = { ok: true, total: r.total }), (e) => (window.${slot} = { ok: false, message: String(e && e.message) })); return t; })()`,
  ) as Promise<number>;
const outcome = (page: Page, slot: string) => page.evaluate(`window.${slot}`) as Promise<Outcome | null>;
const settled = async (page: Page, slot: string): Promise<Outcome> => {
  await waitUntil(page, `${slot} 검색이 끝나지 않았다`, async () => (await outcome(page, slot)) !== null);
  return (await outcome(page, slot))!;
};
const total = (page: Page, q: string) => page.evaluate(`${searchExpr(JSON.stringify(q))}.then((r) => r.total)`) as Promise<number>;

async function setup() {
  const A = await project('stok-A', { '001.md': doc('a1', 'A One', 'alpha one'), '002.md': doc('a2', 'A Two', 'alphaword') });
  const B = await project('stok-B', { '001.md': doc('b1', 'B One', 'beta one'), '002.md': doc('b2', 'B Two', 'betaword') });
  const { app, page } = await launch(await tempDir('stok-userdata'));
  await install(app, join(A, 'chapters', '002.md'));
  return { A, B, app, page };
}
async function openA(app: ElectronApplication, page: Page, A: string) {
  await arm(app);
  await stubFolderDialog(app, A);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await waitUntil(page, 'A의 초기 맞춤을 붙잡지 못했다', async () => (await st(app)).held);
  await chapter(page, 'A One').waitFor();
}
const reopen = async (app: ElectronApplication, page: Page, dir: string, title: string) => {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '열기', exact: true }).click();
  await chapter(page, title).waitFor();
};
const cleanup = async (app: ElectronApplication, page: Page) => {
  await release(app).catch(() => {});
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};

test('A의 초기 색인을 기다리는 검색은 B를 열면 B의 색인을 검색하지 않고 STALE_PROJECT로 끝난다', { timeout: 120_000 }, async () => {
  const { A, B, app, page } = await setup();
  try {
    await openA(app, page, A);
    const tokenA = await startSearch(page, 'betaword', 'rA'); // B에만 있는 단어를 A의 검색으로 보낸다
    await waitUntil(page, '검색이 main handler에 도착하지 않았다', async () => (await st(app)).entered >= 1);
    await reopen(app, page, B, 'B Two');
    assert.equal(await total(page, 'betaword'), 1, 'B가 열렸고 B의 색인은 B 단어를 찾는다');
    await release(app); // 붙잡힌 A의 초기 맞춤을 푼다
    const r = await settled(page, 'rA');
    assert.equal(r.ok, false, `옛 검색이 새 프로젝트의 색인을 검색했다: ${JSON.stringify(r)} (tokenA=${tokenA})`);
    assert.match((r as { message: string }).message, STALE);
    assert.equal(await readFile(join(B, 'chapters', '002.md'), 'utf8'), doc('b2', 'B Two', 'betaword'), '원고 바이트는 그대로다');
    assert.equal(await readFile(join(A, 'chapters', '002.md'), 'utf8'), doc('a2', 'A Two', 'alphaword'));
  } finally {
    await cleanup(app, page);
  }
});

test('A의 초기 색인을 기다리는 검색은 같은 A를 다시 열면 새 열기의 색인을 검색하지 않고 STALE_PROJECT로 끝난다', { timeout: 120_000 }, async () => {
  const { A, app, page } = await setup();
  try {
    await openA(app, page, A);
    await startSearch(page, 'alphaword', 'rA');
    await waitUntil(page, '검색이 main handler에 도착하지 않았다', async () => (await st(app)).entered >= 1);
    await reopen(app, page, A, 'A Two');
    assert.equal(await total(page, 'alphaword'), 1, '다시 연 A의 색인은 정상이다');
    await release(app);
    const r = await settled(page, 'rA');
    assert.equal(r.ok, false, `옛 열기의 검색이 새 열기의 색인으로 답했다: ${JSON.stringify(r)}`);
    assert.match((r as { message: string }).message, STALE);
  } finally {
    await cleanup(app, page);
  }
});

test('정상: 같은 프로젝트의 검색은 그 프로젝트의 초기 색인이 끝나기를 기다린 뒤 결과를 돌려준다', { timeout: 120_000 }, async () => {
  const { A, app, page } = await setup();
  try {
    await openA(app, page, A);
    await startSearch(page, 'alphaword', 'rA');
    await waitUntil(page, '검색이 main handler에 도착하지 않았다', async () => (await st(app)).entered >= 1);
    assert.equal(await outcome(page, 'rA'), null, '초기 색인이 끝나기 전에는 답하지 않는다');
    await release(app);
    assert.deepEqual(await settled(page, 'rA'), { ok: true, total: 1 });
  } finally {
    await cleanup(app, page);
  }
});

test('token이 없거나 옛 token인 검색 요청은 지금 열린 프로젝트의 검색으로 처리하지 않는다', { timeout: 120_000 }, async () => {
  const { A, app, page } = await setup();
  try {
    await openA(app, page, A);
    await release(app);
    await waitUntil(page, 'A의 색인이 준비되지 않았다', async () => (await total(page, 'alphaword').catch(() => 0)) === 1);
    for (const [slot, token] of [['rOld', 9999], ['rNone', 'undefined']] as const) {
      await startSearch(page, 'alphaword', slot, token as number);
      const r = await settled(page, slot);
      assert.equal(r.ok, false, `${slot}: ${JSON.stringify(r)}`);
      assert.match((r as { message: string }).message, STALE);
    }
  } finally {
    await cleanup(app, page);
  }
});
